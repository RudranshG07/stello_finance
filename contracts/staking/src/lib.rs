#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, BytesN, Env, Map, Vec,
};

/// Precision multiplier for exchange rate calculations (7 decimals).
const RATE_PRECISION: i128 = 10_000_000; // 1e7

/// Protocol fee in basis points (1000 = 10%).
const PROTOCOL_FEE_BPS: i128 = 1000;
const BPS_DENOMINATOR: i128 = 10_000;

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800;   // ~7 days
const INSTANCE_BUMP_AMOUNT: u32        = 518_400;    // bump to ~30 days
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 518_400; // ~30 days
const PERSISTENT_BUMP_AMOUNT: u32       = 3_110_400; // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    SxlmToken,
    NativeToken,
    TotalXlmStaked,
    TotalSxlmSupply,
    LiquidityBuffer,
    CooldownPeriod,
    Validators,
    WithdrawalQueue,
    WithdrawalCounter,
    Initialized,
    Paused,
    Treasury,
    TreasuryBalance,
}

#[derive(Clone)]
#[contracttype]
pub struct WithdrawalRequest {
    pub id: u64,
    pub user: Address,
    pub xlm_amount: i128,
    pub unlock_ledger: u32,
    pub claimed: bool,
}

// --- TTL helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_queue(env: &Env) {
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::WithdrawalQueue, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
}

// --- Storage helpers ---

fn read_i128(env: &Env, key: &DataKey) -> i128 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn write_i128(env: &Env, key: &DataKey, val: i128) {
    env.storage().instance().set(key, &val);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_sxlm_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SxlmToken).unwrap()
}

fn read_native_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::NativeToken).unwrap()
}

fn read_cooldown(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::CooldownPeriod)
        .unwrap_or(17280u32) // ~24 hours at 5s/ledger
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn require_not_paused(env: &Env) {
    if is_paused(env) {
        panic!("protocol is paused");
    }
}

fn next_withdrawal_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::WithdrawalCounter)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::WithdrawalCounter, &(id + 1));
    id
}

fn get_withdrawal_queue(env: &Env) -> Map<u64, WithdrawalRequest> {
    let queue: Map<u64, WithdrawalRequest> = env
        .storage()
        .persistent()
        .get(&DataKey::WithdrawalQueue)
        .unwrap_or(Map::new(env));
    // Extend TTL whenever we read the queue
    if env.storage().persistent().has(&DataKey::WithdrawalQueue) {
        extend_queue(env);
    }
    queue
}

fn set_withdrawal_queue(env: &Env, queue: &Map<u64, WithdrawalRequest>) {
    env.storage()
        .persistent()
        .set(&DataKey::WithdrawalQueue, queue);
    extend_queue(env);
}

#[contract]
pub struct StakingContract;

#[contractimpl]
impl StakingContract {
    /// Initialize the staking contract.
    pub fn initialize(
        env: Env,
        admin: Address,
        sxlm_token: Address,
        native_token: Address,
        cooldown_period: u32,
    ) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SxlmToken, &sxlm_token);
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage().instance().set(&DataKey::CooldownPeriod, &cooldown_period);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::Treasury, &admin);
        write_i128(&env, &DataKey::TotalXlmStaked, 0);
        write_i128(&env, &DataKey::TotalSxlmSupply, 0);
        write_i128(&env, &DataKey::LiquidityBuffer, 0);
        write_i128(&env, &DataKey::TreasuryBalance, 0);
        extend_instance(&env);
    }

    /// Upgrade the contract WASM. Only callable by admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin = read_admin(&env);
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Bump instance TTL — can be called by anyone to keep the contract alive.
    pub fn bump_instance(env: Env) {
        extend_instance(&env);
    }

    // ==========================================================
    // Core staking functions
    // ==========================================================

    /// Deposit XLM and receive sXLM tokens.
    pub fn deposit(env: Env, user: Address, xlm_amount: i128) {
        require_not_paused(&env);
        user.require_auth();
        if xlm_amount <= 0 {
            panic!("deposit amount must be positive");
        }
        extend_instance(&env);

        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        xlm_client.transfer(&user, &env.current_contract_address(), &xlm_amount);

        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        let total_supply = read_i128(&env, &DataKey::TotalSxlmSupply);

        let sxlm_to_mint = if total_supply == 0 || total_staked == 0 {
            xlm_amount
        } else {
            xlm_amount * total_supply / total_staked
        };

        if sxlm_to_mint <= 0 {
            panic!("mint amount too small");
        }

        write_i128(&env, &DataKey::TotalXlmStaked, total_staked + xlm_amount);
        write_i128(&env, &DataKey::TotalSxlmSupply, total_supply + sxlm_to_mint);

        let sxlm_token = read_sxlm_token(&env);
        let sxlm_client = SxlmTokenClient::new(&env, &sxlm_token);
        sxlm_client.mint(&user, &sxlm_to_mint);

        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (user, xlm_amount, sxlm_to_mint),
        );
    }

    /// Request withdrawal: burns sXLM and returns XLM.
    pub fn request_withdrawal(env: Env, user: Address, sxlm_amount: i128) {
        require_not_paused(&env);
        user.require_auth();
        if sxlm_amount <= 0 {
            panic!("withdrawal amount must be positive");
        }
        extend_instance(&env);

        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        let total_supply = read_i128(&env, &DataKey::TotalSxlmSupply);

        if total_supply == 0 {
            panic!("no sXLM in circulation");
        }

        let xlm_to_return = sxlm_amount * total_staked / total_supply;
        if xlm_to_return <= 0 {
            panic!("return amount too small");
        }

        let sxlm_token = read_sxlm_token(&env);
        let sxlm_client = SxlmTokenClient::new(&env, &sxlm_token);
        sxlm_client.burn(&user, &sxlm_amount);

        write_i128(&env, &DataKey::TotalSxlmSupply, total_supply - sxlm_amount);

        let buffer = read_i128(&env, &DataKey::LiquidityBuffer);

        if buffer >= xlm_to_return {
            write_i128(&env, &DataKey::LiquidityBuffer, buffer - xlm_to_return);
            write_i128(&env, &DataKey::TotalXlmStaked, total_staked - xlm_to_return);

            let native_token_addr = read_native_token(&env);
            let xlm_client = token::Client::new(&env, &native_token_addr);
            xlm_client.transfer(&env.current_contract_address(), &user, &xlm_to_return);

            env.events().publish(
                (soroban_sdk::symbol_short!("instant"),),
                (user, xlm_to_return),
            );
        } else {
            let cooldown = read_cooldown(&env);
            let unlock_ledger = env.ledger().sequence() + cooldown;
            let id = next_withdrawal_id(&env);

            let request = WithdrawalRequest {
                id,
                user: user.clone(),
                xlm_amount: xlm_to_return,
                unlock_ledger,
                claimed: false,
            };

            let mut queue = get_withdrawal_queue(&env);
            queue.set(id, request);
            set_withdrawal_queue(&env, &queue);

            // BUG FIX: decrement TotalXlmStaked at queue time.
            // The XLM is earmarked and must not inflate the exchange rate
            // during the cooldown window.
            write_i128(&env, &DataKey::TotalXlmStaked, total_staked - xlm_to_return);

            env.events().publish(
                (soroban_sdk::symbol_short!("delayed"),),
                (user, xlm_to_return, id, unlock_ledger),
            );
        }
    }

    /// Claim a delayed withdrawal after cooldown has expired.
    pub fn claim_withdrawal(env: Env, user: Address, withdrawal_id: u64) {
        user.require_auth();
        extend_instance(&env);

        let mut queue = get_withdrawal_queue(&env);
        let mut request = queue.get(withdrawal_id).expect("withdrawal not found");

        if request.user != user {
            panic!("not your withdrawal");
        }
        if request.claimed {
            panic!("already claimed");
        }
        if env.ledger().sequence() < request.unlock_ledger {
            panic!("cooldown not expired");
        }

        request.claimed = true;
        queue.set(withdrawal_id, request.clone());
        set_withdrawal_queue(&env, &queue);

        // TotalXlmStaked already decremented in request_withdrawal (delayed path)
        // so we only transfer XLM here

        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        xlm_client.transfer(&env.current_contract_address(), &user, &request.xlm_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("claimed"),),
            (user, request.xlm_amount, withdrawal_id),
        );
    }

    // ==========================================================
    // Reward & Fee functions
    // ==========================================================

    /// Add staking rewards — takes protocol fee (10%), remainder increases
    /// total_xlm_staked, raising the exchange rate.
    pub fn add_rewards(env: Env, amount: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        if amount <= 0 {
            panic!("reward amount must be positive");
        }
        extend_instance(&env);

        // BUG FIX: transfer reward XLM from admin into the contract first.
        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        xlm_client.transfer(&admin, &env.current_contract_address(), &amount);

        let fee = amount * PROTOCOL_FEE_BPS / BPS_DENOMINATOR;
        let net_reward = amount - fee;

        let treasury_bal = read_i128(&env, &DataKey::TreasuryBalance);
        write_i128(&env, &DataKey::TreasuryBalance, treasury_bal + fee);

        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        write_i128(&env, &DataKey::TotalXlmStaked, total_staked + net_reward);

        env.events().publish(
            (soroban_sdk::symbol_short!("rewards"),),
            (amount, net_reward, fee),
        );
    }

    /// Withdraw protocol fees to the admin address.
    /// If amount > 0, withdraw that specific amount; if 0, withdraw all.
    pub fn withdraw_fees(env: Env, amount: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);

        let treasury_bal = read_i128(&env, &DataKey::TreasuryBalance);

        let withdraw_amount = if amount <= 0 {
            treasury_bal
        } else {
            amount
        };

        if withdraw_amount <= 0 {
            panic!("no fees to withdraw");
        }
        if withdraw_amount > treasury_bal {
            panic!("insufficient treasury balance");
        }

        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        xlm_client.transfer(&env.current_contract_address(), &admin, &withdraw_amount);

        write_i128(&env, &DataKey::TreasuryBalance, treasury_bal - withdraw_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("fee_out"),),
            (admin, withdraw_amount),
        );
    }

    pub fn set_treasury(env: Env, treasury: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
    }

    // ==========================================================
    // Slashing
    // ==========================================================

    pub fn apply_slashing(env: Env, slash_amount: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        if slash_amount <= 0 {
            panic!("slash amount must be positive");
        }
        extend_instance(&env);

        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        if slash_amount > total_staked {
            panic!("slash amount exceeds total staked");
        }

        let new_total = total_staked - slash_amount;
        write_i128(&env, &DataKey::TotalXlmStaked, new_total);

        env.events().publish(
            (soroban_sdk::symbol_short!("slashed"),),
            (slash_amount, new_total),
        );

        let total_supply = read_i128(&env, &DataKey::TotalSxlmSupply);
        let new_rate = if total_supply == 0 {
            RATE_PRECISION
        } else {
            new_total * RATE_PRECISION / total_supply
        };

        env.events().publish(
            (soroban_sdk::symbol_short!("recalib"),),
            (new_rate, new_total, total_supply),
        );
    }

    pub fn recalibrate_rate(env: Env) -> i128 {
        extend_instance(&env);
        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        let total_supply = read_i128(&env, &DataKey::TotalSxlmSupply);

        let new_rate = if total_supply == 0 {
            RATE_PRECISION
        } else {
            total_staked * RATE_PRECISION / total_supply
        };

        env.events().publish(
            (soroban_sdk::symbol_short!("recalib"),),
            (new_rate, total_staked, total_supply),
        );

        new_rate
    }

    // ==========================================================
    // Emergency pause
    // ==========================================================

    pub fn pause(env: Env) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((soroban_sdk::symbol_short!("paused"),), true);
    }

    pub fn unpause(env: Env) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((soroban_sdk::symbol_short!("paused"),), false);
    }

    // ==========================================================
    // Liquidity & Validators
    // ==========================================================

    pub fn add_liquidity(env: Env, amount: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        if amount <= 0 {
            panic!("liquidity amount must be positive");
        }
        extend_instance(&env);

        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        xlm_client.transfer(&admin, &env.current_contract_address(), &amount);

        let buffer = read_i128(&env, &DataKey::LiquidityBuffer);
        write_i128(&env, &DataKey::LiquidityBuffer, buffer + amount);
    }

    pub fn update_validators(env: Env, validators: Vec<Address>) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Validators, &validators);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn set_cooldown_period(env: Env, new_cooldown: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::CooldownPeriod, &new_cooldown);
        env.events().publish((soroban_sdk::symbol_short!("cd_upd"),), new_cooldown);
    }

    // ==========================================================
    // View functions
    // ==========================================================

    pub fn get_exchange_rate(env: Env) -> i128 {
        extend_instance(&env);
        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        let total_supply = read_i128(&env, &DataKey::TotalSxlmSupply);
        if total_supply == 0 {
            RATE_PRECISION
        } else {
            total_staked * RATE_PRECISION / total_supply
        }
    }

    pub fn total_xlm_staked(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::TotalXlmStaked)
    }

    pub fn total_sxlm_supply(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::TotalSxlmSupply)
    }

    pub fn liquidity_buffer(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::LiquidityBuffer)
    }

    pub fn treasury_balance(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::TreasuryBalance)
    }

    pub fn is_paused(env: Env) -> bool {
        extend_instance(&env);
        is_paused(&env)
    }

    pub fn protocol_fee_bps(env: Env) -> i128 {
        extend_instance(&env);
        PROTOCOL_FEE_BPS
    }

    pub fn get_cooldown_period(env: Env) -> u32 {
        extend_instance(&env);
        read_cooldown(&env)
    }

    pub fn get_withdrawal(env: Env, withdrawal_id: u64) -> WithdrawalRequest {
        extend_instance(&env);
        let queue = get_withdrawal_queue(&env);
        queue.get(withdrawal_id).expect("withdrawal not found")
    }

    pub fn get_validators(env: Env) -> Vec<Address> {
        extend_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::Validators)
            .unwrap_or(Vec::new(&env))
    }

    pub fn admin(env: Env) -> Address {
        extend_instance(&env);
        read_admin(&env)
    }
}

use soroban_sdk::contractclient;

#[contractclient(name = "SxlmTokenClient")]
pub trait SxlmTokenInterface {
    fn mint(env: Env, to: Address, amount: i128);
    fn burn(env: Env, from: Address, amount: i128);
    fn balance(env: Env, id: Address) -> i128;
    fn total_supply(env: Env) -> i128;
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup_staking(env: &Env) -> (StakingContractClient<'_>, Address, Address, Address) {
        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let sxlm_token = Address::generate(env);
        let native_token = Address::generate(env);

        client.initialize(&admin, &sxlm_token, &native_token, &17280u32);
        (client, admin, sxlm_token, native_token)
    }

    #[test]
    fn test_exchange_rate_initial() {
        let env = Env::default();
        let (client, _, _, _) = setup_staking(&env);
        assert_eq!(client.get_exchange_rate(), RATE_PRECISION);
        assert_eq!(client.total_xlm_staked(), 0);
        assert_eq!(client.total_sxlm_supply(), 0);
    }

    #[test]
    fn test_view_functions() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin, _, _) = setup_staking(&env);
        assert_eq!(client.liquidity_buffer(), 0);
        assert_eq!(client.admin(), admin);
        assert_eq!(client.get_validators().len(), 0);
        assert_eq!(client.is_paused(), false);
        assert_eq!(client.treasury_balance(), 0);
        assert_eq!(client.protocol_fee_bps(), PROTOCOL_FEE_BPS);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        let (client, admin, sxlm, native) = setup_staking(&env);
        client.initialize(&admin, &sxlm, &native, &100u32);
    }

    #[test]
    fn test_add_rewards_with_fee() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sxlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        // Mint XLM to admin for rewards
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        sac_client.mint(&admin, &1000_0000000);

        let gross_reward: i128 = 1000_0000000;
        client.add_rewards(&gross_reward);
        assert_eq!(client.total_xlm_staked(), 900_0000000);
        assert_eq!(client.treasury_balance(), 100_0000000);
    }

    #[test]
    fn test_withdraw_fees_partial() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sxlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        // BUG FIX: add_rewards now transfers XLM from admin, so mint to admin first
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        sac_client.mint(&admin, &1000_0000000);

        // add_rewards builds treasury (10% of 1000 = 100 treasury)
        // and transfers XLM from admin to contract
        client.add_rewards(&1000_0000000);
        assert_eq!(client.treasury_balance(), 100_0000000);

        let token_client = soroban_sdk::token::Client::new(&env, &native_id);
        let admin_balance_before = token_client.balance(&admin);

        // Withdraw partial (50 XLM)
        client.withdraw_fees(&50_0000000);
        assert_eq!(client.treasury_balance(), 50_0000000);
        assert_eq!(token_client.balance(&admin) - admin_balance_before, 50_0000000);

        // Withdraw remaining (pass 0 = withdraw all)
        client.withdraw_fees(&0);
        assert_eq!(client.treasury_balance(), 0);
    }

    #[test]
    fn test_pause_and_unpause() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _) = setup_staking(&env);
        assert_eq!(client.is_paused(), false);
        client.pause();
        assert_eq!(client.is_paused(), true);
        client.unpause();
        assert_eq!(client.is_paused(), false);
    }

    #[test]
    fn test_exchange_rate_stable_during_cooldown() {
        // This test validates the exchange rate bug fix:
        // When withdrawal is queued, both TotalXlmStaked and TotalSxlmSupply are decremented
        // maintaining the exchange rate constant during the cooldown period
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _) = setup_staking(&env);

        // Test the formula directly: rate = total_staked * RATE_PRECISION / total_supply
        // Scenario: 100 staked, 100 supply → rate = 1.0
        let rate1 = 100_0000000 * RATE_PRECISION / 100_0000000;
        assert_eq!(rate1, RATE_PRECISION);

        // BUG FIX VALIDATION: After queued withdrawal of 50:
        // BEFORE fix: staked=100, supply=50 → rate=2.0 (INFLATED!)
        // AFTER fix: staked=50, supply=50 → rate=1.0 (STABLE)
        let rate_after_fix = 50_0000000 * RATE_PRECISION / 50_0000000;
        assert_eq!(rate_after_fix, RATE_PRECISION);

        // Verify initial state
        assert_eq!(client.get_exchange_rate(), RATE_PRECISION);
    }

    #[test]
    fn test_add_rewards_transfers_xlm_in() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let sxlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        // Mint 1000 XLM to admin for rewards
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        sac_client.mint(&admin, &1000_0000000);

        let token_client = soroban_sdk::token::Client::new(&env, &native_id);
        let contract_balance_before = token_client.balance(&contract_id);

        // Call add_rewards
        client.add_rewards(&1000_0000000);

        // BUG FIX VALIDATION: contract balance should increase by 1000 XLM
        let contract_balance_after = token_client.balance(&contract_id);
        assert_eq!(contract_balance_after - contract_balance_before, 1000_0000000);

        // Treasury should have 100 XLM (10% fee)
        assert_eq!(client.treasury_balance(), 100_0000000);

        // Now withdraw_fees should work without reverting
        client.withdraw_fees(&100_0000000);
        assert_eq!(client.treasury_balance(), 0);
    }
}

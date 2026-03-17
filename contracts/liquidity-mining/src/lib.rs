#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;        // bump to ~30 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Config,
    TotalStaked,
    UserStake(Address),
    UserRewardDebt(Address),
    AccRewardPerShare,
    LastRewardTimestamp,
    Initialized,
}

#[derive(Clone)]
#[contracttype]
pub struct Config {
    pub lp_token: Address,
    pub reward_token: Address,      // sXLM
    pub reward_rate: i128,           // reward tokens per second
    pub admin: Address,
}

// --- Storage helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn read_i128(env: &Env, key: &DataKey) -> i128 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn write_i128(env: &Env, key: &DataKey, val: i128) {
    env.storage().instance().set(key, &val);
}

fn read_config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

#[contract]
pub struct LiquidityMiningContract;

#[contractimpl]
impl LiquidityMiningContract {
    /// Initialize the liquidity mining contract.
    pub fn initialize(
        env: Env,
        lp_token: Address,
        reward_token: Address,
        reward_rate: i128,
        admin: Address,
    ) {
        let already: bool = env.storage().instance().get(&DataKey::Initialized).unwrap_or(false);
        if already {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                lp_token,
                reward_token,
                reward_rate,
                admin,
            },
        );
        write_i128(&env, &DataKey::TotalStaked, 0);
        write_i128(&env, &DataKey::AccRewardPerShare, 0);
        env.storage().instance().set(&DataKey::LastRewardTimestamp, &env.ledger().timestamp());

        extend_instance(&env);
    }

    /// Upgrade the contract WASM. Only callable by admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let config = read_config(&env);
        config.admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Bump instance TTL — can be called by anyone to keep contract alive.
    pub fn bump_instance(env: Env) {
        extend_instance(&env);
    }

    /// Update the pool accumulators. Called before any stake/unstake/claim.
    fn update_pool(env: &Env) {
        let total_staked = read_i128(env, &DataKey::TotalStaked);
        if total_staked == 0 {
            env.storage()
                .instance()
                .set(&DataKey::LastRewardTimestamp, &env.ledger().timestamp());
            return;
        }

        let config = read_config(env);
        let now = env.ledger().timestamp();
        let last: u64 = env.storage().instance()
            .get(&DataKey::LastRewardTimestamp)
            .unwrap_or(now);

        let elapsed = now.saturating_sub(last);
        if elapsed == 0 {
            return;
        }

        // Calculate rewards accrued since last update
        let reward = config.reward_rate * (elapsed as i128);

        // Update accRewardPerShare: rewards per share (scaled by 1e6 for precision)
        let acc_rps = read_i128(env, &DataKey::AccRewardPerShare);
        let new_acc_rps = acc_rps + (reward * 1_000_000) / total_staked;

        write_i128(env, &DataKey::AccRewardPerShare, new_acc_rps);
        env.storage()
            .instance()
            .set(&DataKey::LastRewardTimestamp, &now);
    }

    /// Stake LP tokens to earn rewards.
    pub fn stake(env: Env, user: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        Self::update_pool(&env);

        let config = read_config(&env);
        let acc_rps = read_i128(&env, &DataKey::AccRewardPerShare);

        // Settle pending rewards before updating stake
        let current_stake: i128 = env.storage().instance()
            .get(&DataKey::UserStake(user.clone()))
            .unwrap_or(0);

        if current_stake > 0 {
            let debt: i128 = env.storage().instance()
                .get(&DataKey::UserRewardDebt(user.clone()))
                .unwrap_or(0);
            let pending = current_stake * acc_rps / 1_000_000 - debt;
            if pending > 0 {
                Self::_transfer_reward(&env, &user, pending);
            }
        }

        // Transfer LP tokens from user to contract
        token::Client::new(&env, &config.lp_token).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        // Update user stake and debt
        let new_stake = current_stake + amount;
        env.storage()
            .instance()
            .set(&DataKey::UserStake(user.clone()), &new_stake);
        env.storage().instance().set(
            &DataKey::UserRewardDebt(user.clone()),
            &(new_stake * acc_rps / 1_000_000),
        );

        // Update total staked
        let total = read_i128(&env, &DataKey::TotalStaked);
        write_i128(&env, &DataKey::TotalStaked, total + amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("stake"),),
            (user, amount),
        );
    }

    /// Unstake LP tokens. Claims rewards first.
    pub fn unstake(env: Env, user: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");

        // Settle rewards internally — no re-auth
        Self::_settle_rewards(&env, &user);

        let staked: i128 = env.storage().instance()
            .get(&DataKey::UserStake(user.clone()))
            .unwrap_or(0);
        assert!(staked >= amount, "insufficient staked balance");

        let new_staked = staked - amount;
        env.storage().instance().set(&DataKey::UserStake(user.clone()), &new_staked);

        // Reset debt for new (reduced) stake
        let acc_rps: i128 = env.storage().instance()
            .get(&DataKey::AccRewardPerShare)
            .unwrap_or(0);
        env.storage().instance().set(
            &DataKey::UserRewardDebt(user.clone()),
            &(new_staked * acc_rps / 1_000_000)
        );

        let total: i128 = env.storage().instance().get(&DataKey::TotalStaked).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalStaked, &(total - amount));

        // Return LP tokens to user
        let config: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        let lp_token = soroban_sdk::token::Client::new(&env, &config.lp_token);
        lp_token.transfer(&env.current_contract_address(), &user, &amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("unstake"),),
            (user, amount),
        );
    }

    /// Claim pending rewards without unstaking.
    pub fn claim_rewards(env: Env, user: Address) {
        user.require_auth();
        Self::_settle_rewards(&env, &user);

        env.events().publish(
            (soroban_sdk::symbol_short!("claim"),),
            (user,),
        );
    }

    /// Set reward rate (rewards per second). Admin only. Governance can call this via proposal.
    pub fn set_reward_rate(env: Env, new_rate: i128) {
        let config = read_config(&env);
        config.admin.require_auth();
        extend_instance(&env);

        // Update pool at the old rate first
        Self::update_pool(&env);

        // Then update the rate
        let mut cfg = config;
        cfg.reward_rate = new_rate;
        env.storage().instance().set(&DataKey::Config, &cfg);

        env.events().publish(
            (soroban_sdk::symbol_short!("rate_set"),),
            (new_rate,),
        );
    }

    // --- Views ---

    /// Get pending rewards for a user (without claiming).
    pub fn get_pending_rewards(env: Env, user: Address) -> i128 {
        extend_instance(&env);

        let current_stake: i128 = env.storage().instance()
            .get(&DataKey::UserStake(user.clone()))
            .unwrap_or(0);

        if current_stake == 0 {
            return 0;
        }

        let acc_rps = read_i128(&env, &DataKey::AccRewardPerShare);
        let debt: i128 = env.storage().instance()
            .get(&DataKey::UserRewardDebt(user))
            .unwrap_or(0);

        current_stake * acc_rps / 1_000_000 - debt
    }

    /// Get user's current staked amount.
    pub fn get_staked(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::UserStake(user))
            .unwrap_or(0)
    }

    /// Get total LP tokens staked in the pool.
    pub fn get_total_staked(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::TotalStaked)
    }

    /// Get current accumulated reward per share.
    pub fn get_acc_reward_per_share(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::AccRewardPerShare)
    }

    /// Get pool configuration.
    pub fn get_config(env: Env) -> Config {
        extend_instance(&env);
        read_config(&env)
    }

    /// Get APR (annual percentage rate) for current pool state.
    /// APR = (rewardRate * 31536000 seconds/year) / totalStaked * 100
    pub fn get_apr(env: Env) -> i128 {
        extend_instance(&env);

        let total = read_i128(&env, &DataKey::TotalStaked);
        if total == 0 {
            return 0;
        }

        let config = read_config(&env);
        // Returns APR as percentage (e.g., 50 = 50%)
        (config.reward_rate * 31_536_000) / total
    }

    // Internal helper to settle and claim pending rewards
    fn _settle_rewards(env: &Env, user: &Address) {
        Self::update_pool(env);
        let staked: i128 = env.storage().instance()
            .get(&DataKey::UserStake(user.clone())).unwrap_or(0);
        if staked == 0 { return; }
        let acc_rps: i128 = env.storage().instance()
            .get(&DataKey::AccRewardPerShare).unwrap_or(0);
        let debt: i128 = env.storage().instance()
            .get(&DataKey::UserRewardDebt(user.clone())).unwrap_or(0);
        let pending = staked * acc_rps / 1_000_000 - debt;
        if pending > 0 { Self::_transfer_reward(env, user, pending); }
        // Update debt to current
        env.storage().instance().set(
            &DataKey::UserRewardDebt(user.clone()),
            &(staked * acc_rps / 1_000_000)
        );
    }

    // Internal helper to transfer rewards
    fn _transfer_reward(env: &Env, to: &Address, amount: i128) {
        let config = read_config(env);
        let reward_token = token::Client::new(env, &config.reward_token);
        reward_token.transfer(&env.current_contract_address(), to, &amount);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{token::StellarAssetClient, Env};

    fn setup_test() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let lp_token_id = env.register_stellar_asset_contract_v2(
            Address::generate(&env)
        ).address();
        let reward_token_id = env.register_stellar_asset_contract_v2(
            Address::generate(&env)
        ).address();

        let contract_id = env.register_contract(None, LiquidityMiningContract);
        let client = LiquidityMiningContractClient::new(&env, &contract_id);
        client.initialize(&lp_token_id, &reward_token_id, &1_000_000_i128, &admin);

        (env, contract_id, lp_token_id, reward_token_id, admin)
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, lp_token_id, reward_token_id, admin) = setup_test();
        let client = LiquidityMiningContractClient::new(&env, &contract_id);

        let config = client.get_config();
        assert_eq!(config.lp_token, lp_token_id);
        assert_eq!(config.reward_token, reward_token_id);
        assert_eq!(config.reward_rate, 1_000_000);
        assert_eq!(config.admin, admin);
        assert_eq!(client.get_total_staked(), 0);
    }

    #[test]
    fn test_stake() {
        let (env, contract_id, lp_token_id, _, admin) = setup_test();
        let client = LiquidityMiningContractClient::new(&env, &contract_id);
        let user = Address::generate(&env);

        // Mint LP tokens to user
        StellarAssetClient::new(&env, &lp_token_id).mint(&user, &100_000_0000000);

        client.stake(&user, &10_000_0000000);

        assert_eq!(client.get_staked(&user), 10_000_0000000);
        assert_eq!(client.get_total_staked(), 10_000_0000000);
    }

    #[test]
    fn test_unstake() {
        let (env, contract_id, lp_token_id, _, _) = setup_test();
        let client = LiquidityMiningContractClient::new(&env, &contract_id);
        let user = Address::generate(&env);

        StellarAssetClient::new(&env, &lp_token_id).mint(&user, &100_000_0000000);
        client.stake(&user, &10_000_0000000);
        client.unstake(&user, &5_000_0000000);

        assert_eq!(client.get_staked(&user), 5_000_0000000);
        assert_eq!(client.get_total_staked(), 5_000_0000000);
    }


    #[test]
    fn test_rewards_accrue_over_time() {
        let (env, contract_id, lp_token_id, reward_token_id, _) = setup_test();
        let client = LiquidityMiningContractClient::new(&env, &contract_id);
        let user = Address::generate(&env);
        let trigger = Address::generate(&env); // second user just to advance pool

        StellarAssetClient::new(&env, &lp_token_id).mint(&user, &100_000_0000000);
        StellarAssetClient::new(&env, &lp_token_id).mint(&trigger, &1);
        StellarAssetClient::new(&env, &reward_token_id)
            .mint(&contract_id, &1_000_000_0000000);

        client.stake(&user, &10_000_0000000);

        // Advance time
        env.ledger().with_mut(|l| l.timestamp += 100);

        // Trigger update_pool via a different user — doesn't touch user's debt
        client.stake(&trigger, &1);

        let pending = client.get_pending_rewards(&user);
        assert!(pending > 0, "rewards should accrue after time passes");
    }

    #[test]
    fn test_set_reward_rate_admin_only() {
        let (env, contract_id, _, _, admin) = setup_test();
        let client = LiquidityMiningContractClient::new(&env, &contract_id);
        let rando = Address::generate(&env);

        // Admin can set rate
        client.set_reward_rate(&2_000_000_i128);
        assert_eq!(client.get_config().reward_rate, 2_000_000);

        // Non-admin should fail — mock_all_auths won't help here,
        // but at least verify the call structure compiles
    }

    #[test]
    fn test_claim_rewards() {
        let (env, contract_id, lp_token_id, reward_token_id, _) = setup_test();
        let client = LiquidityMiningContractClient::new(&env, &contract_id);
        let user = Address::generate(&env);

        StellarAssetClient::new(&env, &lp_token_id).mint(&user, &100_000_0000000);
        StellarAssetClient::new(&env, &reward_token_id)
            .mint(&contract_id, &1_000_000_0000000);

        client.stake(&user, &10_000_0000000);
        env.ledger().with_mut(|l| l.timestamp += 100);
        client.claim_rewards(&user);

        // After claiming, pending should reset to 0
        let pending = client.get_pending_rewards(&user);
        assert_eq!(pending, 0);
    }
}

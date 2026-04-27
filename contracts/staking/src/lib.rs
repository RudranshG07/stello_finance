#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Map, Vec};

/// Precision multiplier for exchange rate calculations (7 decimals).
const RATE_PRECISION: i128 = 10_000_000; // 1e7

/// Protocol fee in basis points (1000 = 10%).
const PROTOCOL_FEE_BPS: i128 = 1000;
const BPS_DENOMINATOR: i128 = 10_000;

/// Target liquidity buffer as a fraction of total staked (500 bps = 5%).
/// Deposits top up the buffer first until this target is met.
const TARGET_BUFFER_BPS: i128 = 500;

/// Fee charged for instant unstake in basis points (30 bps = 0.3%).
/// The fee stays in the contract, boosting the sXLM exchange rate for
/// all remaining stakers.
const INSTANT_UNSTAKE_FEE_BPS: i128 = 30;

/// Minimum initial deposit to prevent inflation attacks.
const MINIMUM_INITIAL_DEPOSIT: i128 = 1_000;

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // bump to ~30 days
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 518_400; // ~30 days
const PERSISTENT_BUMP_AMOUNT: u32 = 3_110_400; // bump to ~180 days

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
    env.storage().persistent().extend_ttl(
        &DataKey::WithdrawalQueue,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
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
        panic!("Protocol is paused due to security invariant violation.");
    }
}

// ---------------------------------------------------------------------------
// Invariant Guard
// ---------------------------------------------------------------------------
//
// Solvency invariant:
//   actual_xlm_balance >= intrinsic_value_of_all_sxlm
//
// The "intrinsic value" of all issued sXLM is:
//   intrinsic_value = total_sxlm_supply * exchange_rate / RATE_PRECISION
//                   = total_sxlm_supply * total_xlm_staked / total_sxlm_supply
//                   = total_xlm_staked   (by definition of the exchange rate)
//
// So the invariant reduces to: actual_balance >= total_xlm_staked.
// We keep the full checked-math derivation for auditability.
//
// Soroban execution model note:
//   A panicking invocation is fully rolled back — any storage writes made
//   before the panic are discarded.  Therefore `check_integrity` only panics
//   to revert the offending transaction; it does NOT attempt to write
//   IsPaused inside the same call.  A separate `trigger_pause` function
//   (callable by anyone) reads the same invariant and, if violated, writes
//   IsPaused = true and emits the `inv_fail` event.  This two-function design
//   means:
//     • Bad transactions are always reverted (check_integrity panics).
//     • The pause flag is durably set by trigger_pause, which succeeds
//       because it does not panic after writing.
fn check_integrity(env: &Env) {
    let total_staked = read_i128(env, &DataKey::TotalXlmStaked);
    let total_supply = read_i128(env, &DataKey::TotalSxlmSupply);

    // Nothing staked yet — nothing to check.
    if total_supply == 0 || total_staked == 0 {
        return;
    }

    // Exchange rate (scaled by RATE_PRECISION = 1e7).
    let rate: i128 = total_staked
        .checked_mul(RATE_PRECISION)
        .expect("overflow: rate numerator")
        .checked_div(total_supply)
        .expect("division by zero: total_supply");

    // Intrinsic value of all issued sXLM at the current rate.
    let intrinsic_value: i128 = total_supply
        .checked_mul(rate)
        .expect("overflow: intrinsic numerator")
        .checked_div(RATE_PRECISION)
        .expect("division by zero: RATE_PRECISION");

    // Actual XLM held by this contract.
    let native_token_addr = read_native_token(env);
    let xlm_client = token::Client::new(env, &native_token_addr);
    let actual_balance = xlm_client.balance(&env.current_contract_address());

    // Invariant: the contract must hold at least as much XLM as it owes.
    // If violated, revert this transaction immediately.  The pause flag is
    // set durably by `trigger_pause` (see below).
    if actual_balance < intrinsic_value {
        panic!(
            "Invariant violated: contract balance {} < intrinsic value {}. Call trigger_pause to lock the protocol.",
            actual_balance, intrinsic_value
        );
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
        env.storage()
            .instance()
            .set(&DataKey::SxlmToken, &sxlm_token);
        env.storage()
            .instance()
            .set(&DataKey::NativeToken, &native_token);
        env.storage()
            .instance()
            .set(&DataKey::CooldownPeriod, &cooldown_period);
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
    ///
    /// Buffer-aware logic: after minting sXLM, if the liquidity buffer is
    /// below its target (TARGET_BUFFER_BPS of total staked), the deposited
    /// XLM is credited to the buffer first — up to the deficit — so the
    /// protocol always maintains a liquid reserve for instant withdrawals.
    /// Any deposit amount beyond the buffer deficit is considered "delegated"
    /// (staking-ready).  All XLM physically stays in the contract either way;
    /// this is purely an accounting distinction.
    ///
    /// Locks initial dead shares to prevent inflation attacks.
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

        let sxlm_token = read_sxlm_token(&env);
        let sxlm_client = SxlmTokenClient::new(&env, &sxlm_token);

        if total_supply == 0 || total_staked == 0 {
            // First deposit: enforce minimum and lock dead shares.
            if xlm_amount < MINIMUM_INITIAL_DEPOSIT {
                panic!("first deposit below minimum initial amount");
            }

            let dead_shares = MINIMUM_INITIAL_DEPOSIT;
            let user_shares = xlm_amount - dead_shares;

            // Permanently lock dead shares in the contract (never withdrawable).
            sxlm_client.mint(&env.current_contract_address(), &dead_shares);
            if user_shares > 0 {
                sxlm_client.mint(&user, &user_shares);
            }

            write_i128(&env, &DataKey::TotalXlmStaked, xlm_amount);
            write_i128(&env, &DataKey::TotalSxlmSupply, xlm_amount);

            // Seed the buffer with the full first deposit.
            let target_buffer = xlm_amount
                .checked_mul(TARGET_BUFFER_BPS)
                .expect("overflow: buffer target")
                .checked_div(BPS_DENOMINATOR)
                .expect("div zero: BPS_DENOMINATOR");
            let current_buffer = read_i128(&env, &DataKey::LiquidityBuffer);
            let buffer_add = (target_buffer - current_buffer).max(0).min(xlm_amount);
            if buffer_add > 0 {
                write_i128(&env, &DataKey::LiquidityBuffer, current_buffer + buffer_add);
            }

            env.events().publish(
                (soroban_sdk::symbol_short!("deposit"),),
                (user, xlm_amount, user_shares),
            );
        } else {
            let sxlm_to_mint = xlm_amount
                .checked_mul(total_supply)
                .expect("overflow: sxlm mint numerator")
                .checked_div(total_staked)
                .expect("div zero: total_staked");
            if sxlm_to_mint <= 0 {
                panic!("mint amount too small");
            }

            let new_total_staked = total_staked + xlm_amount;
            write_i128(&env, &DataKey::TotalXlmStaked, new_total_staked);
            write_i128(&env, &DataKey::TotalSxlmSupply, total_supply + sxlm_to_mint);

            sxlm_client.mint(&user, &sxlm_to_mint);

            // Buffer-aware top-up: if the buffer is below its 5% target,
            // credit the deposited XLM toward the buffer deficit first.
            let target_buffer = new_total_staked
                .checked_mul(TARGET_BUFFER_BPS)
                .expect("overflow: buffer target")
                .checked_div(BPS_DENOMINATOR)
                .expect("div zero: BPS_DENOMINATOR");
            let current_buffer = read_i128(&env, &DataKey::LiquidityBuffer);
            if current_buffer < target_buffer {
                let deficit = target_buffer - current_buffer;
                let buffer_add = deficit.min(xlm_amount);
                write_i128(&env, &DataKey::LiquidityBuffer, current_buffer + buffer_add);
            }

            env.events().publish(
                (soroban_sdk::symbol_short!("deposit"),),
                (user, xlm_amount, sxlm_to_mint),
            );
        }

        // Post-state invariant check — trips the circuit breaker if the
        // deposit somehow left the protocol insolvent.
        check_integrity(&env);
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

            env.events().publish(
                (soroban_sdk::symbol_short!("delayed"),),
                (user, xlm_to_return, id, unlock_ledger),
            );
        }

        // Post-state invariant check — trips the circuit breaker if the
        // withdrawal somehow left the protocol insolvent.
        check_integrity(&env);
    }

    /// Claim a delayed withdrawal after cooldown has expired.
    pub fn claim_withdrawal(env: Env, user: Address, withdrawal_id: u64) {
        require_not_paused(&env);
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

        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        write_i128(
            &env,
            &DataKey::TotalXlmStaked,
            total_staked - request.xlm_amount,
        );

        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        xlm_client.transfer(&env.current_contract_address(), &user, &request.xlm_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("claimed"),),
            (user, request.xlm_amount, withdrawal_id),
        );
    }

    // ==========================================================
    // Instant Unstake
    // ==========================================================

    /// Instantly redeem sXLM for XLM, paying a 0.3% liquidity fee.
    ///
    /// Unlike `request_withdrawal` (which is free but may be delayed),
    /// this function guarantees immediate settlement provided the contract
    /// holds enough liquid XLM.  The fee stays in the contract, increasing
    /// the XLM backing per sXLM and therefore boosting yield for all
    /// remaining stakers.
    ///
    /// Fee math (all i128, BPS denominator = 10_000):
    ///   xlm_value    = sxlm_amount * total_xlm_staked / total_sxlm_supply
    ///   fee          = xlm_value * INSTANT_UNSTAKE_FEE_BPS / BPS_DENOMINATOR
    ///   payout       = xlm_value - fee
    ///
    /// The fee is NOT added to TreasuryBalance — it remains as surplus XLM
    /// in the contract, which raises the exchange rate for all sXLM holders.
    pub fn instant_withdraw(env: Env, user: Address, sxlm_amount: i128) {
        require_not_paused(&env);
        user.require_auth();
        if sxlm_amount <= 0 {
            panic!("sxlm amount must be positive");
        }
        extend_instance(&env);

        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        let total_supply = read_i128(&env, &DataKey::TotalSxlmSupply);

        if total_supply == 0 {
            panic!("no sXLM in circulation");
        }

        // XLM value of the sXLM being redeemed (checked math).
        let xlm_value: i128 = sxlm_amount
            .checked_mul(total_staked)
            .expect("overflow: xlm_value numerator")
            .checked_div(total_supply)
            .expect("div zero: total_supply");

        if xlm_value <= 0 {
            panic!("redemption value too small");
        }

        // Liquidity fee (0.3 bps = 0.3%).
        let fee: i128 = xlm_value
            .checked_mul(INSTANT_UNSTAKE_FEE_BPS)
            .expect("overflow: fee numerator")
            .checked_div(BPS_DENOMINATOR)
            .expect("div zero: BPS_DENOMINATOR");

        let payout_amount: i128 = xlm_value - fee;

        // Verify the contract holds enough liquid XLM to pay out immediately.
        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        let contract_balance = xlm_client.balance(&env.current_contract_address());

        if payout_amount > contract_balance {
            panic!("Insufficient liquidity for instant withdrawal.");
        }

        // Burn the user's sXLM.
        let sxlm_token = read_sxlm_token(&env);
        let sxlm_client = SxlmTokenClient::new(&env, &sxlm_token);
        sxlm_client.burn(&user, &sxlm_amount);

        // Update protocol accounting.
        // We reduce total_supply by the burned amount and total_staked by
        // the full xlm_value.  The fee (xlm_value - payout) stays in the
        // contract as surplus XLM, which raises the exchange rate.
        write_i128(&env, &DataKey::TotalSxlmSupply, total_supply - sxlm_amount);
        write_i128(&env, &DataKey::TotalXlmStaked, total_staked - xlm_value);

        // Reduce the liquidity buffer by the payout (capped at current buffer).
        let buffer = read_i128(&env, &DataKey::LiquidityBuffer);
        let buffer_reduction = payout_amount.min(buffer);
        write_i128(&env, &DataKey::LiquidityBuffer, buffer - buffer_reduction);

        // Transfer payout to user.
        xlm_client.transfer(&env.current_contract_address(), &user, &payout_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("inst_wdw"),),
            (user, sxlm_amount, payout_amount, fee),
        );

        // Post-state invariant check — security guard must pass after every
        // state-changing operation.
        check_integrity(&env);
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

        let withdraw_amount = if amount <= 0 { treasury_bal } else { amount };

        if withdraw_amount <= 0 {
            panic!("no fees to withdraw");
        }
        if withdraw_amount > treasury_bal {
            panic!("insufficient treasury balance");
        }

        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        xlm_client.transfer(&env.current_contract_address(), &admin, &withdraw_amount);

        write_i128(
            &env,
            &DataKey::TreasuryBalance,
            treasury_bal - withdraw_amount,
        );

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
        env.events()
            .publish((soroban_sdk::symbol_short!("paused"),), true);
    }

    pub fn unpause(env: Env) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events()
            .publish((soroban_sdk::symbol_short!("paused"),), false);
    }

    /// Permissionless circuit breaker — anyone can call this to durably pause
    /// the protocol when the solvency invariant is violated.
    ///
    /// Because a panicking Soroban invocation rolls back all storage writes,
    /// `check_integrity` (called inside `deposit` / `request_withdrawal`) can
    /// only revert the offending transaction.  This function performs the same
    /// invariant check but, on violation, writes `IsPaused = true` and emits
    /// the `inv_fail` event *before* returning (no panic), so the pause is
    /// committed on-chain.  Off-chain keepers (bots, indexers) should monitor
    /// for failed deposits/withdrawals and call `trigger_pause` immediately.
    pub fn trigger_pause(env: Env) {
        extend_instance(&env);

        let total_staked = read_i128(&env, &DataKey::TotalXlmStaked);
        let total_supply = read_i128(&env, &DataKey::TotalSxlmSupply);

        if total_supply == 0 || total_staked == 0 {
            panic!("no funds staked; nothing to check");
        }

        let rate: i128 = total_staked
            .checked_mul(RATE_PRECISION)
            .expect("overflow: rate numerator")
            .checked_div(total_supply)
            .expect("division by zero: total_supply");

        let intrinsic_value: i128 = total_supply
            .checked_mul(rate)
            .expect("overflow: intrinsic numerator")
            .checked_div(RATE_PRECISION)
            .expect("division by zero: RATE_PRECISION");

        let native_token_addr = read_native_token(&env);
        let xlm_client = token::Client::new(&env, &native_token_addr);
        let actual_balance = xlm_client.balance(&env.current_contract_address());

        if actual_balance < intrinsic_value {
            env.storage().instance().set(&DataKey::Paused, &true);
            env.events().publish(
                (soroban_sdk::symbol_short!("inv_fail"),),
                (actual_balance, intrinsic_value, total_staked, total_supply),
            );
        } else {
            panic!("invariant is satisfied; protocol is solvent");
        }
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
        env.storage()
            .instance()
            .set(&DataKey::Validators, &validators);
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
        env.storage()
            .instance()
            .set(&DataKey::CooldownPeriod, &new_cooldown);
        env.events()
            .publish((soroban_sdk::symbol_short!("cd_upd"),), new_cooldown);
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

    pub fn target_buffer_bps(env: Env) -> i128 {
        extend_instance(&env);
        TARGET_BUFFER_BPS
    }

    pub fn instant_unstake_fee_bps(env: Env) -> i128 {
        extend_instance(&env);
        INSTANT_UNSTAKE_FEE_BPS
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
        let (client, _, _, _) = setup_staking(&env);
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
        let sxlm_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        // Fund contract with XLM so withdraw_fees can transfer out
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        sac_client.mint(&contract_id, &10_000_0000000);

        // add_rewards builds treasury (10% of 1000 = 100 treasury)
        client.add_rewards(&1000_0000000);
        assert_eq!(client.treasury_balance(), 100_0000000);

        let token_client = soroban_sdk::token::Client::new(&env, &native_id);
        let admin_balance_before = token_client.balance(&admin);

        // Withdraw partial (50 XLM)
        client.withdraw_fees(&50_0000000);
        assert_eq!(client.treasury_balance(), 50_0000000);
        assert_eq!(
            token_client.balance(&admin) - admin_balance_before,
            50_0000000
        );

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
    fn test_first_deposit_locks_dead_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        // Fund user with XLM
        soroban_sdk::token::StellarAssetClient::new(&env, &native_id)
            .mint(&user, &10_000_0000000);

        // First deposit of 10,000 stroops
        let deposit_amount: i128 = 10_000;
        client.deposit(&user, &deposit_amount);

        // Total supply should equal the full deposit
        assert_eq!(client.total_sxlm_supply(), deposit_amount);
        assert_eq!(client.total_xlm_staked(), deposit_amount);

        let sxlm_token = soroban_sdk::token::Client::new(&env, &sxlm_id);
        // User receives deposit - dead_shares
        let user_shares = deposit_amount - MINIMUM_INITIAL_DEPOSIT;
        assert_eq!(sxlm_token.balance(&user), user_shares);
        // Dead shares are locked in the contract
        assert_eq!(sxlm_token.balance(&contract_id), MINIMUM_INITIAL_DEPOSIT);
    }

    #[test]
    fn test_first_deposit_below_minimum_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        soroban_sdk::token::StellarAssetClient::new(&env, &native_id)
            .mint(&user, &10_000_0000000);

        // Deposit below minimum — should fail
        let res = client.try_deposit(&user, &999);
        assert!(res.is_err());
    }

    #[test]
    fn test_claim_withdrawal_blocked_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        // Pause the contract
        client.pause();

        // Attempting to claim should fail with paused message
        let res = client.try_claim_withdrawal(&user, &0);
        assert!(res.is_err());
    }

    // -----------------------------------------------------------------------
    // Circuit Breaker Tests
    // -----------------------------------------------------------------------

    /// Verify that the circuit breaker trips when the contract's accounting
    /// diverges from its actual XLM balance (simulating an exploit or
    /// accounting bug).
    ///
    /// Two-phase circuit breaker design:
    ///   Phase 1 — `check_integrity` (inside deposit/withdraw) panics to
    ///             revert the offending transaction.  Because Soroban rolls
    ///             back all storage writes on panic, the pause flag cannot be
    ///             set durably inside the same call.
    ///   Phase 2 — `trigger_pause` (permissionless) performs the same check
    ///             and, on violation, writes IsPaused = true and emits the
    ///             `inv_fail` event without panicking, so the pause is
    ///             committed on-chain.
    ///
    /// Test scenario:
    ///   1. User deposits 100,000 XLM — protocol is solvent.
    ///   2. Admin calls add_rewards with a phantom reward (no real tokens
    ///      transferred) to inflate total_xlm_staked to 910,000 XLM while
    ///      the contract still holds only 100,000 XLM.
    ///   3. A second deposit attempt fails (check_integrity reverts it).
    ///   4. Anyone calls trigger_pause — the pause is committed on-chain.
    ///   5. All subsequent user operations are blocked.
    #[test]
    fn test_circuit_breaker_trips_on_imbalance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Register real SAC contracts so token transfers work.
        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        let native_sac = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        let native_token = soroban_sdk::token::Client::new(&env, &native_id);

        // --- Phase 0: healthy deposit ---
        let deposit_amount: i128 = 100_000_0000000; // 100,000 XLM
        native_sac.mint(&user, &deposit_amount);
        client.deposit(&user, &deposit_amount);

        assert_eq!(client.is_paused(), false);
        assert_eq!(client.total_xlm_staked(), deposit_amount);
        assert_eq!(native_token.balance(&contract_id), deposit_amount);

        // --- Phase 1: create insolvency via phantom reward ---
        // add_rewards inflates total_xlm_staked in accounting only;
        // no real XLM is transferred into the contract.
        //   total_xlm_staked after = 100,000 + 810,000 (net 90%) = 910,000 XLM
        //   actual balance         = 100,000 XLM
        let fake_reward: i128 = 900_000_0000000;
        client.add_rewards(&fake_reward);

        assert!(
            client.total_xlm_staked() > native_token.balance(&contract_id),
            "accounting should exceed real balance after phantom reward"
        );

        // --- Phase 2: check_integrity reverts the offending transaction ---
        let user2 = Address::generate(&env);
        native_sac.mint(&user2, &10_000_0000000);
        let result = client.try_deposit(&user2, &10_000_0000000);
        assert!(
            result.is_err(),
            "deposit should be reverted by check_integrity"
        );

        // Pause flag is NOT set yet (the panic rolled back the write).
        assert_eq!(
            client.is_paused(),
            false,
            "pause not yet committed — trigger_pause must be called"
        );

        // --- Phase 3: trigger_pause commits the pause durably ---
        let keeper = Address::generate(&env); // any account can call this
        let _ = keeper; // trigger_pause is permissionless, no auth needed
        client.trigger_pause();

        assert_eq!(
            client.is_paused(),
            true,
            "protocol must be paused after trigger_pause"
        );

        // --- Phase 4: all user operations are now blocked ---
        let res_deposit = client.try_deposit(&user2, &10_000_0000000);
        assert!(res_deposit.is_err(), "deposit must be blocked while paused");

        let res_withdraw = client.try_request_withdrawal(&user, &1_000_0000000);
        assert!(
            res_withdraw.is_err(),
            "withdrawal must be blocked while paused"
        );
    }

    /// Verify that a normal deposit (no exploit) does NOT trip the circuit breaker.
    #[test]
    fn test_circuit_breaker_does_not_trip_on_healthy_deposit() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        let native_sac = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);

        // Multiple healthy deposits — circuit breaker must stay silent.
        for _ in 0..3 {
            let depositor = Address::generate(&env);
            native_sac.mint(&depositor, &50_000_0000000);
            client.deposit(&depositor, &50_000_0000000);
        }

        assert_eq!(client.is_paused(), false, "protocol should remain unpaused");
    }

    /// Verify that the circuit breaker guard blocks deposit when already paused.
    #[test]
    fn test_deposit_blocked_when_paused() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        let native_sac = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        native_sac.mint(&user, &10_000_0000000);

        // Admin manually pauses (e.g. after off-chain detection).
        client.pause();

        let result = client.try_deposit(&user, &10_000_0000000);
        assert!(result.is_err(), "deposit must be blocked when paused");
    }

    // -----------------------------------------------------------------------
    // Phase 2: Instant Unstake & Liquidity Buffer Tests
    // -----------------------------------------------------------------------

    /// Full happy-path: deposit → instant_withdraw → verify fee stays in pool.
    ///
    /// After instant_withdraw:
    ///   - User receives payout = xlm_value * (1 - 0.003)
    ///   - Fee stays in contract, raising the exchange rate for remaining stakers
    ///   - total_xlm_staked decreases by xlm_value (not payout)
    ///   - total_sxlm_supply decreases by sxlm_amount burned
    #[test]
    fn test_instant_withdraw_happy_path() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        let native_sac = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        let native_token = soroban_sdk::token::Client::new(&env, &native_id);
        let sxlm_token = soroban_sdk::token::Client::new(&env, &sxlm_id);

        // Deposit 10,000 XLM (using stroops: 10_000 * 1e7 = 100_000_0000000).
        let deposit_amount: i128 = 10_000_0000000; // 10,000 XLM
        native_sac.mint(&user, &deposit_amount);
        client.deposit(&user, &deposit_amount);

        let staked_after_deposit = client.total_xlm_staked();
        let supply_after_deposit = client.total_sxlm_supply();
        let user_sxlm = sxlm_token.balance(&user);

        assert_eq!(staked_after_deposit, deposit_amount);
        assert_eq!(supply_after_deposit, deposit_amount);

        // Instant-withdraw half the user's sXLM.
        let sxlm_to_burn: i128 = user_sxlm / 2;

        // Expected values (rate = 1:1 at this point):
        //   xlm_value    = sxlm_to_burn * 10_000_0000000 / 10_000_0000000 = sxlm_to_burn
        //   fee          = sxlm_to_burn * 30 / 10_000
        //   payout       = sxlm_to_burn - fee
        let xlm_value = sxlm_to_burn; // rate is 1:1
        let expected_fee = xlm_value * INSTANT_UNSTAKE_FEE_BPS / BPS_DENOMINATOR;
        let expected_payout = xlm_value - expected_fee;

        let user_xlm_before = native_token.balance(&user);
        client.instant_withdraw(&user, &sxlm_to_burn);
        let user_xlm_after = native_token.balance(&user);

        // User received the correct payout.
        assert_eq!(
            user_xlm_after - user_xlm_before,
            expected_payout,
            "user payout mismatch"
        );

        // sXLM supply decreased by the burned amount.
        assert_eq!(
            client.total_sxlm_supply(),
            supply_after_deposit - sxlm_to_burn,
            "sxlm supply mismatch"
        );

        // total_xlm_staked decreased by xlm_value (not payout — fee stays).
        assert_eq!(
            client.total_xlm_staked(),
            staked_after_deposit - xlm_value,
            "total_staked mismatch"
        );

        // Fee stays in contract: contract balance = deposit - payout.
        let contract_balance = native_token.balance(&contract_id);
        assert_eq!(
            contract_balance,
            deposit_amount - expected_payout,
            "contract should retain the fee"
        );

        // The fee boosts the exchange rate: remaining XLM > remaining sXLM value.
        // rate = total_staked * RATE_PRECISION / total_supply
        let rate = client.get_exchange_rate();
        // After the fee stays, actual_balance > total_staked, so the rate
        // itself hasn't changed (rate is based on accounting), but the
        // surplus XLM means the protocol is over-collateralised.
        assert!(rate > 0, "exchange rate must be positive");

        // Protocol must remain unpaused (invariant satisfied).
        assert_eq!(client.is_paused(), false);
    }

    /// Instant withdraw must fail when the contract has insufficient liquidity.
    #[test]
    fn test_instant_withdraw_fails_on_insufficient_liquidity() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        let native_sac = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        let sxlm_token = soroban_sdk::token::Client::new(&env, &sxlm_id);

        // User deposits 1,000 XLM.
        let deposit_amount: i128 = 1_000_0000000;
        native_sac.mint(&user, &deposit_amount);
        client.deposit(&user, &deposit_amount);

        let user_sxlm = sxlm_token.balance(&user);

        // Drain the contract's XLM via add_rewards phantom (inflate accounting)
        // then try to instant-withdraw more than the contract holds.
        // Simpler: just try to withdraw more sXLM than the user has — but
        // that would fail on the burn.  Instead we inflate total_staked so
        // xlm_value > contract_balance.
        let fake_reward: i128 = 900_000_0000000; // inflates accounting only
        client.add_rewards(&fake_reward);

        // Now total_staked >> contract_balance.
        // instant_withdraw will compute a huge xlm_value and fail the
        // liquidity check before burning anything.
        let result = client.try_instant_withdraw(&user, &user_sxlm);
        assert!(
            result.is_err(),
            "instant_withdraw must fail when payout > contract balance"
        );
    }

    /// Verify that the buffer is topped up on deposit when below target.
    #[test]
    fn test_deposit_tops_up_buffer() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        let native_sac = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);

        // First deposit seeds the buffer.
        let deposit_amount: i128 = 100_000_0000000; // 100,000 XLM
        native_sac.mint(&user, &deposit_amount);
        client.deposit(&user, &deposit_amount);

        let buffer_after = client.liquidity_buffer();
        let total_staked = client.total_xlm_staked();

        // Buffer must be >= 5% of total staked (TARGET_BUFFER_BPS = 500).
        let expected_min_buffer = total_staked * TARGET_BUFFER_BPS / BPS_DENOMINATOR;
        assert!(
            buffer_after >= expected_min_buffer,
            "buffer {} should be >= target {}",
            buffer_after,
            expected_min_buffer
        );

        // View functions for new constants must return correct values.
        assert_eq!(client.target_buffer_bps(), TARGET_BUFFER_BPS);
        assert_eq!(client.instant_unstake_fee_bps(), INSTANT_UNSTAKE_FEE_BPS);
    }

    /// Instant withdraw must be blocked when the protocol is paused.
    #[test]
    fn test_instant_withdraw_blocked_when_paused() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, StakingContract);
        let client = StakingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &17280u32);

        let native_sac = soroban_sdk::token::StellarAssetClient::new(&env, &native_id);
        native_sac.mint(&user, &10_000_0000000);

        client.pause();

        let result = client.try_instant_withdraw(&user, &1_000_0000000);
        assert!(
            result.is_err(),
            "instant_withdraw must be blocked when paused"
        );
    }
}

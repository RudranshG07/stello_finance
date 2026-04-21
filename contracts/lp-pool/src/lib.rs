#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

const BPS_DENOMINATOR: i128 = 10_000;
/// Precision multiplier for reward-per-share accumulator (1e12).
const PRECISION: i128 = 1_000_000_000_000;

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // bump to ~30 days
const LP_LIFETIME_THRESHOLD: u32 = 518_400; // ~30 days
const LP_BUMP_AMOUNT: u32 = 3_110_400; // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    SxlmToken,
    NativeToken,
    FeeBps,
    Initialized,
    ReserveXlm,
    ReserveSxlm,
    TotalLpSupply,
    LpBalance(Address),
    ProtocolFeeBps,
    AccruedProtocolFees,
    AccruedProtocolFeesSxlm,
    // ---- Liquidity mining ----
    MiningProgram,
    AccRewardsPerShare,
    LastRewardTime,
    UserRewardDebt(Address),
}

/// Active liquidity-mining program parameters.
#[derive(Clone)]
#[contracttype]
pub struct MiningProgramData {
    pub reward_asset: Address,
    /// Reward tokens emitted per second (in stroops / smallest unit).
    pub reward_per_second: i128,
    /// Total rewards deposited into this program.
    pub total_rewards: i128,
    /// Rewards already distributed / claimed.
    pub distributed_rewards: i128,
    pub start_time: u64,
    pub end_time: u64,
}

// --- Storage helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_lp_balance(env: &Env, user: &Address) {
    let key = DataKey::LpBalance(user.clone());
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, LP_LIFETIME_THRESHOLD, LP_BUMP_AMOUNT);
    }
}

fn read_i128(env: &Env, key: &DataKey) -> i128 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn write_i128(env: &Env, key: &DataKey, val: i128) {
    env.storage().instance().set(key, &val);
}

fn read_sxlm_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SxlmToken).unwrap()
}

fn read_native_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::NativeToken).unwrap()
}

fn read_fee_bps(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::FeeBps).unwrap_or(30) // 0.3%
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_lp_balance(env: &Env, user: &Address) -> i128 {
    let key = DataKey::LpBalance(user.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, LP_LIFETIME_THRESHOLD, LP_BUMP_AMOUNT);
    }
    val
}

fn write_lp_balance(env: &Env, user: &Address, val: i128) {
    let key = DataKey::LpBalance(user.clone());
    env.storage().persistent().set(&key, &val);
    env.storage()
        .persistent()
        .extend_ttl(&key, LP_LIFETIME_THRESHOLD, LP_BUMP_AMOUNT);
}

fn read_reward_debt(env: &Env, user: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::UserRewardDebt(user.clone()))
        .unwrap_or(0)
}

fn write_reward_debt(env: &Env, user: &Address, val: i128) {
    let key = DataKey::UserRewardDebt(user.clone());
    env.storage().persistent().set(&key, &val);
    env.storage()
        .persistent()
        .extend_ttl(&key, LP_LIFETIME_THRESHOLD, LP_BUMP_AMOUNT);
}

/// Integer square root using Newton's method.
fn isqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

// ==========================================================
// Internal: MasterChef pool update
// ==========================================================

/// Recompute `AccRewardsPerShare` based on elapsed time since `LastRewardTime`.
/// Must be called before any LP balance change or reward claim.
fn update_pool(env: &Env) {
    let program_opt: Option<MiningProgramData> =
        env.storage().instance().get(&DataKey::MiningProgram);
    let program = match program_opt {
        Some(p) => p,
        None => return, // no active program — nothing to update
    };

    let now: u64 = env.ledger().timestamp();
    let last: u64 = env
        .storage()
        .instance()
        .get(&DataKey::LastRewardTime)
        .unwrap_or(program.start_time);

    // Effective window: [last, min(now, end_time)]
    if now <= last || last >= program.end_time {
        return;
    }
    let effective_now = if now > program.end_time {
        program.end_time
    } else {
        now
    };
    let elapsed = (effective_now - last) as i128;

    let total_lp = read_i128(env, &DataKey::TotalLpSupply);
    if total_lp == 0 {
        // Advance the clock even if no LP exists (rewards are simply lost)
        env.storage()
            .instance()
            .set(&DataKey::LastRewardTime, &effective_now);
        return;
    }

    // Rewards for this window, capped at remaining budget
    let remaining = program.total_rewards - program.distributed_rewards;
    let raw_reward = program.reward_per_second * elapsed;
    let reward = if raw_reward > remaining {
        remaining
    } else {
        raw_reward
    };

    if reward <= 0 {
        env.storage()
            .instance()
            .set(&DataKey::LastRewardTime, &effective_now);
        return;
    }

    // acc += reward * PRECISION / total_lp
    let acc: i128 = env
        .storage()
        .instance()
        .get(&DataKey::AccRewardsPerShare)
        .unwrap_or(0);
    let new_acc = acc + reward * PRECISION / total_lp;
    env.storage()
        .instance()
        .set(&DataKey::AccRewardsPerShare, &new_acc);
    env.storage()
        .instance()
        .set(&DataKey::LastRewardTime, &effective_now);

    // Update distributed counter
    let mut p2 = program;
    p2.distributed_rewards += reward;
    env.storage().instance().set(&DataKey::MiningProgram, &p2);
}

/// Project the accumulated rewards per share WITHOUT mutating state.
/// Used by `pending_rewards`.
fn projected_acc(env: &Env) -> i128 {
    let acc: i128 = env
        .storage()
        .instance()
        .get(&DataKey::AccRewardsPerShare)
        .unwrap_or(0);

    let program_opt: Option<MiningProgramData> =
        env.storage().instance().get(&DataKey::MiningProgram);
    let program = match program_opt {
        Some(p) => p,
        None => return acc,
    };

    let now: u64 = env.ledger().timestamp();
    let last: u64 = env
        .storage()
        .instance()
        .get(&DataKey::LastRewardTime)
        .unwrap_or(program.start_time);

    if now <= last || last >= program.end_time {
        return acc;
    }
    let effective_now = if now > program.end_time {
        program.end_time
    } else {
        now
    };
    let elapsed = (effective_now - last) as i128;

    let total_lp = read_i128(env, &DataKey::TotalLpSupply);
    if total_lp == 0 {
        return acc;
    }

    let remaining = program.total_rewards - program.distributed_rewards;
    let raw_reward = program.reward_per_second * elapsed;
    let reward = if raw_reward > remaining {
        remaining
    } else {
        raw_reward
    };

    if reward <= 0 {
        return acc;
    }

    acc + reward * PRECISION / total_lp
}

#[contract]
pub struct LpPoolContract;

#[contractimpl]
impl LpPoolContract {
    /// Initialize the LP pool.
    pub fn initialize(
        env: Env,
        admin: Address,
        sxlm_token: Address,
        native_token: Address,
        fee_bps: u32,
    ) {
        let already: bool = env
            .storage()
            .instance()
            .get(&DataKey::Initialized)
            .unwrap_or(false);
        if already {
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
            .set(&DataKey::FeeBps, &(fee_bps as i128));
        write_i128(&env, &DataKey::ProtocolFeeBps, 5); // 0.05% of swap input
        write_i128(&env, &DataKey::AccruedProtocolFees, 0);
        extend_instance(&env);
    }

    /// Upgrade the contract WASM. Only callable by admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin = read_admin(&env);
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Bump instance TTL — can be called by anyone to keep contract alive.
    pub fn bump_instance(env: Env) {
        extend_instance(&env);
    }

    // ==========================================================
    // Liquidity mining
    // ==========================================================

    /// Admin: create / replace the active mining program.
    /// `reward_asset` tokens in the amount of `total_rewards` must already
    /// be held by this contract (transfer them before calling this).
    pub fn set_mining_program(
        env: Env,
        reward_asset: Address,
        reward_per_second: i128,
        total_rewards: i128,
        start_time: u64,
        end_time: u64,
    ) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(end_time > start_time, "end_time must be after start_time");
        assert!(
            reward_per_second > 0 && total_rewards > 0,
            "invalid reward params"
        );
        extend_instance(&env);

        // Settle any outstanding rewards under the old program first
        update_pool(&env);

        let program = MiningProgramData {
            reward_asset,
            reward_per_second,
            total_rewards,
            distributed_rewards: 0,
            start_time,
            end_time,
        };
        env.storage()
            .instance()
            .set(&DataKey::MiningProgram, &program);
        env.storage()
            .instance()
            .set(&DataKey::LastRewardTime, &start_time);
        // Reset accumulator for the new program
        env.storage()
            .instance()
            .set(&DataKey::AccRewardsPerShare, &0i128);
    }

    /// View: how many reward tokens has `user` accumulated but not yet claimed?
    pub fn pending_rewards(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let lp = read_lp_balance(&env, &user);
        if lp == 0 {
            return 0;
        }
        let acc = projected_acc(&env);
        let debt = read_reward_debt(&env, &user);
        let pending = lp * acc / PRECISION - debt;
        if pending < 0 {
            0
        } else {
            pending
        }
    }

    /// Claim all pending rewards for `user`. Transfers reward tokens to the user.
    pub fn claim_rewards(env: Env, user: Address) -> i128 {
        user.require_auth();
        extend_instance(&env);

        update_pool(&env);

        let lp = read_lp_balance(&env, &user);
        let acc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccRewardsPerShare)
            .unwrap_or(0);
        let debt = read_reward_debt(&env, &user);
        let earned = if lp > 0 {
            lp * acc / PRECISION - debt
        } else {
            0
        };

        if earned <= 0 {
            // Still update debt to current accumulator
            write_reward_debt(&env, &user, lp * acc / PRECISION);
            return 0;
        }

        let program: MiningProgramData = env
            .storage()
            .instance()
            .get(&DataKey::MiningProgram)
            .expect("no mining program");

        token::Client::new(&env, &program.reward_asset).transfer(
            &env.current_contract_address(),
            &user,
            &earned,
        );

        // Reset debt
        write_reward_debt(&env, &user, lp * acc / PRECISION);

        env.events()
            .publish((soroban_sdk::symbol_short!("rewards"),), (user, earned));

        earned
    }

    // ==========================================================
    // Liquidity
    // ==========================================================

    /// Add liquidity to the pool. Returns LP tokens minted.
    pub fn add_liquidity(env: Env, user: Address, xlm_amount: i128, sxlm_amount: i128) -> i128 {
        user.require_auth();
        assert!(
            xlm_amount > 0 && sxlm_amount > 0,
            "amounts must be positive"
        );
        extend_instance(&env);

        // Settle rewards BEFORE changing LP balance
        update_pool(&env);

        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        let total_lp = read_i128(&env, &DataKey::TotalLpSupply);

        let (actual_xlm, actual_sxlm, lp_minted) = if total_lp == 0 {
            (xlm_amount, sxlm_amount, isqrt(xlm_amount * sxlm_amount))
        } else {
            let lp_from_xlm = xlm_amount * total_lp / reserve_xlm;
            let lp_from_sxlm = sxlm_amount * total_lp / reserve_sxlm;
            if lp_from_xlm < lp_from_sxlm {
                let needed_sxlm = lp_from_xlm * reserve_sxlm / total_lp;
                (xlm_amount, needed_sxlm, lp_from_xlm)
            } else {
                let needed_xlm = lp_from_sxlm * reserve_xlm / total_lp;
                (needed_xlm, sxlm_amount, lp_from_sxlm)
            }
        };
        assert!(lp_minted > 0, "insufficient liquidity minted");
        assert!(actual_xlm > 0 && actual_sxlm > 0, "zero deposit");

        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &native).transfer(
            &user,
            &env.current_contract_address(),
            &actual_xlm,
        );
        token::Client::new(&env, &sxlm).transfer(
            &user,
            &env.current_contract_address(),
            &actual_sxlm,
        );

        write_i128(&env, &DataKey::ReserveXlm, reserve_xlm + actual_xlm);
        write_i128(&env, &DataKey::ReserveSxlm, reserve_sxlm + actual_sxlm);
        write_i128(&env, &DataKey::TotalLpSupply, total_lp + lp_minted);

        let user_lp = read_lp_balance(&env, &user);
        write_lp_balance(&env, &user, user_lp + lp_minted);

        // Update reward debt to current accumulator (user "enters" at current rate)
        let acc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccRewardsPerShare)
            .unwrap_or(0);
        let new_lp = user_lp + lp_minted;
        write_reward_debt(&env, &user, new_lp * acc / PRECISION);

        env.events().publish(
            (soroban_sdk::symbol_short!("add_liq"),),
            (user, actual_xlm, actual_sxlm, lp_minted),
        );

        lp_minted
    }

    /// Remove liquidity from the pool. Returns (xlm_out, sxlm_out).
    pub fn remove_liquidity(env: Env, user: Address, lp_amount: i128) -> (i128, i128) {
        user.require_auth();
        assert!(lp_amount > 0, "amount must be positive");
        extend_instance(&env);

        // Settle rewards BEFORE changing LP balance
        update_pool(&env);

        let user_lp = read_lp_balance(&env, &user);
        assert!(user_lp >= lp_amount, "insufficient LP balance");

        // Auto-claim pending rewards
        let acc: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AccRewardsPerShare)
            .unwrap_or(0);
        let debt = read_reward_debt(&env, &user);
        let earned = user_lp * acc / PRECISION - debt;
        if earned > 0 {
            let program_opt: Option<MiningProgramData> =
                env.storage().instance().get(&DataKey::MiningProgram);
            if let Some(program) = program_opt {
                token::Client::new(&env, &program.reward_asset).transfer(
                    &env.current_contract_address(),
                    &user,
                    &earned,
                );
                env.events().publish(
                    (soroban_sdk::symbol_short!("rewards"),),
                    (user.clone(), earned),
                );
            }
        }

        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        let total_lp = read_i128(&env, &DataKey::TotalLpSupply);

        let xlm_out = lp_amount * reserve_xlm / total_lp;
        let sxlm_out = lp_amount * reserve_sxlm / total_lp;

        assert!(xlm_out > 0 && sxlm_out > 0, "insufficient output");

        write_i128(&env, &DataKey::ReserveXlm, reserve_xlm - xlm_out);
        write_i128(&env, &DataKey::ReserveSxlm, reserve_sxlm - sxlm_out);
        write_i128(&env, &DataKey::TotalLpSupply, total_lp - lp_amount);

        let new_lp = user_lp - lp_amount;
        write_lp_balance(&env, &user, new_lp);
        // Update debt for remaining position
        write_reward_debt(&env, &user, new_lp * acc / PRECISION);

        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &native).transfer(
            &env.current_contract_address(),
            &user,
            &xlm_out,
        );
        token::Client::new(&env, &sxlm).transfer(&env.current_contract_address(), &user, &sxlm_out);

        env.events().publish(
            (soroban_sdk::symbol_short!("rm_liq"),),
            (user, lp_amount, xlm_out, sxlm_out),
        );

        (xlm_out, sxlm_out)
    }

    // ==========================================================
    // Swaps
    // ==========================================================

    /// Swap XLM for sXLM. Returns sXLM received.
    pub fn swap_xlm_to_sxlm(env: Env, user: Address, xlm_amount: i128, min_out: i128) -> i128 {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let fee_bps = read_fee_bps(&env);
        let amount_after_fee = xlm_amount * (BPS_DENOMINATOR - fee_bps) / BPS_DENOMINATOR;

        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        assert!(reserve_xlm > 0 && reserve_sxlm > 0, "pool has no liquidity");

        // x * y = k → sxlm_out = reserve_sxlm - k / (reserve_xlm + amount_after_fee)
        let sxlm_out =
            reserve_sxlm - (reserve_xlm * reserve_sxlm) / (reserve_xlm + amount_after_fee);
        assert!(
            sxlm_out > 0 && sxlm_out < reserve_sxlm,
            "insufficient liquidity"
        );
        assert!(sxlm_out >= min_out, "slippage: output below minimum");

        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &native).transfer(
            &user,
            &env.current_contract_address(),
            &xlm_amount,
        );
        token::Client::new(&env, &sxlm).transfer(&env.current_contract_address(), &user, &sxlm_out);

        let total_fee = xlm_amount - amount_after_fee;
        let protocol_fee_bps = read_i128(&env, &DataKey::ProtocolFeeBps);
        let protocol_cut = total_fee * protocol_fee_bps / fee_bps;

        // Reserve gets full amount MINUS protocol cut
        write_i128(
            &env,
            &DataKey::ReserveXlm,
            reserve_xlm + xlm_amount - protocol_cut,
        );
        write_i128(&env, &DataKey::ReserveSxlm, reserve_sxlm - sxlm_out);

        let accrued = read_i128(&env, &DataKey::AccruedProtocolFees);
        write_i128(&env, &DataKey::AccruedProtocolFees, accrued + protocol_cut);

        env.events().publish(
            (soroban_sdk::symbol_short!("swap"),),
            (user, xlm_amount, sxlm_out),
        );

        sxlm_out
    }

    /// Swap sXLM for XLM. Returns XLM received.
    pub fn swap_sxlm_to_xlm(env: Env, user: Address, sxlm_amount: i128, min_out: i128) -> i128 {
        user.require_auth();
        assert!(sxlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let fee_bps = read_fee_bps(&env);
        let amount_after_fee = sxlm_amount * (BPS_DENOMINATOR - fee_bps) / BPS_DENOMINATOR;

        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        assert!(reserve_xlm > 0 && reserve_sxlm > 0, "pool has no liquidity");

        let xlm_out =
            reserve_xlm - (reserve_xlm * reserve_sxlm) / (reserve_sxlm + amount_after_fee);
        assert!(
            xlm_out > 0 && xlm_out < reserve_xlm,
            "insufficient liquidity"
        );
        assert!(xlm_out >= min_out, "slippage: output below minimum");

        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &sxlm).transfer(
            &user,
            &env.current_contract_address(),
            &sxlm_amount,
        );
        token::Client::new(&env, &native).transfer(
            &env.current_contract_address(),
            &user,
            &xlm_out,
        );

        // Protocol fee: split the sXLM swap fee between LPs and protocol,
        // mirroring the logic in swap_xlm_to_sxlm.
        let total_fee = sxlm_amount - amount_after_fee;
        let protocol_fee_bps = read_i128(&env, &DataKey::ProtocolFeeBps);
        let protocol_cut = total_fee * protocol_fee_bps / fee_bps;

        // Reserve gets full sxlm_amount MINUS protocol cut (LPs keep the rest of the fee)
        write_i128(
            &env,
            &DataKey::ReserveSxlm,
            reserve_sxlm + sxlm_amount - protocol_cut,
        );
        write_i128(&env, &DataKey::ReserveXlm, reserve_xlm - xlm_out);

        let accrued = read_i128(&env, &DataKey::AccruedProtocolFeesSxlm);
        write_i128(&env, &DataKey::AccruedProtocolFeesSxlm, accrued + protocol_cut);

        env.events().publish(
            (soroban_sdk::symbol_short!("swap"),),
            (user, sxlm_amount, xlm_out),
        );

        xlm_out
    }

    // ==========================================================
    // Protocol fee management
    // ==========================================================

    /// Collect accrued protocol fees. Admin-only.
    pub fn collect_protocol_fees(env: Env) -> i128 {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);

        let accrued = read_i128(&env, &DataKey::AccruedProtocolFees);
        if accrued <= 0 {
            return 0;
        }

        let native = read_native_token(&env);
        token::Client::new(&env, &native).transfer(
            &env.current_contract_address(),
            &admin,
            &accrued,
        );

        write_i128(&env, &DataKey::AccruedProtocolFees, 0);

        env.events()
            .publish((soroban_sdk::symbol_short!("pf_col"),), (admin, accrued));

        accrued
    }

    /// Collect accrued sXLM protocol fees from sXLM→XLM swaps. Admin-only.
    pub fn collect_protocol_fees_sxlm(env: Env) -> i128 {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);

        let accrued = read_i128(&env, &DataKey::AccruedProtocolFeesSxlm);
        if accrued <= 0 {
            return 0;
        }

        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &sxlm).transfer(
            &env.current_contract_address(),
            &admin,
            &accrued,
        );

        write_i128(&env, &DataKey::AccruedProtocolFeesSxlm, 0);

        env.events()
            .publish((soroban_sdk::symbol_short!("pf_col"),), (admin, accrued));

        accrued
    }

    /// Set protocol fee in basis points.
    pub fn set_protocol_fee_bps(env: Env, bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        write_i128(&env, &DataKey::ProtocolFeeBps, bps as i128);
    }

    // --- Views ---

    pub fn accrued_protocol_fees(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::AccruedProtocolFees)
    }

    /// View accrued sXLM protocol fees from sXLM→XLM swaps.
    pub fn accrued_protocol_fees_sxlm(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::AccruedProtocolFeesSxlm)
    }

    pub fn protocol_fee_bps(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::ProtocolFeeBps)
    }

    pub fn get_reserves(env: Env) -> (i128, i128) {
        extend_instance(&env);
        (
            read_i128(&env, &DataKey::ReserveXlm),
            read_i128(&env, &DataKey::ReserveSxlm),
        )
    }

    pub fn get_price(env: Env) -> i128 {
        extend_instance(&env);
        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        if reserve_sxlm == 0 {
            return 10_000_000;
        }
        reserve_xlm * 10_000_000 / reserve_sxlm
    }

    pub fn get_lp_balance(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        extend_lp_balance(&env, &user);
        read_lp_balance(&env, &user)
    }

    pub fn total_lp_supply(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::TotalLpSupply)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
    use soroban_sdk::{token::StellarAssetClient, Env};

    fn setup_test() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();

        let contract_id = env.register_contract(None, LpPoolContract);
        let client = LpPoolContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &30);

        StellarAssetClient::new(&env, &sxlm_id).mint(&user, &1_000_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&user, &1_000_000_0000000);

        (env, contract_id, sxlm_id, native_id, user, admin)
    }

    fn advance_time(env: &Env, seconds: u64) {
        let current = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp: current + seconds,
            protocol_version: env.ledger().protocol_version(),
            sequence_number: env.ledger().sequence(),
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 10_000_000,
        });
    }

    // ---- existing tests ----

    #[test]
    fn test_initialize() {
        let (env, contract_id, _, _, _, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);
        let (rx, rs) = client.get_reserves();
        assert_eq!(rx, 0);
        assert_eq!(rs, 0);
        assert_eq!(client.total_lp_supply(), 0);
    }

    #[test]
    fn test_add_liquidity_first() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        let lp = client.add_liquidity(&user, &10_000_0000000, &10_000_0000000);
        assert!(lp > 0);
        assert_eq!(client.get_lp_balance(&user), lp);
        assert_eq!(client.total_lp_supply(), lp);

        let (rx, rs) = client.get_reserves();
        assert_eq!(rx, 10_000_0000000);
        assert_eq!(rs, 10_000_0000000);
    }

    #[test]
    fn test_add_and_remove_liquidity() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        let lp = client.add_liquidity(&user, &10_000_0000000, &10_000_0000000);
        let (xlm_out, sxlm_out) = client.remove_liquidity(&user, &(lp / 2));
        assert!(xlm_out > 0);
        assert!(sxlm_out > 0);

        let (rx, rs) = client.get_reserves();
        assert!(rx > 0);
        assert!(rs > 0);
    }

    #[test]
    fn test_swap_xlm_to_sxlm() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        let sxlm_out = client.swap_xlm_to_sxlm(&user, &1_000_0000000, &0);
        assert!(sxlm_out > 0);
        assert!(sxlm_out < 1_000_0000000);
    }

    #[test]
    fn test_swap_sxlm_to_xlm() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        let xlm_out = client.swap_sxlm_to_xlm(&user, &1_000_0000000, &0);
        assert!(xlm_out > 0);
        assert!(xlm_out < 1_000_0000000);
    }

    #[test]
    fn test_get_price() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        let price = client.get_price();
        assert_eq!(price, 10_000_000);
    }

    #[test]
    fn test_price_changes_after_swap() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        client.swap_xlm_to_sxlm(&user, &10_000_0000000, &0);
        let price = client.get_price();
        assert!(price > 10_000_000);
    }

    #[test]
    fn test_constant_product_invariant() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        let (rx0, rs0) = client.get_reserves();
        let k_before = rx0 * rs0;

        client.swap_xlm_to_sxlm(&user, &5_000_0000000, &0);
        let (rx1, rs1) = client.get_reserves();
        let k_after = rx1 * rs1;

        assert!(k_after >= k_before);
    }

    #[test]
    fn test_protocol_fee_collection() {
        let (env, contract_id, _, native_id, user, admin) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);

        assert_eq!(client.accrued_protocol_fees(), 0);
        assert_eq!(client.protocol_fee_bps(), 5);

        client.swap_xlm_to_sxlm(&user, &10_000_0000000, &0);

        let accrued = client.accrued_protocol_fees();
        assert!(accrued > 0, "protocol fees should accrue on XLM→sXLM swap");
        assert_eq!(accrued, 5_0000000);

        let admin_balance_before = token::Client::new(&env, &native_id).balance(&admin);
        let collected = client.collect_protocol_fees();
        let admin_balance_after = token::Client::new(&env, &native_id).balance(&admin);

        assert_eq!(collected, accrued);
        assert_eq!(admin_balance_after - admin_balance_before, accrued);
        assert_eq!(client.accrued_protocol_fees(), 0);
    }

    #[test]
    fn test_sxlm_to_xlm_protocol_fee() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        assert_eq!(client.accrued_protocol_fees_sxlm(), 0);

        client.swap_sxlm_to_xlm(&user, &10_000_0000000, &0);

        let accrued = client.accrued_protocol_fees_sxlm();
        assert!(accrued > 0, "sXLM protocol fees should accrue on sXLM→XLM swap");
        // fee = 10_000 × 0.3% = 30 sXLM; protocol cut = 30 × 5/30 = 5 sXLM
        assert_eq!(accrued, 5_0000000);
        // XLM protocol fees should remain 0 (only sXLM fees accrue here)
        assert_eq!(client.accrued_protocol_fees(), 0);
    }

    #[test]
    fn test_sxlm_protocol_fee_collection() {
        let (env, contract_id, sxlm_id, _, user, admin) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        client.swap_sxlm_to_xlm(&user, &10_000_0000000, &0);

        let accrued = client.accrued_protocol_fees_sxlm();
        assert!(accrued > 0);

        let admin_balance_before = token::Client::new(&env, &sxlm_id).balance(&admin);
        let collected = client.collect_protocol_fees_sxlm();
        let admin_balance_after = token::Client::new(&env, &sxlm_id).balance(&admin);

        assert_eq!(collected, accrued);
        assert_eq!(admin_balance_after - admin_balance_before, accrued);
        assert_eq!(client.accrued_protocol_fees_sxlm(), 0);
    }

    // ---- liquidity mining tests ----

    #[test]
    fn test_no_program_returns_zero_pending() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);
        client.add_liquidity(&user, &10_000_0000000, &10_000_0000000);
        // No mining program set
        assert_eq!(client.pending_rewards(&user), 0);
    }

    #[test]
    fn test_rewards_accrue_over_time() {
        let (env, contract_id, sxlm_id, _, user, _admin) = setup_test();
        let reward_id = sxlm_id;

        let client = LpPoolContractClient::new(&env, &contract_id);
        client.add_liquidity(&user, &10_000_0000000, &10_000_0000000);

        // Setup mining AFTER adding liquidity (debt is set to 0 at that point)
        let reward_amount: i128 = 1_000_000_0000000;
        StellarAssetClient::new(&env, &reward_id).mint(&contract_id, &reward_amount);
        let now = env.ledger().timestamp();
        client.set_mining_program(
            &reward_id,
            &1_0000000i128,
            &reward_amount,
            &now,
            &(now + 86_400 * 365),
        );

        // Advance 100 seconds
        advance_time(&env, 100);

        let pending = client.pending_rewards(&user);
        // 100 sec × 1_0000000 stroops/sec = 100_0000000 stroops expected
        assert!(pending > 0, "rewards should have accrued");
        assert_eq!(pending, 100 * 1_0000000);
    }

    #[test]
    fn test_two_users_proportional_rewards() {
        let (env, contract_id, sxlm_id, native_id, user, _admin) = setup_test();
        let user2 = Address::generate(&env);
        // Mint both tokens to user2
        StellarAssetClient::new(&env, &native_id).mint(&user2, &1_000_000_0000000);
        StellarAssetClient::new(&env, &sxlm_id).mint(&user2, &1_000_000_0000000);

        // Use native_id as the reward asset
        let reward_id = native_id.clone();

        let client = LpPoolContractClient::new(&env, &contract_id);

        // Both users add equal liquidity
        client.add_liquidity(&user, &10_000_0000000, &10_000_0000000);
        client.add_liquidity(&user2, &10_000_0000000, &10_000_0000000);

        let reward_amount: i128 = 1_000_000_0000000;
        StellarAssetClient::new(&env, &reward_id).mint(&contract_id, &reward_amount);
        let now = env.ledger().timestamp();
        client.set_mining_program(
            &reward_id,
            &2_0000000i128, // 2 tokens/sec
            &reward_amount,
            &now,
            &(now + 86_400 * 365),
        );

        advance_time(&env, 100);

        let pending1 = client.pending_rewards(&user);
        let pending2 = client.pending_rewards(&user2);

        // Each should get ~half of 200 tokens (100 tokens each)
        assert!(pending1 > 0 && pending2 > 0);
        // Allow 1 stroop rounding difference
        assert!((pending1 - pending2).abs() <= 1);
        // Total ≈ 200 * 1_0000000
        assert_eq!(pending1 + pending2, 200 * 1_0000000);
    }

    #[test]
    fn test_rewards_stop_after_end_time() {
        let (env, contract_id, sxlm_id, _, user, _admin) = setup_test();
        let reward_id = sxlm_id;
        let client = LpPoolContractClient::new(&env, &contract_id);
        client.add_liquidity(&user, &10_000_0000000, &10_000_0000000);

        let reward_amount: i128 = 100_0000000; // only 100 tokens total
        StellarAssetClient::new(&env, &reward_id).mint(&contract_id, &reward_amount);
        let now = env.ledger().timestamp();
        client.set_mining_program(
            &reward_id,
            &1_0000000i128,
            &reward_amount,
            &now,
            &(now + 100), // program ends in 100 seconds
        );

        // Advance well past end
        advance_time(&env, 1000);

        let pending = client.pending_rewards(&user);
        // Capped at 100 tokens (100 sec × 1 token/sec)
        assert_eq!(pending, 100_0000000);
    }

    #[test]
    fn test_claim_rewards_transfers_tokens() {
        let (env, contract_id, sxlm_id, _, user, _admin) = setup_test();
        let reward_id = sxlm_id.clone();
        let client = LpPoolContractClient::new(&env, &contract_id);
        client.add_liquidity(&user, &10_000_0000000, &10_000_0000000);

        let reward_amount: i128 = 1_000_000_0000000;
        StellarAssetClient::new(&env, &reward_id).mint(&contract_id, &reward_amount);
        let now = env.ledger().timestamp();
        client.set_mining_program(
            &reward_id,
            &1_0000000i128,
            &reward_amount,
            &now,
            &(now + 86_400 * 365),
        );

        advance_time(&env, 50);

        let balance_before = token::Client::new(&env, &reward_id).balance(&user);
        let claimed = client.claim_rewards(&user);
        let balance_after = token::Client::new(&env, &reward_id).balance(&user);

        assert_eq!(claimed, 50 * 1_0000000);
        assert_eq!(balance_after - balance_before, claimed);

        // Pending should reset to 0 (or near 0) after claim
        let pending_after = client.pending_rewards(&user);
        assert_eq!(pending_after, 0);
    }
}

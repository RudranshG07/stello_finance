#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

const BPS_DENOMINATOR: i128 = 10_000;

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;        // bump to ~30 days
const LP_LIFETIME_THRESHOLD: u32 = 518_400;       // ~30 days
const LP_BUMP_AMOUNT: u32 = 3_110_400;            // bump to ~180 days

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
    // TWAP Oracle accumulators
    Price0CumulativeLast,      // cumulative price of sXLM in XLM
    Price1CumulativeLast,      // cumulative price of XLM in sXLM
    BlockTimestampLast,        // last timestamp when accumulators were updated
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
    env.storage()
        .instance()
        .get(&DataKey::FeeBps)
        .unwrap_or(30) // 0.3%
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

/// Update cumulative price accumulators for TWAP.
/// Called after every state update (swaps, liquidity changes).
fn update_price_cumulative(env: &Env, reserve_xlm: i128, reserve_sxlm: i128) {
    let timestamp: u64 = env.ledger().timestamp();
    let last_timestamp: u64 = env.storage().instance()
        .get(&DataKey::BlockTimestampLast)
        .unwrap_or(0);
    
    let elapsed = timestamp.saturating_sub(last_timestamp);
    
    // Only update if time has passed and reserves are valid
    if elapsed > 0 && reserve_xlm > 0 && reserve_sxlm > 0 {
        // Price0 = sXLM per XLM (reserve_sxlm / reserve_xlm, scaled by 1e7 for precision)
        let price0 = (reserve_sxlm as i128 * 10_000_000) / (reserve_xlm as i128);
        
        // Price1 = XLM per sXLM (reserve_xlm / reserve_sxlm, scaled by 1e7)
        let price1 = (reserve_xlm as i128 * 10_000_000) / (reserve_sxlm as i128);
        
        let price0_cum_last: i128 = env.storage().instance()
            .get(&DataKey::Price0CumulativeLast)
            .unwrap_or(0);
        let price1_cum_last: i128 = env.storage().instance()
            .get(&DataKey::Price1CumulativeLast)
            .unwrap_or(0);
        
        let elapsed_i128 = elapsed as i128;
        
        env.storage().instance().set(
            &DataKey::Price0CumulativeLast,
            &(price0_cum_last + price0 * elapsed_i128),
        );
        env.storage().instance().set(
            &DataKey::Price1CumulativeLast,
            &(price1_cum_last + price1 * elapsed_i128),
        );
    }
    
    env.storage().instance().set(&DataKey::BlockTimestampLast, &timestamp);
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
        let already: bool = env.storage().instance().get(&DataKey::Initialized).unwrap_or(false);
        if already {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SxlmToken, &sxlm_token);
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage().instance().set(&DataKey::FeeBps, &(fee_bps as i128));
        write_i128(&env, &DataKey::ProtocolFeeBps, 5); // 0.05% of swap input
        write_i128(&env, &DataKey::AccruedProtocolFees, 0);
        
        // Initialize TWAP accumulators
        write_i128(&env, &DataKey::Price0CumulativeLast, 0);
        write_i128(&env, &DataKey::Price1CumulativeLast, 0);
        env.storage().instance().set(&DataKey::BlockTimestampLast, &env.ledger().timestamp());
        
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

    /// Add liquidity to the pool. Returns LP tokens minted.
    /// Only transfers the proportional amounts needed; excess stays with the user.
    pub fn add_liquidity(env: Env, user: Address, xlm_amount: i128, sxlm_amount: i128) -> i128 {
        user.require_auth();
        assert!(xlm_amount > 0 && sxlm_amount > 0, "amounts must be positive");
        extend_instance(&env);

        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        let total_lp = read_i128(&env, &DataKey::TotalLpSupply);

        // Calculate actual amounts and LP tokens
        let (actual_xlm, actual_sxlm, lp_minted) = if total_lp == 0 {
            // First deposit: use both amounts as-is
            (xlm_amount, sxlm_amount, isqrt(xlm_amount * sxlm_amount))
        } else {
            // Proportional: use the limiting side, compute the other
            let lp_from_xlm = xlm_amount * total_lp / reserve_xlm;
            let lp_from_sxlm = sxlm_amount * total_lp / reserve_sxlm;
            if lp_from_xlm < lp_from_sxlm {
                // XLM is the limiting factor
                let needed_sxlm = lp_from_xlm * reserve_sxlm / total_lp;
                (xlm_amount, needed_sxlm, lp_from_xlm)
            } else {
                // sXLM is the limiting factor
                let needed_xlm = lp_from_sxlm * reserve_xlm / total_lp;
                (needed_xlm, sxlm_amount, lp_from_sxlm)
            }
        };
        assert!(lp_minted > 0, "insufficient liquidity minted");
        assert!(actual_xlm > 0 && actual_sxlm > 0, "zero deposit");

        // Only transfer the amounts actually needed (no excess taken)
        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &native).transfer(&user, &env.current_contract_address(), &actual_xlm);
        token::Client::new(&env, &sxlm).transfer(&user, &env.current_contract_address(), &actual_sxlm);

        // Update state with actual amounts
        write_i128(&env, &DataKey::ReserveXlm, reserve_xlm + actual_xlm);
        write_i128(&env, &DataKey::ReserveSxlm, reserve_sxlm + actual_sxlm);
        write_i128(&env, &DataKey::TotalLpSupply, total_lp + lp_minted);

        // Update TWAP accumulators AFTER reserve changes
        update_price_cumulative(&env, reserve_xlm + actual_xlm, reserve_sxlm + actual_sxlm);

        let user_lp = read_lp_balance(&env, &user);
        write_lp_balance(&env, &user, user_lp + lp_minted);

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

        let user_lp = read_lp_balance(&env, &user);
        assert!(user_lp >= lp_amount, "insufficient LP balance");

        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        let total_lp = read_i128(&env, &DataKey::TotalLpSupply);

        let xlm_out = lp_amount * reserve_xlm / total_lp;
        let sxlm_out = lp_amount * reserve_sxlm / total_lp;

        assert!(xlm_out > 0 && sxlm_out > 0, "insufficient output");

        // Update state
        write_i128(&env, &DataKey::ReserveXlm, reserve_xlm - xlm_out);
        write_i128(&env, &DataKey::ReserveSxlm, reserve_sxlm - sxlm_out);
        write_i128(&env, &DataKey::TotalLpSupply, total_lp - lp_amount);
        write_lp_balance(&env, &user, user_lp - lp_amount);

        // Update TWAP accumulators AFTER reserve changes
        update_price_cumulative(&env, reserve_xlm - xlm_out, reserve_sxlm - sxlm_out);

        // Transfer tokens out
        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &native).transfer(&env.current_contract_address(), &user, &xlm_out);
        token::Client::new(&env, &sxlm).transfer(&env.current_contract_address(), &user, &sxlm_out);

        env.events().publish(
            (soroban_sdk::symbol_short!("rm_liq"),),
            (user, lp_amount, xlm_out, sxlm_out),
        );

        (xlm_out, sxlm_out)
    }

    /// Swap XLM for sXLM. Returns sXLM received. min_out provides slippage protection.
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
        let sxlm_out = reserve_sxlm - (reserve_xlm * reserve_sxlm) / (reserve_xlm + amount_after_fee);
        assert!(sxlm_out > 0 && sxlm_out < reserve_sxlm, "insufficient liquidity");
        assert!(sxlm_out >= min_out, "slippage: output below minimum");

        // Transfer
        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &native).transfer(&user, &env.current_contract_address(), &xlm_amount);
        token::Client::new(&env, &sxlm).transfer(&env.current_contract_address(), &user, &sxlm_out);

        // Protocol fee: carve out a portion of the LP fee for the protocol
        let total_fee = xlm_amount - amount_after_fee;
        let protocol_fee_bps = read_i128(&env, &DataKey::ProtocolFeeBps);
        let protocol_cut = total_fee * protocol_fee_bps / fee_bps;

        // Reserve gets full amount MINUS protocol cut
        let new_reserve_xlm = reserve_xlm + xlm_amount - protocol_cut;
        let new_reserve_sxlm = reserve_sxlm - sxlm_out;
        write_i128(&env, &DataKey::ReserveXlm, new_reserve_xlm);
        write_i128(&env, &DataKey::ReserveSxlm, new_reserve_sxlm);

        // Update TWAP accumulators AFTER reserve changes
        update_price_cumulative(&env, new_reserve_xlm, new_reserve_sxlm);

        // Accumulate protocol fees
        let accrued = read_i128(&env, &DataKey::AccruedProtocolFees);
        write_i128(&env, &DataKey::AccruedProtocolFees, accrued + protocol_cut);

        env.events().publish(
            (soroban_sdk::symbol_short!("swap"),),
            (user, xlm_amount, sxlm_out),
        );

        sxlm_out
    }

    /// Swap sXLM for XLM. Returns XLM received. min_out provides slippage protection.
    pub fn swap_sxlm_to_xlm(env: Env, user: Address, sxlm_amount: i128, min_out: i128) -> i128 {
        user.require_auth();
        assert!(sxlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let fee_bps = read_fee_bps(&env);
        let amount_after_fee = sxlm_amount * (BPS_DENOMINATOR - fee_bps) / BPS_DENOMINATOR;

        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        assert!(reserve_xlm > 0 && reserve_sxlm > 0, "pool has no liquidity");

        let xlm_out = reserve_xlm - (reserve_xlm * reserve_sxlm) / (reserve_sxlm + amount_after_fee);
        assert!(xlm_out > 0 && xlm_out < reserve_xlm, "insufficient liquidity");
        assert!(xlm_out >= min_out, "slippage: output below minimum");

        // Transfer
        let native = read_native_token(&env);
        let sxlm = read_sxlm_token(&env);
        token::Client::new(&env, &sxlm).transfer(&user, &env.current_contract_address(), &sxlm_amount);
        token::Client::new(&env, &native).transfer(&env.current_contract_address(), &user, &xlm_out);

        // Update reserves
        let new_reserve_sxlm = reserve_sxlm + sxlm_amount;
        let new_reserve_xlm = reserve_xlm - xlm_out;
        write_i128(&env, &DataKey::ReserveSxlm, new_reserve_sxlm);
        write_i128(&env, &DataKey::ReserveXlm, new_reserve_xlm);

        // Update TWAP accumulators AFTER reserve changes
        update_price_cumulative(&env, new_reserve_xlm, new_reserve_sxlm);

        env.events().publish(
            (soroban_sdk::symbol_short!("swap"),),
            (user, sxlm_amount, xlm_out),
        );

        xlm_out
    }

    // ==========================================================
    // Protocol fee management
    // ==========================================================

    /// Collect accrued protocol fees. Admin-only. Transfers XLM to admin and resets counter.
    pub fn collect_protocol_fees(env: Env) -> i128 {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);

        let accrued = read_i128(&env, &DataKey::AccruedProtocolFees);
        if accrued <= 0 {
            return 0;
        }

        let native = read_native_token(&env);
        token::Client::new(&env, &native).transfer(&env.current_contract_address(), &admin, &accrued);

        write_i128(&env, &DataKey::AccruedProtocolFees, 0);

        env.events().publish(
            (soroban_sdk::symbol_short!("pf_col"),),
            (admin, accrued),
        );

        accrued
    }

    /// Set protocol fee in basis points (portion of LP fee taken for protocol).
    pub fn set_protocol_fee_bps(env: Env, bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        write_i128(&env, &DataKey::ProtocolFeeBps, bps as i128);
    }

    // --- Views ---

    /// Returns accrued protocol fees in XLM stroops.
    pub fn accrued_protocol_fees(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::AccruedProtocolFees)
    }

    /// Returns protocol fee in basis points.
    pub fn protocol_fee_bps(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::ProtocolFeeBps)
    }

    /// Returns (reserve_xlm, reserve_sxlm).
    pub fn get_reserves(env: Env) -> (i128, i128) {
        extend_instance(&env);
        (
            read_i128(&env, &DataKey::ReserveXlm),
            read_i128(&env, &DataKey::ReserveSxlm),
        )
    }

    /// Returns price of sXLM in XLM (scaled by 1e7).
    pub fn get_price(env: Env) -> i128 {
        extend_instance(&env);
        let reserve_xlm = read_i128(&env, &DataKey::ReserveXlm);
        let reserve_sxlm = read_i128(&env, &DataKey::ReserveSxlm);
        if reserve_sxlm == 0 {
            return 10_000_000; // 1:1 default
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

    /// Returns TWAP data: (price0_cumulative, price1_cumulative, block_timestamp_last)
    /// Used by off-chain oracle to calculate time-weighted average prices.
    /// Price0 = cumulative sXLM per XLM (scaled by 1e7)
    /// Price1 = cumulative XLM per sXLM (scaled by 1e7)
    pub fn get_twap_data(env: Env) -> (i128, i128, u64) {
        extend_instance(&env);
        let p0 = read_i128(&env, &DataKey::Price0CumulativeLast);
        let p1 = read_i128(&env, &DataKey::Price1CumulativeLast);
        let timestamp: u64 = env.storage().instance()
            .get(&DataKey::BlockTimestampLast)
            .unwrap_or(0);
        (p0, p1, timestamp)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token::StellarAssetClient, Env};

    fn setup_test() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        let contract_id = env.register_contract(None, LpPoolContract);
        let client = LpPoolContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &30);

        // Mint tokens to user
        StellarAssetClient::new(&env, &sxlm_id).mint(&user, &1_000_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&user, &1_000_000_0000000);

        (env, contract_id, sxlm_id, native_id, user, admin)
    }

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

        // Remove half
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

        // Add liquidity first
        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);

        // Swap 1000 XLM for sXLM
        let sxlm_out = client.swap_xlm_to_sxlm(&user, &1_000_0000000, &0);
        assert!(sxlm_out > 0);
        // Due to constant product, should be slightly less than 1000
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
        assert_eq!(price, 10_000_000); // 1:1
    }

    #[test]
    fn test_price_changes_after_swap() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);

        // Swap XLM → sXLM (more XLM in pool, less sXLM)
        client.swap_xlm_to_sxlm(&user, &10_000_0000000, &0);

        let price = client.get_price();
        // sXLM should now be worth more XLM
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

        // k should increase (fees stay in pool)
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
    fn test_sxlm_to_xlm_no_protocol_fee() {
        let (env, contract_id, _, _, user, _) = setup_test();
        let client = LpPoolContractClient::new(&env, &contract_id);

        client.add_liquidity(&user, &100_000_0000000, &100_000_0000000);
        client.swap_sxlm_to_xlm(&user, &10_000_0000000, &0);
        assert_eq!(client.accrued_protocol_fees(), 0);
    }
}

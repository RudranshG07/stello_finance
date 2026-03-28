#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

const BPS_DENOMINATOR: i128 = 10_000;
const RATE_PRECISION: i128 = 10_000_000; // 1e7
const DEFAULT_LIQUIDATION_BONUS_BPS: i128 = 500; // 5% bonus

// ---------- TTL constants ----------
// Testnet: ~5s per ledger
// 30 days  ≈  518_400 ledgers
// 180 days ≈ 3_110_400 ledgers
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;        // bump to ~30 days
const USER_LIFETIME_THRESHOLD: u32 = 518_400;     // ~30 days
const USER_BUMP_AMOUNT: u32 = 3_110_400;          // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    SxlmToken,
    NativeToken,
    CollateralFactorBps,
    LiquidationThresholdBps,
    BorrowRateBps,
    LiquidationBonusBps,
    ExchangeRate, // sXLM → XLM rate (scaled by RATE_PRECISION)
    Initialized,
    TotalCollateral,
    TotalBorrowed,
    Collateral(Address),
    Borrowed(Address),
    // Multi-asset collateral whitelist
    AssetCf(Address),                  // asset → collateral factor bps (0 = not whitelisted)
    AssetCollateral(Address, Address),  // (asset, user) → balance
    AssetTotalCollateral(Address),      // asset → total across all users
}

// --- Storage helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_user_data(env: &Env, user: &Address) {
    let col_key = DataKey::Collateral(user.clone());
    let bor_key = DataKey::Borrowed(user.clone());
    if env.storage().persistent().has(&col_key) {
        env.storage()
            .persistent()
            .extend_ttl(&col_key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
    if env.storage().persistent().has(&bor_key) {
        env.storage()
            .persistent()
            .extend_ttl(&bor_key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
}

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

fn read_collateral_factor(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::CollateralFactorBps)
        .unwrap_or(7000) // 70% default
}

fn read_liquidation_threshold(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LiquidationThresholdBps)
        .unwrap_or(8000) // 80% default
}

fn read_liquidation_bonus(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LiquidationBonusBps)
        .unwrap_or(DEFAULT_LIQUIDATION_BONUS_BPS)
}

fn read_exchange_rate(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::ExchangeRate)
        .unwrap_or(RATE_PRECISION) // 1:1 default
}

fn read_user_collateral(env: &Env, user: &Address) -> i128 {
    let key = DataKey::Collateral(user.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
    val
}

fn write_user_collateral(env: &Env, user: &Address, val: i128) {
    let key = DataKey::Collateral(user.clone());
    env.storage().persistent().set(&key, &val);
    env.storage()
        .persistent()
        .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
}

fn read_user_borrowed(env: &Env, user: &Address) -> i128 {
    let key = DataKey::Borrowed(user.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
    val
}

fn write_user_borrowed(env: &Env, user: &Address, val: i128) {
    let key = DataKey::Borrowed(user.clone());
    env.storage().persistent().set(&key, &val);
    env.storage()
        .persistent()
        .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
}

/// Health Factor = (collateral × exchange_rate × collateral_factor_bps) / (BPS × RATE_PRECISION × borrowed)
/// Returns HF scaled by RATE_PRECISION (so 1.0 = RATE_PRECISION)
fn compute_health_factor(collateral: i128, borrowed: i128, cf_bps: i128, exchange_rate: i128) -> i128 {
    if borrowed == 0 {
        return i128::MAX; // No debt = infinite health
    }
    // HF = (collateral * exchange_rate * cf_bps) / (BPS_DENOMINATOR * RATE_PRECISION * borrowed) * RATE_PRECISION
    // Simplified: (collateral * exchange_rate * cf_bps) / (BPS_DENOMINATOR * borrowed)
    (collateral * exchange_rate * cf_bps) / (BPS_DENOMINATOR * borrowed)
}

#[contract]
pub struct LendingContract;

#[contractimpl]
impl LendingContract {
    /// Initialize the lending contract.
    pub fn initialize(
        env: Env,
        admin: Address,
        sxlm_token: Address,
        native_token: Address,
        collateral_factor_bps: u32,
        liquidation_threshold_bps: u32,
        borrow_rate_bps: u32,
    ) {
        let already: bool = env.storage().instance().get(&DataKey::Initialized).unwrap_or(false);
        if already {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SxlmToken, &sxlm_token);
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage().instance().set(&DataKey::CollateralFactorBps, &(collateral_factor_bps as i128));
        env.storage().instance().set(&DataKey::LiquidationThresholdBps, &(liquidation_threshold_bps as i128));
        env.storage().instance().set(&DataKey::BorrowRateBps, &(borrow_rate_bps as i128));
        env.storage().instance().set(&DataKey::LiquidationBonusBps, &DEFAULT_LIQUIDATION_BONUS_BPS);
        env.storage().instance().set(&DataKey::ExchangeRate, &RATE_PRECISION); // 1:1 initial
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
    // Admin setters (for governance)
    // ==========================================================

    /// Update the sXLM → XLM exchange rate. Only callable by admin.
    pub fn update_exchange_rate(env: Env, rate: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(rate > 0, "rate must be positive");
        extend_instance(&env);
        env.storage().instance().set(&DataKey::ExchangeRate, &rate);

        env.events().publish(
            (soroban_sdk::symbol_short!("er_upd"),),
            rate,
        );
    }

    /// Update the collateral factor. Only callable by admin.
    pub fn update_collateral_factor(env: Env, new_cf_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(new_cf_bps > 0 && new_cf_bps <= 10000, "invalid collateral factor");
        extend_instance(&env);
        env.storage().instance().set(&DataKey::CollateralFactorBps, &(new_cf_bps as i128));

        env.events().publish(
            (soroban_sdk::symbol_short!("cf_upd"),),
            new_cf_bps,
        );
    }

    /// Update the liquidation threshold. Only callable by admin.
    pub fn update_liquidation_threshold(env: Env, new_lt_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(new_lt_bps > 0 && new_lt_bps <= 10000, "invalid liquidation threshold");
        extend_instance(&env);
        env.storage().instance().set(&DataKey::LiquidationThresholdBps, &(new_lt_bps as i128));
    }

    /// Update the borrow rate. Only callable by admin.
    pub fn update_borrow_rate(env: Env, new_rate_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::BorrowRateBps, &(new_rate_bps as i128));
    }

    // ==========================================================
    // Core lending functions
    // ==========================================================

    /// Deposit sXLM as collateral.
    pub fn deposit_collateral(env: Env, user: Address, sxlm_amount: i128) {
        user.require_auth();
        assert!(sxlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let sxlm = read_sxlm_token(&env);
        let sxlm_client = token::Client::new(&env, &sxlm);
        sxlm_client.transfer(&user, &env.current_contract_address(), &sxlm_amount);

        let current = read_user_collateral(&env, &user);
        write_user_collateral(&env, &user, current + sxlm_amount);

        let total = read_i128(&env, &DataKey::TotalCollateral);
        write_i128(&env, &DataKey::TotalCollateral, total + sxlm_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (user, sxlm_amount),
        );
    }

    /// Withdraw sXLM collateral if health factor stays above 1.0.
    pub fn withdraw_collateral(env: Env, user: Address, sxlm_amount: i128) {
        user.require_auth();
        assert!(sxlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let current = read_user_collateral(&env, &user);
        assert!(current >= sxlm_amount, "insufficient collateral");

        let new_collateral = current - sxlm_amount;
        let borrowed = read_user_borrowed(&env, &user);
        let cf_bps = read_collateral_factor(&env);
        let er = read_exchange_rate(&env);

        if borrowed > 0 {
            let hf = compute_health_factor(new_collateral, borrowed, cf_bps, er);
            assert!(hf >= RATE_PRECISION, "withdrawal would make position unhealthy");
        }

        write_user_collateral(&env, &user, new_collateral);

        let total = read_i128(&env, &DataKey::TotalCollateral);
        write_i128(&env, &DataKey::TotalCollateral, total - sxlm_amount);

        let sxlm = read_sxlm_token(&env);
        let sxlm_client = token::Client::new(&env, &sxlm);
        sxlm_client.transfer(&env.current_contract_address(), &user, &sxlm_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("withdraw"),),
            (user, sxlm_amount),
        );
    }

    /// Borrow XLM against deposited sXLM collateral.
    pub fn borrow(env: Env, user: Address, xlm_amount: i128) {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let collateral = read_user_collateral(&env, &user);
        let current_borrowed = read_user_borrowed(&env, &user);
        let new_borrowed = current_borrowed + xlm_amount;
        let cf_bps = read_collateral_factor(&env);
        let er = read_exchange_rate(&env);

        // max_borrow = collateral * exchange_rate * cf_bps / (BPS_DENOMINATOR * RATE_PRECISION)
        let max_borrow = collateral * er * cf_bps / (BPS_DENOMINATOR * RATE_PRECISION);
        assert!(new_borrowed <= max_borrow, "borrow exceeds collateral limit");

        write_user_borrowed(&env, &user, new_borrowed);

        let total = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total + xlm_amount);

        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);

        // Solvency check: ensure the pool has enough XLM to lend
        let pool_balance = native_client.balance(&env.current_contract_address());
        assert!(pool_balance >= xlm_amount, "insufficient pool liquidity");

        native_client.transfer(&env.current_contract_address(), &user, &xlm_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("borrow"),),
            (user, xlm_amount),
        );
    }

    /// Repay borrowed XLM.
    pub fn repay(env: Env, user: Address, xlm_amount: i128) {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let borrowed = read_user_borrowed(&env, &user);
        let repay_amount = if xlm_amount > borrowed { borrowed } else { xlm_amount };

        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);
        native_client.transfer(&user, &env.current_contract_address(), &repay_amount);

        write_user_borrowed(&env, &user, borrowed - repay_amount);

        let total = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total - repay_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("repay"),),
            (user, repay_amount),
        );
    }

    /// Liquidate an unhealthy position. Liquidator repays debt and receives collateral + bonus.
    pub fn liquidate(env: Env, liquidator: Address, borrower: Address) {
        liquidator.require_auth();
        extend_instance(&env);

        let collateral = read_user_collateral(&env, &borrower);
        let borrowed = read_user_borrowed(&env, &borrower);
        assert!(borrowed > 0, "no debt to liquidate");

        let liq_threshold_bps = read_liquidation_threshold(&env);
        let er = read_exchange_rate(&env);
        let hf = compute_health_factor(collateral, borrowed, liq_threshold_bps, er);
        assert!(hf < RATE_PRECISION, "position is healthy, cannot liquidate");

        // Liquidator repays full debt
        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);
        native_client.transfer(&liquidator, &env.current_contract_address(), &borrowed);

        // Liquidator receives sXLM worth (debt + 5% bonus) in XLM value
        // sxlm_to_seize = borrowed * (1 + bonus_bps/BPS) * RATE_PRECISION / exchange_rate
        let bonus_bps = read_liquidation_bonus(&env);
        let debt_with_bonus = borrowed * (BPS_DENOMINATOR + bonus_bps) / BPS_DENOMINATOR;
        let sxlm_to_seize = debt_with_bonus * RATE_PRECISION / er;
        // Cap at borrower's actual collateral (can't seize more than they deposited)
        let collateral_to_send = if sxlm_to_seize > collateral {
            collateral
        } else {
            sxlm_to_seize
        };

        let sxlm = read_sxlm_token(&env);
        let sxlm_client = token::Client::new(&env, &sxlm);
        sxlm_client.transfer(&env.current_contract_address(), &liquidator, &collateral_to_send);

        // Clear borrower position
        let remaining_collateral = collateral - collateral_to_send;
        let total_collateral = read_i128(&env, &DataKey::TotalCollateral);
        // Only subtract the seized amount; remaining_collateral stays in contract attributed to borrower
        write_i128(&env, &DataKey::TotalCollateral, total_collateral - collateral_to_send);
        let total_borrowed = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total_borrowed - borrowed);

        write_user_collateral(&env, &borrower, remaining_collateral);
        write_user_borrowed(&env, &borrower, 0);

        env.events().publish(
            (soroban_sdk::symbol_short!("liq"),),
            (liquidator, borrower, borrowed, collateral_to_send),
        );
    }

    // --- Views ---

    /// Returns (collateral, borrowed) for a user.
    pub fn get_position(env: Env, user: Address) -> (i128, i128) {
        extend_instance(&env);
        extend_user_data(&env, &user);
        (
            read_user_collateral(&env, &user),
            read_user_borrowed(&env, &user),
        )
    }

    /// Returns health factor scaled by RATE_PRECISION (1e7 = 1.0).
    /// Uses liquidation threshold (not collateral factor) to match what liquidate() checks.
    pub fn health_factor(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let collateral = read_user_collateral(&env, &user);
        let borrowed = read_user_borrowed(&env, &user);
        let lt_bps = read_liquidation_threshold(&env);
        let er = read_exchange_rate(&env);
        compute_health_factor(collateral, borrowed, lt_bps, er)
    }

    pub fn total_borrowed(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::TotalBorrowed)
    }

    pub fn total_collateral(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::TotalCollateral)
    }

    pub fn get_exchange_rate(env: Env) -> i128 {
        extend_instance(&env);
        read_exchange_rate(&env)
    }

    pub fn get_collateral_factor(env: Env) -> i128 {
        extend_instance(&env);
        read_collateral_factor(&env)
    }

    pub fn get_liquidation_threshold(env: Env) -> i128 {
        extend_instance(&env);
        read_liquidation_threshold(&env)
    }

    pub fn get_borrow_rate(env: Env) -> i128 {
        extend_instance(&env);
        read_i128(&env, &DataKey::BorrowRateBps)
    }

    pub fn get_liquidation_bonus(env: Env) -> i128 {
        extend_instance(&env);
        read_liquidation_bonus(&env)
    }

    pub fn get_pool_balance(env: Env) -> i128 {
        extend_instance(&env);
        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);
        native_client.balance(&env.current_contract_address())
    }

    // ==========================================================
    // Multi-asset collateral whitelist
    // ==========================================================

    /// Add an asset to the collateral whitelist with its collateral factor.
    /// Only callable by admin. CF must be <= 90% (9000 bps).
    pub fn add_collateral_asset(env: Env, asset: Address, cf_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(cf_bps > 0 && cf_bps <= 9000, "collateral factor must be <= 90%");
        extend_instance(&env);

        let key = DataKey::AssetCf(asset.clone());
        env.storage().instance().set(&key, &(cf_bps as i128));

        env.events().publish(
            (soroban_sdk::symbol_short!("add_cf"),),
            (asset, cf_bps),
        );
    }

    /// Remove an asset from the collateral whitelist. Only callable by admin.
    pub fn remove_collateral_asset(env: Env, asset: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);

        let key = DataKey::AssetCf(asset.clone());
        env.storage().instance().remove(&key);

        env.events().publish(
            (soroban_sdk::symbol_short!("rm_cf"),),
            asset,
        );
    }

    /// Get collateral factor for an asset (0 = not whitelisted).
    pub fn get_asset_cf(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        let key = DataKey::AssetCf(asset);
        env.storage().instance().get(&key).unwrap_or(0)
    }

    /// Deposit whitelisted asset as collateral.
    pub fn deposit_collateral_asset(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        // Check asset is whitelisted
        let cf = Self::get_asset_cf(env.clone(), asset.clone());
        assert!(cf > 0, "asset not whitelisted as collateral");

        // Transfer asset from user to contract
        let asset_client = token::Client::new(&env, &asset);
        asset_client.transfer(&user, &env.current_contract_address(), &amount);

        // Update user balance
        let key = DataKey::AssetCollateral(asset.clone(), user.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);

        // Update total
        let total_key = DataKey::AssetTotalCollateral(asset.clone());
        let total: i128 = env.storage().instance().get(&total_key).unwrap_or(0);
        env.storage().instance().set(&total_key, &(total + amount));

        env.events().publish(
            (soroban_sdk::symbol_short!("dep_ast"),),
            (user, asset, amount),
        );
    }

    /// Withdraw whitelisted asset collateral.
    pub fn withdraw_collateral_asset(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        // Check user balance
        let key = DataKey::AssetCollateral(asset.clone(), user.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        assert!(current >= amount, "insufficient asset collateral");

        // Update user balance
        env.storage().persistent().set(&key, &(current - amount));
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);

        // Update total
        let total_key = DataKey::AssetTotalCollateral(asset.clone());
        let total: i128 = env.storage().instance().get(&total_key).unwrap_or(0);
        env.storage().instance().set(&total_key, &(total - amount));

        // Transfer asset back to user
        let asset_client = token::Client::new(&env, &asset);
        asset_client.transfer(&env.current_contract_address(), &user, &amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("wd_ast"),),
            (user, asset, amount),
        );
    }

    /// Get user's balance of a specific collateral asset.
    pub fn get_asset_collateral_balance(env: Env, user: Address, asset: Address) -> i128 {
        extend_instance(&env);
        let key = DataKey::AssetCollateral(asset, user);
        let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if val > 0 {
            env.storage()
                .persistent()
                .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
        }
        val
    }

    /// Get total deposited across all users for a specific asset.
    pub fn get_asset_total_collateral(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        let key = DataKey::AssetTotalCollateral(asset);
        env.storage().instance().get(&key).unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token::StellarAssetClient, Env};

    fn setup_test() -> (Env, Address, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let liquidator = Address::generate(&env);

        let sxlm_token_admin = Address::generate(&env);
        let sxlm_id = env.register_stellar_asset_contract_v2(sxlm_token_admin.clone()).address();
        let native_id = env.register_stellar_asset_contract_v2(admin.clone()).address();

        let contract_id = env.register_contract(None, LendingContract);

        // Initialize
        let client = LendingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &7000, &8000, &500);

        // Mint tokens
        let sxlm_admin_client = StellarAssetClient::new(&env, &sxlm_id);
        sxlm_admin_client.mint(&user, &100_000_0000000); // 100k sXLM
        sxlm_admin_client.mint(&liquidator, &50_000_0000000);

        let native_admin_client = StellarAssetClient::new(&env, &native_id);
        native_admin_client.mint(&contract_id, &500_000_0000000); // Fund pool with XLM
        native_admin_client.mint(&liquidator, &100_000_0000000);

        (env, contract_id, sxlm_id, native_id, user, liquidator, admin)
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        assert_eq!(client.total_borrowed(), 0);
        assert_eq!(client.total_collateral(), 0);
        assert_eq!(client.get_exchange_rate(), RATE_PRECISION);
    }

    #[test]
    fn test_deposit_and_borrow() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Deposit 1000 sXLM
        client.deposit_collateral(&user, &10_000_000_000);
        let (col, bor) = client.get_position(&user);
        assert_eq!(col, 10_000_000_000);
        assert_eq!(bor, 0);

        // Borrow 700 XLM (70% of 1000 at 1:1 ER)
        client.borrow(&user, &7_000_000_000);
        let (col2, bor2) = client.get_position(&user);
        assert_eq!(col2, 10_000_000_000);
        assert_eq!(bor2, 7_000_000_000);
    }

    #[test]
    #[should_panic(expected = "borrow exceeds collateral limit")]
    fn test_borrow_exceeds_limit() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &10_000_000_000);
        // Try to borrow 8000 XLM (80% > 70% CF)
        client.borrow(&user, &8_000_000_000);
    }

    #[test]
    fn test_repay() {
        let (env, contract_id, _, native_id, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Give user XLM for repayment
        let native_admin = StellarAssetClient::new(&env, &native_id);
        native_admin.mint(&user, &100_000_0000000);

        client.deposit_collateral(&user, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // Repay 3000
        client.repay(&user, &3_000_000_000);
        let (_, bor) = client.get_position(&user);
        assert_eq!(bor, 2_000_000_000);
    }

    #[test]
    fn test_withdraw_collateral() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &10_000_000_000);
        // No borrows, can withdraw all
        client.withdraw_collateral(&user, &5_000_000_000);
        let (col, _) = client.get_position(&user);
        assert_eq!(col, 5_000_000_000);
    }

    #[test]
    #[should_panic(expected = "withdrawal would make position unhealthy")]
    fn test_withdraw_unhealthy() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &10_000_000_000);
        client.borrow(&user, &7_000_000_000); // max borrow at 70%

        // Try to withdraw any collateral — should fail
        client.withdraw_collateral(&user, &1_000_000_000);
    }

    #[test]
    fn test_health_factor() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // HF now uses liquidation_threshold (8000) not collateral_factor (7000)
        // HF = (10000 * 1e7 * 8000 / 10000) / 5000 = 8000 * 1e7 / 5000 = 16_000_000
        let hf = client.health_factor(&user);
        assert_eq!(hf, 16_000_000); // 1.6 × 1e7
    }

    #[test]
    fn test_health_factor_with_exchange_rate() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // Increase ER to 1.2 (12_000_000)
        client.update_exchange_rate(&12_000_000);

        // HF now uses LT (8000) not CF (7000)
        // HF = (10000 * 12_000_000 * 8000 / 10000) / 5000
        //    = 9600 * 1e7 / 5000 = 19_200_000
        let hf = client.health_factor(&user);
        assert_eq!(hf, 19_200_000); // 1.92 × 1e7
    }

    #[test]
    fn test_exchange_rate_increases_borrow_capacity() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &10_000_000_000); // 1000 sXLM

        // At 1:1 ER, max borrow = 1000 * 0.7 = 700 XLM
        client.borrow(&user, &7_000_000_000);

        // Increase ER to 1.5 → max borrow = 1000 * 1.5 * 0.7 = 1050 XLM
        client.update_exchange_rate(&15_000_000);

        // Can now borrow more (up to 1050 - 700 = 350 more)
        client.borrow(&user, &3_000_000_000); // borrow 300 more
        let (_, bor) = client.get_position(&user);
        assert_eq!(bor, 10_000_000_000); // 700 + 300 = 1000 total
    }

    #[test]
    fn test_liquidation() {
        let (env, _contract_id, _sxlm_id, _, _, _, _) = setup_test();

        // Create a separate contract with low liquidation threshold for testing
        let contract2 = env.register_contract(None, LendingContract);
        let client2 = LendingContractClient::new(&env, &contract2);
        let sxlm2 = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native2 = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        client2.initialize(&Address::generate(&env), &sxlm2, &native2, &7000, &5000, &500);

        let u = Address::generate(&env);
        let liq = Address::generate(&env);
        StellarAssetClient::new(&env, &sxlm2).mint(&u, &100_000_0000000);
        StellarAssetClient::new(&env, &sxlm2).mint(&contract2, &100_000_0000000); // extra for bonus
        StellarAssetClient::new(&env, &native2).mint(&contract2, &500_000_0000000);
        StellarAssetClient::new(&env, &native2).mint(&liq, &100_000_0000000);

        client2.deposit_collateral(&u, &10_000_000_000);
        client2.borrow(&u, &7_000_000_000);
        // HF = 10000 * 1e7 * 5000/10000 / 7000 = 5000 * 1e7 / 7000 ≈ 7_142_857 < 1e7
        // Liquidatable!

        client2.liquidate(&liq, &u);
        let (col, bor) = client2.get_position(&u);
        assert_eq!(bor, 0);
        // Liquidator gets debt_with_bonus in sXLM: 7000 * 1.05 = 7350 (in units: 7_350_000_000)
        // Remaining collateral: 10_000_000_000 - 7_350_000_000 = 2_650_000_000
        assert_eq!(col, 2_650_000_000);
    }

    #[test]
    fn test_admin_update_collateral_factor() {
        let (env, contract_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        assert_eq!(client.get_collateral_factor(), 7000);
        client.update_collateral_factor(&7500);
        assert_eq!(client.get_collateral_factor(), 7500);
    }

    #[test]
    fn test_totals() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &sxlm_id).mint(&user2, &100_000_0000000);

        client.deposit_collateral(&user, &10_000_000_000);
        client.deposit_collateral(&user2, &5_000_000_000);

        assert_eq!(client.total_collateral(), 15_000_000_000);

        client.borrow(&user, &3_000_000_000);
        client.borrow(&user2, &2_000_000_000);

        assert_eq!(client.total_borrowed(), 5_000_000_000);
    }

    #[test]
    fn test_add_collateral_asset_and_whitelist() {
        let (env, contract_id, _, _, _, _, admin) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Create a new asset (e.g., USDC)
        let usdc = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        // Not whitelisted initially
        assert_eq!(client.get_asset_cf(&usdc), 0);

        // Admin whitelists with 80% CF
        client.add_collateral_asset(&usdc, &8000);

        // Now whitelisted
        assert_eq!(client.get_asset_cf(&usdc), 8000);
    }

    #[test]
    fn test_deposit_and_withdraw_collateral_asset() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Create and whitelist USDC
        let usdc = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        client.add_collateral_asset(&usdc, &8000);

        // Mint USDC to user
        StellarAssetClient::new(&env, &usdc).mint(&user, &1_000_0000000);

        // Deposit 500 USDC
        client.deposit_collateral_asset(&user, &usdc, &500_0000000);
        assert_eq!(client.get_asset_collateral_balance(&user, &usdc), 500_0000000);
        assert_eq!(client.get_asset_total_collateral(&usdc), 500_0000000);

        // Withdraw 200 USDC
        client.withdraw_collateral_asset(&user, &usdc, &200_0000000);
        assert_eq!(client.get_asset_collateral_balance(&user, &usdc), 300_0000000);
        assert_eq!(client.get_asset_total_collateral(&usdc), 300_0000000);
    }

    #[test]
    #[should_panic(expected = "asset not whitelisted as collateral")]
    fn test_deposit_non_whitelisted_asset_panics() {
        let (env, contract_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Create asset but don't whitelist it
        let random_token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        StellarAssetClient::new(&env, &random_token).mint(&user, &1_000_0000000);

        // Try to deposit — should panic
        client.deposit_collateral_asset(&user, &random_token, &100_0000000);
    }

    #[test]
    #[should_panic(expected = "collateral factor must be <= 90%")]
    fn test_add_collateral_asset_rejects_excessive_cf() {
        let (env, contract_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let asset = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        // Try to set CF to 95% — should panic
        client.add_collateral_asset(&asset, &9500);
    }

    #[test]
    fn test_remove_collateral_asset() {
        let (env, contract_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let asset = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        // Add asset
        client.add_collateral_asset(&asset, &7500);
        assert_eq!(client.get_asset_cf(&asset), 7500);

        // Remove asset
        client.remove_collateral_asset(&asset);
        assert_eq!(client.get_asset_cf(&asset), 0);
    }
}

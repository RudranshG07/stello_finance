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
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // bump to ~30 days
const USER_LIFETIME_THRESHOLD: u32 = 518_400; // ~30 days
const USER_BUMP_AMOUNT: u32 = 3_110_400; // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    SxlmToken,
    NativeToken,
    CollateralFactorBps, // Legacy: default for sXLM
    LiquidationThresholdBps,
    BorrowRateBps,
    LiquidationBonusBps,
    ExchangeRate, // sXLM → XLM rate (scaled by RATE_PRECISION)
    Initialized,
    TotalCollateral,
    TotalBorrowed,
    SupportedCollateral(Address), // bool: is asset supported as collateral
    CollateralFactorAsset(Address), // i128: per-asset collateral factor bps
    OraclePrice(Address),         // i128: price of asset relative to native (scaled)
    Collateral(Address, Address), // (user, asset) → amount
    TotalCollateralAsset(Address), // per-asset total collateral
    UserCollateralValue(Address), // user's total collateral value in native
    Borrowed(Address),            // user's borrowed amount
}

// --- Storage helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_user_data(env: &Env, user: &Address) {
    let bor_key = DataKey::Borrowed(user.clone());
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

fn read_user_collateral(env: &Env, user: &Address, asset: &Address) -> i128 {
    let key = DataKey::Collateral(user.clone(), asset.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
    val
}

fn write_user_collateral(env: &Env, user: &Address, asset: &Address, val: i128) {
    let key = DataKey::Collateral(user.clone(), asset.clone());
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

fn is_supported_collateral(env: &Env, asset: &Address) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::SupportedCollateral(asset.clone()))
        .unwrap_or(false)
}

fn read_collateral_factor_asset(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::CollateralFactorAsset(asset.clone()))
        .unwrap_or(0)
}

fn read_oracle_price(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::OraclePrice(asset.clone()))
        .unwrap_or(RATE_PRECISION)
}

fn read_total_collateral_asset(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalCollateralAsset(asset.clone()))
        .unwrap_or(0)
}

fn write_total_collateral_asset(env: &Env, asset: &Address, val: i128) {
    env.storage()
        .instance()
        .set(&DataKey::TotalCollateralAsset(asset.clone()), &val);
}

fn read_user_total_collateral_value(env: &Env, user: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::UserCollateralValue(user.clone()))
        .unwrap_or(0)
}

fn write_user_total_collateral_value(env: &Env, user: &Address, val: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::UserCollateralValue(user.clone()), &val);
}

/// Health Factor = (collateral × exchange_rate × collateral_factor_bps) / (BPS × RATE_PRECISION × borrowed)
/// Returns HF scaled by RATE_PRECISION (so 1.0 = RATE_PRECISION)
fn compute_health_factor(
    collateral: i128,
    borrowed: i128,
    cf_bps: i128,
    exchange_rate: i128,
) -> i128 {
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
        env.storage().instance().set(
            &DataKey::CollateralFactorBps,
            &(collateral_factor_bps as i128),
        );
        env.storage().instance().set(
            &DataKey::LiquidationThresholdBps,
            &(liquidation_threshold_bps as i128),
        );
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(borrow_rate_bps as i128));
        env.storage().instance().set(
            &DataKey::LiquidationBonusBps,
            &DEFAULT_LIQUIDATION_BONUS_BPS,
        );
        env.storage()
            .instance()
            .set(&DataKey::ExchangeRate, &RATE_PRECISION); // 1:1 initial
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

        env.events()
            .publish((soroban_sdk::symbol_short!("er_upd"),), rate);
    }

    /// Update the collateral factor. Only callable by admin.
    pub fn update_collateral_factor(env: Env, new_cf_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(
            new_cf_bps > 0 && new_cf_bps <= 10000,
            "invalid collateral factor"
        );
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::CollateralFactorBps, &(new_cf_bps as i128));

        env.events()
            .publish((soroban_sdk::symbol_short!("cf_upd"),), new_cf_bps);
    }

    /// Update the liquidation threshold. Only callable by admin.
    pub fn update_liquidation_threshold(env: Env, new_lt_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(
            new_lt_bps > 0 && new_lt_bps <= 10000,
            "invalid liquidation threshold"
        );
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::LiquidationThresholdBps, &(new_lt_bps as i128));
    }

    /// Update the borrow rate. Only callable by admin.
    pub fn update_borrow_rate(env: Env, new_rate_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(new_rate_bps as i128));
    }

    /// Add a supported collateral asset with its collateral factor. Only callable by admin.
    pub fn add_supported_collateral(
        env: Env,
        asset: Address,
        collateral_factor_bps: u32,
        oracle_price: i128,
    ) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(
            collateral_factor_bps > 0 && collateral_factor_bps <= 10000,
            "invalid collateral factor"
        );
        assert!(oracle_price > 0, "invalid oracle price");
        extend_instance(&env);

        env.storage()
            .instance()
            .set(&DataKey::SupportedCollateral(asset.clone()), &true);
        env.storage().instance().set(
            &DataKey::CollateralFactorAsset(asset.clone()),
            &(collateral_factor_bps as i128),
        );
        env.storage()
            .instance()
            .set(&DataKey::OraclePrice(asset.clone()), &oracle_price);

        env.events().publish(
            (soroban_sdk::symbol_short!("add_col"),),
            (asset, collateral_factor_bps),
        );
    }

    /// Update collateral factor for an asset. Only callable by admin.
    pub fn update_asset_collateral_factor(env: Env, asset: Address, new_cf_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(
            new_cf_bps > 0 && new_cf_bps <= 10000,
            "invalid collateral factor"
        );
        assert!(is_supported_collateral(&env, &asset), "asset not supported");
        extend_instance(&env);

        env.storage().instance().set(
            &DataKey::CollateralFactorAsset(asset.clone()),
            &(new_cf_bps as i128),
        );

        env.events()
            .publish((soroban_sdk::symbol_short!("cf_upd"),), (asset, new_cf_bps));
    }

    /// Update oracle price for an asset. Only callable by admin.
    pub fn update_oracle_price(env: Env, asset: Address, price: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(price > 0, "invalid price");
        assert!(is_supported_collateral(&env, &asset), "asset not supported");
        extend_instance(&env);

        env.storage()
            .instance()
            .set(&DataKey::OraclePrice(asset.clone()), &price);

        env.events()
            .publish((soroban_sdk::symbol_short!("price"),), (asset, price));
    }

    // ==========================================================
    // Core lending functions
    // ==========================================================

    /// Deposit asset as collateral.
    pub fn deposit_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        assert!(is_supported_collateral(&env, &asset), "asset not supported");
        extend_instance(&env);

        let price = read_oracle_price(&env, &asset);
        let amount_value = amount * price / RATE_PRECISION;

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&user, &env.current_contract_address(), &amount);

        let current = read_user_collateral(&env, &user, &asset);
        write_user_collateral(&env, &user, &asset, current + amount);

        let total_collateral_value = read_user_total_collateral_value(&env, &user);
        write_user_total_collateral_value(&env, &user, total_collateral_value + amount_value);

        let total = read_total_collateral_asset(&env, &asset);
        write_total_collateral_asset(&env, &asset, total + amount);

        let total_col = read_i128(&env, &DataKey::TotalCollateral);
        write_i128(&env, &DataKey::TotalCollateral, total_col + amount_value);

        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (user, asset, amount),
        );
    }

    /// Withdraw collateral if health factor stays above 1.0.
    pub fn withdraw_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        let current = read_user_collateral(&env, &user, &asset);
        assert!(current >= amount, "insufficient collateral");

        let borrowed = read_user_borrowed(&env, &user);

        if borrowed > 0 {
            let price = read_oracle_price(&env, &asset);
            let amount_value = amount * price / RATE_PRECISION;
            let total_collateral_value = read_user_total_collateral_value(&env, &user);
            let new_value = total_collateral_value - amount_value;
            let lt_bps = read_liquidation_threshold(&env);

            let hf = compute_health_factor(new_value, borrowed, lt_bps, RATE_PRECISION);
            assert!(
                hf >= RATE_PRECISION,
                "withdrawal would make position unhealthy"
            );
        }

        write_user_collateral(&env, &user, &asset, current - amount);

        let price = read_oracle_price(&env, &asset);
        let amount_value = amount * price / RATE_PRECISION;
        let total_collateral_value = read_user_total_collateral_value(&env, &user);
        write_user_total_collateral_value(&env, &user, total_collateral_value - amount_value);

        let total = read_total_collateral_asset(&env, &asset);
        write_total_collateral_asset(&env, &asset, total - amount);

        let total_col = read_i128(&env, &DataKey::TotalCollateral);
        write_i128(&env, &DataKey::TotalCollateral, total_col - amount_value);

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &user, &amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("withdraw"),),
            (user, asset, amount),
        );
    }

    /// Borrow XLM against deposited collateral.
    pub fn borrow(env: Env, user: Address, xlm_amount: i128) {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let total_collateral_value = read_user_total_collateral_value(&env, &user);
        let current_borrowed = read_user_borrowed(&env, &user);
        let new_borrowed = current_borrowed + xlm_amount;
        let lt_bps = read_liquidation_threshold(&env);

        // max_borrow = collateral_value * lt_bps / BPS_DENOMINATOR
        let max_borrow = total_collateral_value * lt_bps / BPS_DENOMINATOR;
        assert!(
            new_borrowed <= max_borrow,
            "borrow exceeds collateral limit"
        );

        write_user_borrowed(&env, &user, new_borrowed);

        let total = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total + xlm_amount);

        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);

        // Solvency check: ensure the pool has enough XLM to lend
        let pool_balance = native_client.balance(&env.current_contract_address());
        assert!(pool_balance >= xlm_amount, "insufficient pool liquidity");

        native_client.transfer(&env.current_contract_address(), &user, &xlm_amount);

        env.events()
            .publish((soroban_sdk::symbol_short!("borrow"),), (user, xlm_amount));
    }

    /// Repay borrowed XLM.
    pub fn repay(env: Env, user: Address, xlm_amount: i128) {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let borrowed = read_user_borrowed(&env, &user);
        let repay_amount = if xlm_amount > borrowed {
            borrowed
        } else {
            xlm_amount
        };

        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);
        native_client.transfer(&user, &env.current_contract_address(), &repay_amount);

        write_user_borrowed(&env, &user, borrowed - repay_amount);

        let total = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total - repay_amount);

        env.events()
            .publish((soroban_sdk::symbol_short!("repay"),), (user, repay_amount));
    }

    /// Liquidate an unhealthy position. Liquidator repays debt and receives collateral + bonus.
    pub fn liquidate(env: Env, liquidator: Address, borrower: Address, asset: Address) {
        liquidator.require_auth();
        extend_instance(&env);

        let collateral_amount = read_user_collateral(&env, &borrower, &asset);
        let borrowed = read_user_borrowed(&env, &borrower);
        assert!(borrowed > 0, "no debt to liquidate");
        assert!(collateral_amount > 0, "no collateral to seize");

        let collateral_value = read_user_total_collateral_value(&env, &borrower);
        let liq_threshold_bps = read_liquidation_threshold(&env);
        let hf = compute_health_factor(
            collateral_value,
            borrowed,
            liq_threshold_bps,
            RATE_PRECISION,
        );
        assert!(
            hf <= RATE_PRECISION,
            "position is healthy, cannot liquidate"
        );

        let price = read_oracle_price(&env, &asset);

        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);
        native_client.transfer(&liquidator, &env.current_contract_address(), &borrowed);

        let bonus_bps = read_liquidation_bonus(&env);
        let debt_with_bonus = borrowed * (BPS_DENOMINATOR + bonus_bps) / BPS_DENOMINATOR;
        let collateral_value_to_seize = debt_with_bonus;

        let amount_to_seize = collateral_value_to_seize * RATE_PRECISION / price;
        let collateral_to_send = if amount_to_seize > collateral_amount {
            collateral_amount
        } else {
            amount_to_seize
        };

        let value_seized = collateral_to_send * price / RATE_PRECISION;

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(
            &env.current_contract_address(),
            &liquidator,
            &collateral_to_send,
        );

        let remaining_amount = collateral_amount - collateral_to_send;
        write_user_collateral(&env, &borrower, &asset, remaining_amount);

        let old_total_value = read_user_total_collateral_value(&env, &borrower);
        write_user_total_collateral_value(&env, &borrower, old_total_value - value_seized);

        let total_asset = read_total_collateral_asset(&env, &asset);
        write_total_collateral_asset(&env, &asset, total_asset - collateral_to_send);

        let total_borrowed = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total_borrowed - borrowed);

        write_user_borrowed(&env, &borrower, 0);

        env.events().publish(
            (soroban_sdk::symbol_short!("liq"),),
            (liquidator, borrower, asset, borrowed, collateral_to_send),
        );
    }

    // --- Views ---

    /// Returns (total_collateral_value, borrowed) for a user.
    pub fn get_position(env: Env, user: Address) -> (i128, i128) {
        extend_instance(&env);
        extend_user_data(&env, &user);
        (
            read_user_total_collateral_value(&env, &user),
            read_user_borrowed(&env, &user),
        )
    }

    /// Returns health factor scaled by RATE_PRECISION (1e7 = 1.0).
    /// Uses liquidation threshold (not collateral factor) to match what liquidate() checks.
    pub fn health_factor(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let collateral_value = read_user_total_collateral_value(&env, &user);
        let borrowed = read_user_borrowed(&env, &user);
        let lt_bps = read_liquidation_threshold(&env);
        compute_health_factor(collateral_value, borrowed, lt_bps, RATE_PRECISION)
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

    pub fn get_collateral_factor_for_asset(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        read_collateral_factor_asset(&env, &asset)
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
        let sxlm_id = env
            .register_stellar_asset_contract_v2(sxlm_token_admin.clone())
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let contract_id = env.register_contract(None, LendingContract);

        // Initialize
        let client = LendingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &7000, &8000, &500);

        // Add sXLM as supported collateral
        client.add_supported_collateral(&sxlm_id, &7500, &RATE_PRECISION);

        // Mint tokens
        let sxlm_admin_client = StellarAssetClient::new(&env, &sxlm_id);
        sxlm_admin_client.mint(&user, &100_000_0000000); // 100k sXLM
        sxlm_admin_client.mint(&liquidator, &50_000_0000000);

        let native_admin_client = StellarAssetClient::new(&env, &native_id);
        native_admin_client.mint(&contract_id, &500_000_0000000); // Fund pool with XLM
        native_admin_client.mint(&liquidator, &100_000_0000000);

        (
            env,
            contract_id,
            sxlm_id,
            native_id,
            user,
            liquidator,
            admin,
        )
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        assert_eq!(client.total_borrowed(), 0);
        assert_eq!(client.total_collateral(), 0);
    }

    #[test]
    fn test_deposit_and_borrow() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Deposit 1000 sXLM (value = 1000 * 1e7 = 10_000_000_000)
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        let (col, bor) = client.get_position(&user);
        assert_eq!(col, 10_000_000_000);
        assert_eq!(bor, 0);

        // Borrow 700 XLM (70% of 1000 at 1:1 ER = 700 * 1e7 = 7_000_000_000)
        client.borrow(&user, &7_000_000_000);
        let (col2, bor2) = client.get_position(&user);
        assert_eq!(col2, 10_000_000_000);
        assert_eq!(bor2, 7_000_000_000);
    }

    #[test]
    #[should_panic(expected = "borrow exceeds collateral limit")]
    fn test_borrow_exceeds_limit() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        // Try to borrow 9000 XLM (90% > 80% LT)
        client.borrow(&user, &9_000_000_000);
    }

    #[test]
    fn test_repay() {
        let (env, contract_id, sxlm_id, native_id, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Give user XLM for repayment
        let native_admin = StellarAssetClient::new(&env, &native_id);
        native_admin.mint(&user, &100_000_0000000);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // Repay 3000
        client.repay(&user, &3_000_000_000);
        let (_, bor) = client.get_position(&user);
        assert_eq!(bor, 2_000_000_000);
    }

    #[test]
    fn test_withdraw_collateral() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        // No borrows, can withdraw all
        client.withdraw_collateral(&user, &sxlm_id, &5_000_000_000);
        let (col, _) = client.get_position(&user);
        assert_eq!(col, 5_000_000_000);
    }

    #[test]
    #[should_panic(expected = "withdrawal would make position unhealthy")]
    fn test_withdraw_unhealthy() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &8_000_000_000); // 80% of 10_000_000_000

        // Try to withdraw any collateral — should fail
        client.withdraw_collateral(&user, &sxlm_id, &1_000_000_000);
    }

    #[test]
    fn test_health_factor() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // HF = (10000 * 1e7 * 8000 / 10000) / 5000 = 8000 * 1e7 / 5000 = 16_000_000
        let hf = client.health_factor(&user);
        assert_eq!(hf, 16_000_000); // 1.6 × 1e7
    }

    #[test]
    fn test_exchange_rate_increases_borrow_capacity() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000); // 1000 sXLM

        // At 1:1 price, max borrow = 1000 * 0.8 = 800 XLM
        client.borrow(&user, &8_000_000_000);

        let (_, bor) = client.get_position(&user);
        assert_eq!(bor, 8_000_000_000);
    }

    #[test]
    fn test_liquidation() {
        let (env, contract_id, sxlm_id, native_id, _, liquidator, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.add_supported_collateral(&sxlm_id, &7500, &RATE_PRECISION);

        let borrower = Address::generate(&env);
        StellarAssetClient::new(&env, &sxlm_id).mint(&borrower, &100_000_0000000);
        StellarAssetClient::new(&env, &sxlm_id).mint(&contract_id, &100_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&contract_id, &500_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&liquidator, &100_000_0000000);

        client.deposit_collateral(&borrower, &sxlm_id, &10_000_000_000);
        client.borrow(&borrower, &8_000_000_000);

        let hf = client.health_factor(&borrower);
        assert!(hf <= RATE_PRECISION);

        client.liquidate(&liquidator, &borrower, &sxlm_id);
        let (col, bor) = client.get_position(&borrower);
        assert_eq!(bor, 0);
        assert!(col < 10_000_000_000);
    }

    #[test]
    fn test_admin_update_collateral_factor() {
        let (env, contract_id, sxlm_id, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Update per-asset collateral factor
        client.update_asset_collateral_factor(&sxlm_id, &8000);
        let cf = client.get_collateral_factor_for_asset(&sxlm_id);
        assert_eq!(cf, 8000);
    }

    #[test]
    fn test_totals() {
        let (env, contract_id, sxlm_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &sxlm_id).mint(&user2, &100_000_0000000);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.deposit_collateral(&user2, &sxlm_id, &5_000_000_000);

        assert_eq!(client.total_collateral(), 15_000_000_000);

        client.borrow(&user, &3_000_000_000);
        client.borrow(&user2, &2_000_000_000);

        assert_eq!(client.total_borrowed(), 5_000_000_000);
    }
}

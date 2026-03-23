#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Vec};

const BPS_DENOMINATOR: i128 = 10_000;
const RATE_PRECISION: i128 = 10_000_000; // 1e7
const DEFAULT_LIQUIDATION_BONUS_BPS: i128 = 500; // 5% bonus

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;         // bump to ~30 days
const USER_LIFETIME_THRESHOLD: u32 = 518_400;      // ~30 days
const USER_BUMP_AMOUNT: u32 = 3_110_400;           // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub struct AssetConfig {
    pub collateral_factor_bps: i128,
    pub liquidation_threshold_bps: i128,
    pub price_in_xlm: i128, // scaled by RATE_PRECISION
    pub enabled: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct UserAssetKey {
    pub user: Address,
    pub asset: Address,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    SxlmToken,
    NativeToken,
    BorrowRateBps,
    LiquidationBonusBps,
    Initialized,
    TotalCollateral,
    TotalBorrowed,
    SupportedAssets,
    AssetConfig(Address),
    AssetCollateral(UserAssetKey),
    Borrowed(Address),
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

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_sxlm_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SxlmToken).unwrap()
}

fn read_native_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::NativeToken).unwrap()
}

fn read_liquidation_bonus(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LiquidationBonusBps)
        .unwrap_or(DEFAULT_LIQUIDATION_BONUS_BPS)
}

fn read_asset_config(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetConfig(asset.clone()))
        .expect("asset not configured")
}

fn write_asset_config(env: &Env, asset: &Address, config: &AssetConfig) {
    env.storage()
        .instance()
        .set(&DataKey::AssetConfig(asset.clone()), config);
}

fn read_supported_assets(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::SupportedAssets)
        .unwrap_or_else(|| Vec::new(env))
}

fn read_user_asset_collateral(env: &Env, user: &Address, asset: &Address) -> i128 {
    let key = DataKey::AssetCollateral(UserAssetKey {
        user: user.clone(),
        asset: asset.clone(),
    });
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
    val
}

fn write_user_asset_collateral(env: &Env, user: &Address, asset: &Address, val: i128) {
    let key = DataKey::AssetCollateral(UserAssetKey {
        user: user.clone(),
        asset: asset.clone(),
    });
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

fn compute_total_collateral_value(env: &Env, user: &Address) -> i128 {
    let supported = read_supported_assets(env);
    let mut total: i128 = 0;
    for asset in supported.iter() {
        let amount = read_user_asset_collateral(env, user, &asset);
        if amount == 0 {
            continue;
        }
        let config = read_asset_config(env, &asset);
        total += amount * config.price_in_xlm / RATE_PRECISION;
    }
    total
}

fn compute_max_borrow(env: &Env, user: &Address) -> i128 {
    let supported = read_supported_assets(env);
    let mut max_borrow: i128 = 0;
    for asset in supported.iter() {
        let amount = read_user_asset_collateral(env, user, &asset);
        if amount == 0 {
            continue;
        }
        let config = read_asset_config(env, &asset);
        max_borrow +=
            amount * config.price_in_xlm * config.collateral_factor_bps
                / (RATE_PRECISION * BPS_DENOMINATOR);
    }
    max_borrow
}

// HF = Σ(amount_i * price_i * lt_i) * RATE_PRECISION / (BPS_DENOMINATOR * borrowed)
// scaled by RATE_PRECISION — 1.0 = RATE_PRECISION
fn compute_health_factor_multi(env: &Env, user: &Address, borrowed: i128) -> i128 {
    if borrowed == 0 {
        return i128::MAX;
    }
    let supported = read_supported_assets(env);
    let mut weighted: i128 = 0;
    for asset in supported.iter() {
        let amount = read_user_asset_collateral(env, user, &asset);
        if amount == 0 {
            continue;
        }
        let config = read_asset_config(env, &asset);
        weighted +=
            amount * config.price_in_xlm * config.liquidation_threshold_bps
                / (RATE_PRECISION * BPS_DENOMINATOR);
    }
    weighted * RATE_PRECISION / borrowed
}

#[contract]
pub struct LendingContract;

#[contractimpl]
impl LendingContract {
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
        env.storage().instance().set(&DataKey::SxlmToken, &sxlm_token);
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(borrow_rate_bps as i128));
        env.storage()
            .instance()
            .set(&DataKey::LiquidationBonusBps, &DEFAULT_LIQUIDATION_BONUS_BPS);

        let sxlm_config = AssetConfig {
            collateral_factor_bps: collateral_factor_bps as i128,
            liquidation_threshold_bps: liquidation_threshold_bps as i128,
            price_in_xlm: RATE_PRECISION, // 1:1 initial
            enabled: true,
        };
        write_asset_config(&env, &sxlm_token, &sxlm_config);

        let mut assets: Vec<Address> = Vec::new(&env);
        assets.push_back(sxlm_token);
        env.storage()
            .instance()
            .set(&DataKey::SupportedAssets, &assets);

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
    // Admin: asset configuration
    // ==========================================================

    /// Add or update a collateral asset's configuration. Only callable by admin.
    /// If the asset is new it will be appended to the supported assets list.
    pub fn set_asset_config(
        env: Env,
        asset: Address,
        collateral_factor_bps: u32,
        liquidation_threshold_bps: u32,
        price_in_xlm: i128,
    ) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(
            collateral_factor_bps > 0 && collateral_factor_bps <= 10_000,
            "invalid collateral factor"
        );
        assert!(
            liquidation_threshold_bps >= collateral_factor_bps
                && liquidation_threshold_bps <= 10_000,
            "liquidation threshold must be >= collateral factor"
        );
        assert!(price_in_xlm > 0, "price must be positive");
        extend_instance(&env);

        let config = AssetConfig {
            collateral_factor_bps: collateral_factor_bps as i128,
            liquidation_threshold_bps: liquidation_threshold_bps as i128,
            price_in_xlm,
            enabled: true,
        };
        write_asset_config(&env, &asset, &config);

        // Add to supported list if not already present.
        let mut assets = read_supported_assets(&env);
        let mut found = false;
        for a in assets.iter() {
            if a == asset {
                found = true;
                break;
            }
        }
        if !found {
            assets.push_back(asset.clone());
            env.storage()
                .instance()
                .set(&DataKey::SupportedAssets, &assets);
        }

        env.events()
            .publish((soroban_sdk::symbol_short!("asset_cfg"),), (asset, price_in_xlm));
    }

    /// Update the price of a supported asset. Only callable by admin.
    pub fn update_asset_price(env: Env, asset: Address, price_in_xlm: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(price_in_xlm > 0, "price must be positive");
        extend_instance(&env);

        let mut config = read_asset_config(&env, &asset);
        config.price_in_xlm = price_in_xlm;
        write_asset_config(&env, &asset, &config);

        env.events()
            .publish((soroban_sdk::symbol_short!("price_upd"),), (asset, price_in_xlm));
    }

    // ==========================================================
    // Admin setters (for governance / backward compat)
    // ==========================================================

    pub fn update_exchange_rate(env: Env, rate: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(rate > 0, "rate must be positive");
        extend_instance(&env);

        let sxlm = read_sxlm_token(&env);
        let mut config = read_asset_config(&env, &sxlm);
        config.price_in_xlm = rate;
        write_asset_config(&env, &sxlm, &config);

        env.events()
            .publish((soroban_sdk::symbol_short!("er_upd"),), rate);
    }

    pub fn update_collateral_factor(env: Env, new_cf_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(
            new_cf_bps > 0 && new_cf_bps <= 10_000,
            "invalid collateral factor"
        );
        extend_instance(&env);

        let sxlm = read_sxlm_token(&env);
        let mut config = read_asset_config(&env, &sxlm);
        config.collateral_factor_bps = new_cf_bps as i128;
        write_asset_config(&env, &sxlm, &config);

        env.events()
            .publish((soroban_sdk::symbol_short!("cf_upd"),), new_cf_bps);
    }

    pub fn update_liquidation_threshold(env: Env, new_lt_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(
            new_lt_bps > 0 && new_lt_bps <= 10_000,
            "invalid liquidation threshold"
        );
        extend_instance(&env);

        let sxlm = read_sxlm_token(&env);
        let mut config = read_asset_config(&env, &sxlm);
        config.liquidation_threshold_bps = new_lt_bps as i128;
        write_asset_config(&env, &sxlm, &config);
    }

    pub fn update_borrow_rate(env: Env, new_rate_bps: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(new_rate_bps as i128));
    }

    // ==========================================================
    // Core lending functions
    // ==========================================================

    pub fn deposit_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        let config = read_asset_config(&env, &asset);
        assert!(config.enabled, "asset is not enabled for collateral");

        // Transfer asset from user to contract.
        let asset_client = token::Client::new(&env, &asset);
        asset_client.transfer(&user, &env.current_contract_address(), &amount);

        // Update user's per-asset balance.
        let current = read_user_asset_collateral(&env, &user, &asset);
        write_user_asset_collateral(&env, &user, &asset, current + amount);

        // Update global TotalCollateral (XLM-equivalent value).
        let xlm_value = amount * config.price_in_xlm / RATE_PRECISION;
        let total = read_i128(&env, &DataKey::TotalCollateral);
        write_i128(&env, &DataKey::TotalCollateral, total + xlm_value);

        env.events()
            .publish((soroban_sdk::symbol_short!("deposit"),), (user, asset, amount));
    }

    pub fn withdraw_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        let current = read_user_asset_collateral(&env, &user, &asset);
        assert!(current >= amount, "insufficient collateral");

        // Simulate withdrawal and check health.
        write_user_asset_collateral(&env, &user, &asset, current - amount);
        let borrowed = read_user_borrowed(&env, &user);
        if borrowed > 0 {
            let hf = compute_health_factor_multi(&env, &user, borrowed);
            assert!(hf >= RATE_PRECISION, "withdrawal would make position unhealthy");
        }

        let config = read_asset_config(&env, &asset);
        let xlm_value = amount * config.price_in_xlm / RATE_PRECISION;
        let total = read_i128(&env, &DataKey::TotalCollateral);
        write_i128(&env, &DataKey::TotalCollateral, total - xlm_value);

        let asset_client = token::Client::new(&env, &asset);
        asset_client.transfer(&env.current_contract_address(), &user, &amount);

        env.events()
            .publish((soroban_sdk::symbol_short!("withdraw"),), (user, asset, amount));
    }

    pub fn borrow(env: Env, user: Address, xlm_amount: i128) {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let current_borrowed = read_user_borrowed(&env, &user);
        let new_borrowed = current_borrowed + xlm_amount;
        let max_borrow = compute_max_borrow(&env, &user);
        assert!(new_borrowed <= max_borrow, "borrow exceeds collateral limit");

        write_user_borrowed(&env, &user, new_borrowed);

        let total = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total + xlm_amount);

        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);

        let pool_balance = native_client.balance(&env.current_contract_address());
        assert!(pool_balance >= xlm_amount, "insufficient pool liquidity");

        native_client.transfer(&env.current_contract_address(), &user, &xlm_amount);

        env.events()
            .publish((soroban_sdk::symbol_short!("borrow"),), (user, xlm_amount));
    }

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

        env.events()
            .publish((soroban_sdk::symbol_short!("repay"),), (user, repay_amount));
    }

    pub fn liquidate(
        env: Env,
        liquidator: Address,
        borrower: Address,
        collateral_asset: Address,
    ) {
        liquidator.require_auth();
        extend_instance(&env);

        let borrowed = read_user_borrowed(&env, &borrower);
        assert!(borrowed > 0, "no debt to liquidate");

        let hf = compute_health_factor_multi(&env, &borrower, borrowed);
        assert!(hf < RATE_PRECISION, "position is healthy, cannot liquidate");

        let borrower_asset_collateral =
            read_user_asset_collateral(&env, &borrower, &collateral_asset);
        assert!(
            borrower_asset_collateral > 0,
            "borrower has no collateral in this asset"
        );

        // Liquidator repays full XLM debt.
        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);
        native_client.transfer(&liquidator, &env.current_contract_address(), &borrowed);

        // Calculate how much collateral to seize:
        // asset_to_seize = (debt * (1 + bonus)) / price_in_xlm
        let bonus_bps = read_liquidation_bonus(&env);
        let debt_with_bonus = borrowed * (BPS_DENOMINATOR + bonus_bps) / BPS_DENOMINATOR;
        let asset_config = read_asset_config(&env, &collateral_asset);
        let asset_to_seize = debt_with_bonus * RATE_PRECISION / asset_config.price_in_xlm;
        let collateral_to_send = if asset_to_seize > borrower_asset_collateral {
            borrower_asset_collateral
        } else {
            asset_to_seize
        };

        // Transfer seized collateral to liquidator.
        let asset_client = token::Client::new(&env, &collateral_asset);
        asset_client.transfer(
            &env.current_contract_address(),
            &liquidator,
            &collateral_to_send,
        );

        // Update borrower state.
        let remaining = borrower_asset_collateral - collateral_to_send;
        write_user_asset_collateral(&env, &borrower, &collateral_asset, remaining);
        write_user_borrowed(&env, &borrower, 0);

        // Update global totals.
        let seized_xlm_value = collateral_to_send * asset_config.price_in_xlm / RATE_PRECISION;
        let total_collateral = read_i128(&env, &DataKey::TotalCollateral);
        write_i128(
            &env,
            &DataKey::TotalCollateral,
            total_collateral - seized_xlm_value,
        );
        let total_borrowed = read_i128(&env, &DataKey::TotalBorrowed);
        write_i128(&env, &DataKey::TotalBorrowed, total_borrowed - borrowed);

        env.events().publish(
            (soroban_sdk::symbol_short!("liq"),),
            (liquidator, borrower, borrowed, collateral_to_send, collateral_asset),
        );
    }

    // ==========================================================
    // Views
    // ==========================================================

    pub fn get_position(env: Env, user: Address) -> (i128, i128) {
        extend_instance(&env);
        let borrowed = read_user_borrowed(&env, &user);
        let collateral_value = compute_total_collateral_value(&env, &user);
        (collateral_value, borrowed)
    }

    pub fn get_asset_position(env: Env, user: Address, asset: Address) -> i128 {
        extend_instance(&env);
        read_user_asset_collateral(&env, &user, &asset)
    }

    pub fn get_user_max_borrow(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let max = compute_max_borrow(&env, &user);
        let borrowed = read_user_borrowed(&env, &user);
        if max > borrowed { max - borrowed } else { 0 }
    }

    pub fn health_factor(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let borrowed = read_user_borrowed(&env, &user);
        compute_health_factor_multi(&env, &user, borrowed)
    }

    pub fn get_asset_config(env: Env, asset: Address) -> AssetConfig {
        extend_instance(&env);
        read_asset_config(&env, &asset)
    }

    pub fn get_supported_assets(env: Env) -> Vec<Address> {
        extend_instance(&env);
        read_supported_assets(&env)
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
        let sxlm = read_sxlm_token(&env);
        read_asset_config(&env, &sxlm).price_in_xlm
    }

    pub fn get_collateral_factor(env: Env) -> i128 {
        extend_instance(&env);
        let sxlm = read_sxlm_token(&env);
        read_asset_config(&env, &sxlm).collateral_factor_bps
    }

    pub fn get_liquidation_threshold(env: Env) -> i128 {
        extend_instance(&env);
        let sxlm = read_sxlm_token(&env);
        read_asset_config(&env, &sxlm).liquidation_threshold_bps
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

// ==========================================================
// Tests
// ==========================================================

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token::StellarAssetClient, Env};

    /// Returns (env, contract_id, sxlm_id, native_id, usdc_id, user, liquidator, admin)
    fn setup_test() -> (
        Env,
        Address,
        Address,
        Address,
        Address,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let liquidator = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let native_id = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let usdc_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();

        let contract_id = env.register_contract(None, LendingContract);
        let client = LendingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &native_id, &7000, &8000, &500);

        // Mint sXLM to user and liquidator.
        StellarAssetClient::new(&env, &sxlm_id).mint(&user, &100_000_0000000);
        StellarAssetClient::new(&env, &sxlm_id).mint(&liquidator, &50_000_0000000);

        // Mint USDC to user (simulate 9 decimal precision → adjust below; using 7 decimals).
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &100_000_0000000);

        // Fund pool with XLM.
        StellarAssetClient::new(&env, &native_id).mint(&contract_id, &500_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&liquidator, &100_000_0000000);

        (env, contract_id, sxlm_id, native_id, usdc_id, user, liquidator, admin)
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, sxlm_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        assert_eq!(client.total_borrowed(), 0);
        assert_eq!(client.total_collateral(), 0);
        assert_eq!(client.get_exchange_rate(), RATE_PRECISION);
        // sXLM should be in supported assets.
        let assets = client.get_supported_assets();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets.get(0).unwrap(), sxlm_id);
    }

    #[test]
    fn test_deposit_and_borrow() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Deposit 1000 sXLM.
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        let (col, bor) = client.get_position(&user);
        assert_eq!(col, 10_000_000_000); // XLM value = sXLM amount at 1:1
        assert_eq!(bor, 0);

        // Borrow 700 XLM (70% CF).
        client.borrow(&user, &7_000_000_000);
        let (col2, bor2) = client.get_position(&user);
        assert_eq!(col2, 10_000_000_000);
        assert_eq!(bor2, 7_000_000_000);
    }

    #[test]
    #[should_panic(expected = "borrow exceeds collateral limit")]
    fn test_borrow_exceeds_limit() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        // 80% > 70% CF → should panic.
        client.borrow(&user, &8_000_000_000);
    }

    #[test]
    fn test_repay() {
        let (env, contract_id, sxlm_id, native_id, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        StellarAssetClient::new(&env, &native_id).mint(&user, &100_000_0000000);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);
        client.repay(&user, &3_000_000_000);

        let (_, bor) = client.get_position(&user);
        assert_eq!(bor, 2_000_000_000);
    }

    #[test]
    fn test_withdraw_collateral() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.withdraw_collateral(&user, &sxlm_id, &5_000_000_000);
        let (col, _) = client.get_position(&user);
        assert_eq!(col, 5_000_000_000);
    }

    #[test]
    #[should_panic(expected = "withdrawal would make position unhealthy")]
    fn test_withdraw_unhealthy() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &7_000_000_000); // max borrow at CF=70%

        // With LT=80%, health after withdrawing 2000 sXLM:
        // weighted = 8000 * 0.8 = 6400 XLM → HF = 6400/7000 ≈ 0.914 < 1.0 → should panic.
        client.withdraw_collateral(&user, &sxlm_id, &2_000_000_000);
    }

    #[test]
    fn test_health_factor() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // HF = (10000 * price * LT / (RATE_PRECISION * BPS)) * RATE_PRECISION / 5000
        //    = (10000 * 1e7 * 8000 / (1e7 * 10000)) * 1e7 / 5000
        //    = 8000 * 1e7 / 5000 = 16_000_000
        let hf = client.health_factor(&user);
        assert_eq!(hf, 16_000_000); // 1.6 × 1e7
    }

    #[test]
    fn test_health_factor_with_exchange_rate() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // Increase sXLM price to 1.2 (12_000_000).
        client.update_exchange_rate(&12_000_000);

        // HF = (10000 * 12_000_000 * 8000 / (1e7 * 10000)) * 1e7 / 5000
        //    = (10000 * 1.2 * 0.8) * 1e7 / 5000 = 9600 * 1e7 / 5000 = 19_200_000
        let hf = client.health_factor(&user);
        assert_eq!(hf, 19_200_000);
    }

    #[test]
    fn test_exchange_rate_increases_borrow_capacity() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000); // 1000 sXLM

        // At 1:1, max_borrow = 1000 * 0.7 = 700.
        client.borrow(&user, &7_000_000_000);

        // Increase price to 1.5 → max_borrow = 1000 * 1.5 * 0.7 = 1050.
        client.update_exchange_rate(&15_000_000);
        client.borrow(&user, &3_000_000_000); // borrow 300 more

        let (_, bor) = client.get_position(&user);
        assert_eq!(bor, 10_000_000_000);
    }

    #[test]
    fn test_liquidation() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let contract2 = env.register_contract(None, LendingContract);
        let client2 = LendingContractClient::new(&env, &contract2);
        let sxlm2 = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let native2 = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();

        // Initialize with low liquidation threshold (5000) to make position liquidatable.
        client2.initialize(&admin, &sxlm2, &native2, &7000, &5000, &500);

        let u = Address::generate(&env);
        let liq = Address::generate(&env);
        StellarAssetClient::new(&env, &sxlm2).mint(&u, &100_000_0000000);
        StellarAssetClient::new(&env, &sxlm2).mint(&contract2, &100_000_0000000); // for bonus
        StellarAssetClient::new(&env, &native2).mint(&contract2, &500_000_0000000);
        StellarAssetClient::new(&env, &native2).mint(&liq, &100_000_0000000);

        client2.deposit_collateral(&u, &sxlm2, &10_000_000_000);
        client2.borrow(&u, &7_000_000_000);

        // HF = (10000 * 1e7 * 5000 / (1e7 * 10000)) * 1e7 / 7000
        //    = 5000 * 1e7 / 7000 ≈ 7_142_857 < RATE_PRECISION → liquidatable.
        client2.liquidate(&liq, &u, &sxlm2);

        let (col, bor) = client2.get_position(&u);
        assert_eq!(bor, 0);
        // Seized: 7000 * 1.05 = 7350 sXLM → remaining = 10000 - 7350 = 2650 (in XLM value at 1:1).
        assert_eq!(col, 2_650_000_000);
    }

    #[test]
    fn test_multi_asset_collateral() {
        let (env, contract_id, sxlm_id, _, usdc_id, user, _, admin) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Register USDC: CF=90%, LT=92%, price=8.33 XLM (1 USDC ≈ 8.33 XLM at ~$0.12/XLM).
        // price_in_xlm = 83_333_333 (8.3333 * RATE_PRECISION)
        client.set_asset_config(&usdc_id, &9000, &9200, &83_333_333);

        // Deposit 100 sXLM + 10 USDC.
        client.deposit_collateral(&user, &sxlm_id, &1_000_000_000); // 100 sXLM
        client.deposit_collateral(&user, &usdc_id, &100_000_000); // 10 USDC

        // sXLM value = 100 * 1e7 / 1e7 = 100 XLM
        // USDC value = 10 * 83_333_333 / 1e7 ≈ 83.333 XLM
        // total ≈ 183.333 XLM
        let (col, _) = client.get_position(&user);
        assert!(col > 1_800_000_000, "collateral value should exceed 180 XLM");

        // max_borrow_sxlm = 100 * 0.7 = 70 XLM
        // max_borrow_usdc = 83.333 * 0.9 = 75 XLM
        // total max_borrow ≈ 145 XLM
        let max_borrow = client.get_user_max_borrow(&user);
        assert!(max_borrow > 1_400_000_000, "max borrow should exceed 140 XLM");

        // Also confirm per-asset queries.
        assert_eq!(client.get_asset_position(&user, &sxlm_id), 1_000_000_000);
        assert_eq!(client.get_asset_position(&user, &usdc_id), 100_000_000);
    }

    #[test]
    fn test_admin_update_collateral_factor() {
        let (env, contract_id, _, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        assert_eq!(client.get_collateral_factor(), 7000);
        client.update_collateral_factor(&7500);
        assert_eq!(client.get_collateral_factor(), 7500);
    }

    #[test]
    fn test_totals() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &sxlm_id).mint(&user2, &100_000_0000000);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.deposit_collateral(&user2, &sxlm_id, &5_000_000_000);

        // At 1:1 price, XLM value = sXLM amount.
        assert_eq!(client.total_collateral(), 15_000_000_000);

        client.borrow(&user, &3_000_000_000);
        client.borrow(&user2, &2_000_000_000);

        assert_eq!(client.total_borrowed(), 5_000_000_000);
    }
}

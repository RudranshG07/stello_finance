#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Vec};

const BPS_DENOMINATOR: i128 = 10_000;
const RATE_PRECISION: i128 = 10_000_000; // 1e7
const DEFAULT_LIQUIDATION_BONUS_BPS: i128 = 500; // 5% bonus
const MAX_SUPPORTED_ASSETS: u32 = 10;

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;        // bump to ~30 days
const USER_LIFETIME_THRESHOLD: u32 = 518_400;     // ~30 days
const USER_BUMP_AMOUNT: u32 = 3_110_400;          // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    NativeToken,
    BorrowRateBps,
    LiquidationBonusBps,
    Initialized,
    TotalBorrowed,
    // Multi-asset collateral registry
    SupportedAssets,                       // Vec<Address>
    AssetCfg(Address),                     // AssetConfig per collateral asset
    TotalCollateralByAsset(Address),       // protocol-wide total deposited per asset
    UserAssetCollateral(Address, Address), // (user, asset) → amount
    Borrowed(Address),                     // per-user borrowed XLM
}

/// Per-asset configuration stored on-chain.
#[derive(Clone)]
#[contracttype]
pub struct AssetConfig {
    /// Maximum borrow capacity as a fraction of collateral value (BPS, e.g. 7500 = 75%).
    pub collateral_factor_bps: i128,
    /// Health-factor threshold at which liquidation is permitted (BPS, e.g. 8000 = 80%).
    pub liquidation_threshold_bps: i128,
    /// Asset price expressed in XLM-stroops per 1 asset-stroop, scaled by RATE_PRECISION.
    /// Example: 1:1 (sXLM ≈ XLM) → RATE_PRECISION (10_000_000).
    ///          USDC when XLM=$0.10 → 10 * RATE_PRECISION (100_000_000).
    pub price_in_xlm: i128,
}

/// Returned by get_multi_position – one entry per deposited asset.
#[derive(Clone)]
#[contracttype]
pub struct AssetPosition {
    pub asset: Address,
    pub amount: i128,
}

// --- Storage helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_native_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::NativeToken).unwrap()
}

fn read_supported_assets(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::SupportedAssets)
        .unwrap_or_else(|| Vec::new(env))
}

fn read_asset_config(env: &Env, asset: &Address) -> AssetConfig {
    env.storage()
        .instance()
        .get(&DataKey::AssetCfg(asset.clone()))
        .unwrap_or(AssetConfig {
            collateral_factor_bps: 7000,
            liquidation_threshold_bps: 8000,
            price_in_xlm: RATE_PRECISION,
        })
}

fn read_user_asset_collateral(env: &Env, user: &Address, asset: &Address) -> i128 {
    let key = DataKey::UserAssetCollateral(user.clone(), asset.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
    val
}

fn write_user_asset_collateral(env: &Env, user: &Address, asset: &Address, val: i128) {
    let key = DataKey::UserAssetCollateral(user.clone(), asset.clone());
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

fn read_i128_instance(env: &Env, key: &DataKey) -> i128 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn write_i128_instance(env: &Env, key: &DataKey, val: i128) {
    env.storage().instance().set(key, &val);
}

fn read_liquidation_bonus(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LiquidationBonusBps)
        .unwrap_or(DEFAULT_LIQUIDATION_BONUS_BPS)
}

/// Sum weighted collateral across all deposited assets.
///
/// weighted_collateral = Σ (col_i × price_i × factor_i) / (BPS × RATE_PRECISION)
///
/// Result is in XLM-stroops. Health Factor = weighted_collateral × RATE_PRECISION / borrowed.
/// `use_lt = true`  → uses liquidation_threshold_bps  (for liquidation checks and HF display).
/// `use_lt = false` → uses collateral_factor_bps       (for borrow-limit and withdraw checks).
fn compute_weighted_collateral(env: &Env, user: &Address, use_lt: bool) -> i128 {
    let assets = read_supported_assets(env);
    let mut weighted: i128 = 0;
    for asset in assets.iter() {
        let col = read_user_asset_collateral(env, user, &asset);
        if col == 0 {
            continue;
        }
        let cfg = read_asset_config(env, &asset);
        let factor = if use_lt {
            cfg.liquidation_threshold_bps
        } else {
            cfg.collateral_factor_bps
        };
        weighted += col * cfg.price_in_xlm * factor / (BPS_DENOMINATOR * RATE_PRECISION);
    }
    weighted
}

/// Same as compute_weighted_collateral but substitutes `override_amount` for `override_asset`.
/// Used by withdraw_collateral to check post-withdrawal health without writing to storage first.
fn compute_weighted_collateral_with_override(
    env: &Env,
    user: &Address,
    override_asset: &Address,
    override_amount: i128,
    use_lt: bool,
) -> i128 {
    let assets = read_supported_assets(env);
    let mut weighted: i128 = 0;
    for asset in assets.iter() {
        let col = if &asset == override_asset {
            override_amount
        } else {
            read_user_asset_collateral(env, user, &asset)
        };
        if col == 0 {
            continue;
        }
        let cfg = read_asset_config(env, &asset);
        let factor = if use_lt {
            cfg.liquidation_threshold_bps
        } else {
            cfg.collateral_factor_bps
        };
        weighted += col * cfg.price_in_xlm * factor / (BPS_DENOMINATOR * RATE_PRECISION);
    }
    weighted
}

#[contract]
pub struct LendingContract;

#[contractimpl]
impl LendingContract {
    /// Initialize the lending contract. Registers sXLM as the first supported collateral.
    pub fn initialize(
        env: Env,
        admin: Address,
        sxlm_token: Address,
        native_token: Address,
        sxlm_collateral_factor_bps: u32,
        sxlm_liquidation_threshold_bps: u32,
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
        env.storage().instance().set(&DataKey::NativeToken, &native_token);
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(borrow_rate_bps as i128));
        env.storage()
            .instance()
            .set(&DataKey::LiquidationBonusBps, &DEFAULT_LIQUIDATION_BONUS_BPS);

        // Register sXLM as first supported collateral (1:1 price with XLM initially)
        let sxlm_config = AssetConfig {
            collateral_factor_bps: sxlm_collateral_factor_bps as i128,
            liquidation_threshold_bps: sxlm_liquidation_threshold_bps as i128,
            price_in_xlm: RATE_PRECISION,
        };
        let mut assets: Vec<Address> = Vec::new(&env);
        assets.push_back(sxlm_token.clone());
        env.storage()
            .instance()
            .set(&DataKey::SupportedAssets, &assets);
        env.storage()
            .instance()
            .set(&DataKey::AssetCfg(sxlm_token), &sxlm_config);

        extend_instance(&env);
    }

    /// Upgrade the contract WASM. Only callable by admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        read_admin(&env).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Bump instance TTL — can be called by anyone to keep contract alive.
    pub fn bump_instance(env: Env) {
        extend_instance(&env);
    }

    // ==========================================================
    // Admin functions
    // ==========================================================

    /// Add a new collateral asset or update configuration of an existing one.
    /// Only callable by admin (governance).
    pub fn configure_asset(
        env: Env,
        asset: Address,
        collateral_factor_bps: u32,
        liquidation_threshold_bps: u32,
        price_in_xlm: i128,
    ) {
        read_admin(&env).require_auth();
        assert!(
            collateral_factor_bps > 0 && collateral_factor_bps <= 10_000,
            "invalid collateral factor"
        );
        assert!(
            liquidation_threshold_bps > 0 && liquidation_threshold_bps <= 10_000,
            "invalid liquidation threshold"
        );
        assert!(
            collateral_factor_bps <= liquidation_threshold_bps,
            "CF must be <= LT"
        );
        assert!(price_in_xlm > 0, "price must be positive");
        extend_instance(&env);

        let config = AssetConfig {
            collateral_factor_bps: collateral_factor_bps as i128,
            liquidation_threshold_bps: liquidation_threshold_bps as i128,
            price_in_xlm,
        };

        // Add to supported list if not already present
        let mut assets = read_supported_assets(&env);
        if !assets.contains(&asset) {
            assert!(assets.len() < MAX_SUPPORTED_ASSETS, "max assets reached");
            assets.push_back(asset.clone());
            env.storage()
                .instance()
                .set(&DataKey::SupportedAssets, &assets);
        }
        env.storage()
            .instance()
            .set(&DataKey::AssetCfg(asset.clone()), &config);

        env.events().publish(
            (soroban_sdk::symbol_short!("asset_cfg"),),
            (asset, collateral_factor_bps, price_in_xlm),
        );
    }

    /// Update the price of a supported collateral asset (oracle price feed).
    /// Only callable by admin.
    pub fn update_asset_price(env: Env, asset: Address, price_in_xlm: i128) {
        read_admin(&env).require_auth();
        assert!(price_in_xlm > 0, "price must be positive");
        extend_instance(&env);

        let mut config = read_asset_config(&env, &asset);
        config.price_in_xlm = price_in_xlm;
        env.storage()
            .instance()
            .set(&DataKey::AssetCfg(asset.clone()), &config);

        env.events().publish(
            (soroban_sdk::symbol_short!("price_upd"),),
            (asset, price_in_xlm),
        );
    }

    /// Update the borrow rate. Only callable by admin.
    pub fn update_borrow_rate(env: Env, new_rate_bps: u32) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(new_rate_bps as i128));
    }

    /// Update the liquidation bonus. Only callable by admin.
    pub fn update_liquidation_bonus(env: Env, new_bonus_bps: u32) {
        read_admin(&env).require_auth();
        assert!(new_bonus_bps <= 3000, "bonus too high");
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::LiquidationBonusBps, &(new_bonus_bps as i128));
    }

    // ==========================================================
    // Core lending functions
    // ==========================================================

    /// Deposit any supported collateral asset.
    pub fn deposit_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        // Verify asset is whitelisted
        let assets = read_supported_assets(&env);
        assert!(assets.contains(&asset), "unsupported collateral asset");

        // Transfer from user to contract
        token::Client::new(&env, &asset).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        // Update user's per-asset collateral
        let current = read_user_asset_collateral(&env, &user, &asset);
        write_user_asset_collateral(&env, &user, &asset, current + amount);

        // Update protocol-wide total for this asset
        let total_key = DataKey::TotalCollateralByAsset(asset.clone());
        let total = read_i128_instance(&env, &total_key);
        write_i128_instance(&env, &total_key, total + amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (user, asset, amount),
        );
    }

    /// Withdraw collateral for a specific asset, provided the position stays healthy.
    pub fn withdraw_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        extend_instance(&env);

        let current = read_user_asset_collateral(&env, &user, &asset);
        assert!(current >= amount, "insufficient collateral");

        let new_amount = current - amount;
        let borrowed = read_user_borrowed(&env, &user);

        if borrowed > 0 {
            // Check health factor using CF (same threshold as borrow) with hypothetical new balance.
            let weighted = compute_weighted_collateral_with_override(
                &env, &user, &asset, new_amount, false,
            );
            let hf = weighted * RATE_PRECISION / borrowed;
            assert!(hf >= RATE_PRECISION, "withdrawal would make position unhealthy");
        }

        write_user_asset_collateral(&env, &user, &asset, new_amount);

        let total_key = DataKey::TotalCollateralByAsset(asset.clone());
        let total = read_i128_instance(&env, &total_key);
        write_i128_instance(&env, &total_key, total - amount);

        token::Client::new(&env, &asset).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );

        env.events().publish(
            (soroban_sdk::symbol_short!("withdraw"),),
            (user, asset, amount),
        );
    }

    /// Borrow XLM against the combined value of all deposited collateral.
    pub fn borrow(env: Env, user: Address, xlm_amount: i128) {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let current_borrowed = read_user_borrowed(&env, &user);
        let new_borrowed = current_borrowed + xlm_amount;

        // max_borrow = Σ (col_i × price_i × cf_i) / (BPS × RATE_PRECISION)
        let max_borrow = compute_weighted_collateral(&env, &user, false);
        assert!(new_borrowed <= max_borrow, "borrow exceeds collateral limit");

        let native = read_native_token(&env);
        let native_client = token::Client::new(&env, &native);

        let pool_balance = native_client.balance(&env.current_contract_address());
        assert!(pool_balance >= xlm_amount, "insufficient pool liquidity");

        write_user_borrowed(&env, &user, new_borrowed);

        let total = read_i128_instance(&env, &DataKey::TotalBorrowed);
        write_i128_instance(&env, &DataKey::TotalBorrowed, total + xlm_amount);

        native_client.transfer(&env.current_contract_address(), &user, &xlm_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("borrow"),),
            (user, xlm_amount),
        );
    }

    /// Repay borrowed XLM (partial or full).
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

        token::Client::new(&env, &read_native_token(&env)).transfer(
            &user,
            &env.current_contract_address(),
            &repay_amount,
        );

        write_user_borrowed(&env, &user, borrowed - repay_amount);

        let total = read_i128_instance(&env, &DataKey::TotalBorrowed);
        write_i128_instance(&env, &DataKey::TotalBorrowed, total - repay_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("repay"),),
            (user, repay_amount),
        );
    }

    /// Liquidate an unhealthy position (health factor < 1.0).
    ///
    /// The liquidator:
    ///   1. Repays the borrower's full XLM debt.
    ///   2. Receives `collateral_asset` tokens worth (debt × (1 + bonus)) at the current price.
    ///      If the borrower's balance of that asset is insufficient, the liquidator receives
    ///      whatever is available (capped).
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

        // Validate the collateral asset is in the supported whitelist
        let assets = read_supported_assets(&env);
        assert!(assets.contains(&collateral_asset), "unsupported collateral asset");

        // Use liquidation threshold to determine eligibility
        let weighted_lt = compute_weighted_collateral(&env, &borrower, true);
        let hf = weighted_lt * RATE_PRECISION / borrowed;
        assert!(hf < RATE_PRECISION, "position is healthy, cannot liquidate");

        // Ensure the borrower actually holds collateral in the requested asset
        let available = read_user_asset_collateral(&env, &borrower, &collateral_asset);
        assert!(available > 0, "borrower has no collateral in specified asset");

        // Liquidator repays full debt
        token::Client::new(&env, &read_native_token(&env)).transfer(
            &liquidator,
            &env.current_contract_address(),
            &borrowed,
        );

        // Compute how many units of collateral_asset to seize:
        // asset_to_seize = debt × (1 + bonus_bps/BPS) × RATE_PRECISION / price_in_xlm
        let bonus_bps = read_liquidation_bonus(&env);
        let cfg = read_asset_config(&env, &collateral_asset);
        let debt_with_bonus = borrowed * (BPS_DENOMINATOR + bonus_bps) / BPS_DENOMINATOR;
        let asset_to_seize = debt_with_bonus * RATE_PRECISION / cfg.price_in_xlm;

        let collateral_to_send = if asset_to_seize > available {
            available
        } else {
            asset_to_seize
        };

        // Transfer seized collateral to liquidator
        if collateral_to_send > 0 {
            token::Client::new(&env, &collateral_asset).transfer(
                &env.current_contract_address(),
                &liquidator,
                &collateral_to_send,
            );
        }

        // Update borrower state
        let remaining = available - collateral_to_send;
        write_user_asset_collateral(&env, &borrower, &collateral_asset, remaining);

        let total_key = DataKey::TotalCollateralByAsset(collateral_asset.clone());
        let total = read_i128_instance(&env, &total_key);
        write_i128_instance(&env, &total_key, total - collateral_to_send);

        write_user_borrowed(&env, &borrower, 0);
        let total_borrowed = read_i128_instance(&env, &DataKey::TotalBorrowed);
        write_i128_instance(&env, &DataKey::TotalBorrowed, total_borrowed - borrowed);

        env.events().publish(
            (soroban_sdk::symbol_short!("liq"),),
            (liquidator, borrower, borrowed, collateral_asset, collateral_to_send),
        );
    }

    // ==========================================================
    // View functions
    // ==========================================================

    /// Returns all whitelisted collateral asset addresses.
    pub fn get_supported_assets(env: Env) -> Vec<Address> {
        extend_instance(&env);
        read_supported_assets(&env)
    }

    /// Returns the configuration for a given collateral asset.
    pub fn get_asset_config(env: Env, asset: Address) -> AssetConfig {
        extend_instance(&env);
        read_asset_config(&env, &asset)
    }

    /// Returns all collateral positions for a user as a list of (asset, amount) entries.
    /// Only assets with a non-zero balance are included.
    pub fn get_multi_position(env: Env, user: Address) -> Vec<AssetPosition> {
        extend_instance(&env);
        let assets = read_supported_assets(&env);
        let mut result: Vec<AssetPosition> = Vec::new(&env);
        for asset in assets.iter() {
            let amount = read_user_asset_collateral(&env, &user, &asset);
            if amount > 0 {
                result.push_back(AssetPosition {
                    asset,
                    amount,
                });
            }
        }
        result
    }

    /// Returns a single asset's collateral balance for a user.
    pub fn get_user_asset_collateral(env: Env, user: Address, asset: Address) -> i128 {
        extend_instance(&env);
        read_user_asset_collateral(&env, &user, &asset)
    }

    /// Returns (total_collateral_value_in_xlm_stroops, xlm_borrowed) for backward compatibility.
    /// The first element is the sum of (col_i × price_i / RATE_PRECISION) across all assets.
    pub fn get_position(env: Env, user: Address) -> (i128, i128) {
        extend_instance(&env);
        let borrowed = read_user_borrowed(&env, &user);
        let assets = read_supported_assets(&env);
        let mut total_value: i128 = 0;
        for asset in assets.iter() {
            let col = read_user_asset_collateral(&env, &user, &asset);
            if col == 0 {
                continue;
            }
            let cfg = read_asset_config(&env, &asset);
            total_value += col * cfg.price_in_xlm / RATE_PRECISION;
        }
        (total_value, borrowed)
    }

    /// Returns health factor scaled by RATE_PRECISION (1e7 = 1.0).
    /// Uses liquidation threshold to match what liquidate() checks.
    pub fn health_factor(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let borrowed = read_user_borrowed(&env, &user);
        if borrowed == 0 {
            return i128::MAX;
        }
        let weighted = compute_weighted_collateral(&env, &user, true);
        weighted * RATE_PRECISION / borrowed
    }

    pub fn total_borrowed(env: Env) -> i128 {
        extend_instance(&env);
        read_i128_instance(&env, &DataKey::TotalBorrowed)
    }

    /// Total deposited amount (raw, not price-adjusted) for a specific collateral asset.
    pub fn total_collateral_by_asset(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        read_i128_instance(&env, &DataKey::TotalCollateralByAsset(asset))
    }

    /// Sum of raw deposit amounts across all supported assets (no price weighting).
    pub fn total_collateral(env: Env) -> i128 {
        extend_instance(&env);
        let assets = read_supported_assets(&env);
        let mut total: i128 = 0;
        for asset in assets.iter() {
            total += read_i128_instance(&env, &DataKey::TotalCollateralByAsset(asset));
        }
        total
    }

    pub fn get_borrow_rate(env: Env) -> i128 {
        extend_instance(&env);
        read_i128_instance(&env, &DataKey::BorrowRateBps)
    }

    pub fn get_liquidation_bonus(env: Env) -> i128 {
        extend_instance(&env);
        read_liquidation_bonus(&env)
    }

    pub fn get_pool_balance(env: Env) -> i128 {
        extend_instance(&env);
        let native = read_native_token(&env);
        token::Client::new(&env, &native).balance(&env.current_contract_address())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token::StellarAssetClient, Env};

    struct TestCtx {
        env: Env,
        contract_id: Address,
        sxlm_id: Address,
        usdc_id: Address,
        native_id: Address,
        user: Address,
    }

    fn setup() -> TestCtx {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sxlm_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let usdc_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id =
            env.register_stellar_asset_contract_v2(admin.clone()).address();

        let contract_id = env.register_contract(None, LendingContract);
        let client = LendingContractClient::new(&env, &contract_id);

        // Initialize: sXLM CF=70%, LT=80%, borrow rate=5%
        client.initialize(&admin, &sxlm_id, &native_id, &7000, &8000, &500);

        // Mint initial balances
        StellarAssetClient::new(&env, &sxlm_id).mint(&user, &100_000_0000000);
        StellarAssetClient::new(&env, &usdc_id).mint(&user, &100_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&contract_id, &500_000_0000000);

        TestCtx { env, contract_id, sxlm_id, usdc_id, native_id, user }
    }

    #[test]
    fn test_initialize() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        assert_eq!(c.total_borrowed(), 0);

        let assets = c.get_supported_assets();
        assert_eq!(assets.len(), 1);

        let cfg = c.get_asset_config(&t.sxlm_id);
        assert_eq!(cfg.collateral_factor_bps, 7000);
        assert_eq!(cfg.liquidation_threshold_bps, 8000);
        assert_eq!(cfg.price_in_xlm, RATE_PRECISION);
    }

    #[test]
    fn test_configure_asset() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        // Add USDC: CF=90%, LT=95%, price=10 XLM per USDC
        c.configure_asset(&t.usdc_id, &9000, &9500, &(10 * RATE_PRECISION));

        let assets = c.get_supported_assets();
        assert_eq!(assets.len(), 2);

        let cfg = c.get_asset_config(&t.usdc_id);
        assert_eq!(cfg.collateral_factor_bps, 9000);
        assert_eq!(cfg.liquidation_threshold_bps, 9500);
        assert_eq!(cfg.price_in_xlm, 100_000_000);
    }

    #[test]
    fn test_deposit_and_borrow_single_asset() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        // Deposit 1000 sXLM (price 1:1 XLM)
        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);

        let positions = c.get_multi_position(&t.user);
        assert_eq!(positions.len(), 1);
        assert_eq!(positions.get(0).unwrap().amount, 10_000_000_000);

        // Borrow 700 XLM (70% CF, 1:1 price → max = 700)
        c.borrow(&t.user, &7_000_000_000);
        assert_eq!(c.total_borrowed(), 7_000_000_000);
    }

    #[test]
    fn test_multi_asset_borrow() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        // Add USDC: CF=90%, price=10 XLM per USDC
        c.configure_asset(&t.usdc_id, &9000, &9500, &(10 * RATE_PRECISION));

        // Deposit 100 sXLM → max borrow contribution: 100 × 0.70 = 70 XLM
        c.deposit_collateral(&t.user, &t.sxlm_id, &1_000_000_000);
        // Deposit 10 USDC → max borrow contribution: 10 × 10 × 0.90 = 90 XLM
        c.deposit_collateral(&t.user, &t.usdc_id, &100_000_000);

        // Combined max borrow = 70 + 90 = 160 XLM
        // Borrow 150 XLM — within limit
        c.borrow(&t.user, &1_500_000_000);
        assert_eq!(c.total_borrowed(), 1_500_000_000);

        let hf = c.health_factor(&t.user);
        assert!(hf > RATE_PRECISION); // HF > 1.0
    }

    #[test]
    #[should_panic(expected = "borrow exceeds collateral limit")]
    fn test_borrow_exceeds_limit() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.borrow(&t.user, &8_000_000_000); // 80% > 70% CF
    }

    #[test]
    fn test_repay() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        StellarAssetClient::new(&t.env, &t.native_id).mint(&t.user, &100_000_0000000);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.borrow(&t.user, &5_000_000_000);
        c.repay(&t.user, &3_000_000_000);

        assert_eq!(c.total_borrowed(), 2_000_000_000);
    }

    #[test]
    fn test_withdraw_collateral() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.withdraw_collateral(&t.user, &t.sxlm_id, &5_000_000_000);

        assert_eq!(
            c.get_user_asset_collateral(&t.user, &t.sxlm_id),
            5_000_000_000
        );
    }

    #[test]
    #[should_panic(expected = "withdrawal would make position unhealthy")]
    fn test_withdraw_unhealthy() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.borrow(&t.user, &7_000_000_000); // max borrow at 70% CF

        // Any withdrawal should now fail
        c.withdraw_collateral(&t.user, &t.sxlm_id, &1_000_000_000);
    }

    #[test]
    fn test_health_factor_single_asset() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.borrow(&t.user, &5_000_000_000);

        // weighted (LT=8000): 10e9 × 1e7 × 8000 / (10000 × 1e7) = 8e9
        // HF = 8e9 × 1e7 / 5e9 = 16_000_000
        let hf = c.health_factor(&t.user);
        assert_eq!(hf, 16_000_000); // 1.6 × RATE_PRECISION
    }

    #[test]
    fn test_update_asset_price() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.borrow(&t.user, &5_000_000_000);

        // Increase sXLM price to 1.2× XLM
        c.update_asset_price(&t.sxlm_id, &12_000_000);

        // weighted (LT=8000): 10e9 × 12e6 × 8000 / (10000 × 10e6) = 9.6e9
        // HF = 9.6e9 × 1e7 / 5e9 = 19_200_000
        let hf = c.health_factor(&t.user);
        assert_eq!(hf, 19_200_000); // 1.92 × RATE_PRECISION
    }

    #[test]
    fn test_price_increase_boosts_borrow_capacity() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        // Borrow max at 1:1 price, CF=70%: 700 XLM
        c.borrow(&t.user, &7_000_000_000);

        // Increase price to 1.5× → new max = 1000 × 1.5 × 0.70 = 1050 XLM
        c.update_asset_price(&t.sxlm_id, &15_000_000);

        // Can now borrow 300 more (1050 - 700)
        c.borrow(&t.user, &3_000_000_000);
        assert_eq!(c.total_borrowed(), 10_000_000_000);
    }

    #[test]
    fn test_liquidation() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let u = Address::generate(&env);
        let liq = Address::generate(&env);

        // Use a low liquidation threshold (50%) so a 70% borrow is immediately liquidatable
        let sxlm2 =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native2 =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let contract2 = env.register_contract(None, LendingContract);
        let c2 = LendingContractClient::new(&env, &contract2);
        c2.initialize(&admin, &sxlm2, &native2, &7000, &5000, &500);

        StellarAssetClient::new(&env, &sxlm2).mint(&u, &100_000_0000000);
        StellarAssetClient::new(&env, &sxlm2).mint(&contract2, &100_000_0000000);
        StellarAssetClient::new(&env, &native2).mint(&contract2, &500_000_0000000);
        StellarAssetClient::new(&env, &native2).mint(&liq, &100_000_0000000);

        c2.deposit_collateral(&u, &sxlm2, &10_000_000_000); // 1000 sXLM
        c2.borrow(&u, &7_000_000_000);                       // 700 XLM
        // HF (LT=50%): weighted = 10e9 × 1e7 × 5000 / (10000 × 1e7) = 5e9
        // HF = 5e9 × 1e7 / 7e9 ≈ 7_142_857 < RATE_PRECISION → liquidatable

        c2.liquidate(&liq, &u, &sxlm2);

        let (_, bor) = c2.get_position(&u);
        assert_eq!(bor, 0);

        // asset_to_seize = 7e9 × 1.05 × 1e7 / 1e7 = 7_350_000_000
        // remaining = 10e9 − 7_350_000_000 = 2_650_000_000
        let remaining = c2.get_user_asset_collateral(&u, &sxlm2);
        assert_eq!(remaining, 2_650_000_000);
    }

    #[test]
    #[should_panic(expected = "unsupported collateral asset")]
    fn test_unsupported_asset_deposit_fails() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);
        // USDC not configured yet
        c.deposit_collateral(&t.user, &t.usdc_id, &1_000_000_000);
    }

    #[test]
    fn test_totals() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        let user2 = Address::generate(&t.env);
        StellarAssetClient::new(&t.env, &t.sxlm_id).mint(&user2, &100_000_0000000);

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.deposit_collateral(&user2, &t.sxlm_id, &5_000_000_000);
        assert_eq!(c.total_collateral_by_asset(&t.sxlm_id), 15_000_000_000);

        c.borrow(&t.user, &3_000_000_000);
        c.borrow(&user2, &2_000_000_000);
        assert_eq!(c.total_borrowed(), 5_000_000_000);
    }

    #[test]
    fn test_multi_asset_totals() {
        let t = setup();
        let c = LendingContractClient::new(&t.env, &t.contract_id);

        c.configure_asset(&t.usdc_id, &9000, &9500, &(10 * RATE_PRECISION));

        c.deposit_collateral(&t.user, &t.sxlm_id, &10_000_000_000);
        c.deposit_collateral(&t.user, &t.usdc_id, &5_000_000_000);

        assert_eq!(c.total_collateral_by_asset(&t.sxlm_id), 10_000_000_000);
        assert_eq!(c.total_collateral_by_asset(&t.usdc_id), 5_000_000_000);
        assert_eq!(c.total_collateral(), 15_000_000_000); // raw sum
    }
}

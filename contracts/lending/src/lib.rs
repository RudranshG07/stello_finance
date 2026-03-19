#![no_std]

use price_feed::PriceFeedContractClient;
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Vec};

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

// ---------- UI-friendly view types ----------

/// Full configuration for one supported collateral asset.
#[derive(Clone)]
#[contracttype]
pub struct CollateralConfig {
    pub asset: Address,
    pub cf_bps: i128,
    pub lt_bps: i128,
    pub total_deposited: i128,
}

/// A single entry in a user's collateral portfolio.
#[derive(Clone)]
#[contracttype]
pub struct UserCollateralEntry {
    pub asset: Address,
    pub amount: i128,
}

/// Snapshot of a user's full lending position, ready for UI rendering.
#[derive(Clone)]
#[contracttype]
pub struct UserPositionDetail {
    /// Per-asset collateral balances (one entry per supported asset; amount=0 if none).
    pub collaterals: Vec<UserCollateralEntry>,
    /// Total XLM-stroop value of all collateral at current oracle prices.
    pub collateral_value_xlm: i128,
    /// Outstanding XLM-stroop debt.
    pub borrowed: i128,
    /// Health factor scaled by RATE_PRECISION (i128::MAX when debt==0).
    pub health_factor: i128,
    /// Additional XLM the user can still borrow (0 if already at or over limit).
    pub max_borrow: i128,
}

// ---------- Storage keys ----------

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    /// Address of the on-chain price-feed contract.
    PriceFeed,
    /// Address of the native XLM token (for borrowing).
    NativeToken,
    BorrowRateBps,
    LiquidationBonusBps,
    Initialized,
    /// Ordered list of supported collateral asset addresses (Vec<Address>).
    SupportedCollaterals,
    /// Per-asset collateral factor in bps (instance storage).
    CollateralFactor(Address),
    /// Per-asset liquidation threshold in bps (instance storage).
    LiquidationThreshold(Address),
    /// Per-asset total collateral deposited in the pool (instance storage).
    TotalCollateral(Address),
    /// Global total XLM borrowed (instance storage).
    TotalBorrowed,
    /// Per-(asset, user) collateral balance (persistent storage).
    Collateral(Address, Address),
    /// Per-user XLM borrowed (persistent storage).
    Borrowed(Address),
}

// ---------- Storage helpers ----------

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
    let supported = read_supported_collaterals(env);
    for asset in supported.iter() {
        let col_key = DataKey::Collateral(asset.clone(), user.clone());
        if env.storage().persistent().has(&col_key) {
            env.storage()
                .persistent()
                .extend_ttl(&col_key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
        }
    }
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_native_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::NativeToken).unwrap()
}

fn read_price_feed_addr(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::PriceFeed).unwrap()
}

fn read_supported_collaterals(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::SupportedCollaterals)
        .unwrap_or_else(|| Vec::new(env))
}

fn write_supported_collaterals(env: &Env, assets: &Vec<Address>) {
    env.storage()
        .instance()
        .set(&DataKey::SupportedCollaterals, assets);
}

fn is_supported(env: &Env, asset: &Address) -> bool {
    for a in read_supported_collaterals(env).iter() {
        if a == *asset {
            return true;
        }
    }
    false
}

fn read_collateral_factor(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::CollateralFactor(asset.clone()))
        .unwrap_or(0)
}

fn write_collateral_factor(env: &Env, asset: &Address, val: i128) {
    env.storage()
        .instance()
        .set(&DataKey::CollateralFactor(asset.clone()), &val);
}

fn read_liquidation_threshold(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LiquidationThreshold(asset.clone()))
        .unwrap_or(0)
}

fn write_liquidation_threshold(env: &Env, asset: &Address, val: i128) {
    env.storage()
        .instance()
        .set(&DataKey::LiquidationThreshold(asset.clone()), &val);
}

fn read_liquidation_bonus(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LiquidationBonusBps)
        .unwrap_or(DEFAULT_LIQUIDATION_BONUS_BPS)
}

fn read_user_collateral(env: &Env, asset: &Address, user: &Address) -> i128 {
    let key = DataKey::Collateral(asset.clone(), user.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
    val
}

fn write_user_collateral(env: &Env, asset: &Address, user: &Address, val: i128) {
    let key = DataKey::Collateral(asset.clone(), user.clone());
    if val == 0 {
        if env.storage().persistent().has(&key) {
            env.storage().persistent().remove(&key);
        }
    } else {
        env.storage().persistent().set(&key, &val);
        env.storage()
            .persistent()
            .extend_ttl(&key, USER_LIFETIME_THRESHOLD, USER_BUMP_AMOUNT);
    }
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

fn read_total_collateral(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalCollateral(asset.clone()))
        .unwrap_or(0)
}

fn write_total_collateral(env: &Env, asset: &Address, val: i128) {
    env.storage()
        .instance()
        .set(&DataKey::TotalCollateral(asset.clone()), &val);
}

fn read_total_borrowed(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalBorrowed)
        .unwrap_or(0)
}

fn write_total_borrowed(env: &Env, val: i128) {
    env.storage().instance().set(&DataKey::TotalBorrowed, &val);
}

/// Pull the XLM-stroop price for `asset` from the on-chain price-feed contract.
/// Price is scaled by RATE_PRECISION: value_xlm_stroops = amount * price / RATE_PRECISION.
fn get_asset_price(env: &Env, asset: &Address) -> i128 {
    PriceFeedContractClient::new(env, &read_price_feed_addr(env)).get_price(asset)
}

/// Maximum XLM that `user` can borrow, across all supported collateral assets.
///
/// max_borrow = SUM( col[asset] * price[asset] * cf_bps[asset] )
///              / ( RATE_PRECISION * BPS_DENOMINATOR )
///
/// Intermediate division by RATE_PRECISION keeps values safely within i128.
fn compute_max_borrow(env: &Env, user: &Address) -> i128 {
    let supported = read_supported_collaterals(env);
    let mut max_borrow: i128 = 0;
    for asset in supported.iter() {
        let col = read_user_collateral(env, &asset, user);
        if col == 0 {
            continue;
        }
        let price = get_asset_price(env, &asset);
        let cf_bps = read_collateral_factor(env, &asset);
        max_borrow += col * price / RATE_PRECISION * cf_bps / BPS_DENOMINATOR;
    }
    max_borrow
}

/// Health factor scaled by RATE_PRECISION (>= RATE_PRECISION means healthy).
///
/// HF = SUM( col[asset] * price[asset] * lt_bps[asset] )
///      / ( BPS_DENOMINATOR * borrowed )
///
/// Equivalently computed as:
///   numerator = SUM( col * price / RATE_PRECISION * lt_bps )
///   HF = numerator * RATE_PRECISION / ( BPS_DENOMINATOR * borrowed )
fn compute_health_factor(env: &Env, user: &Address, borrowed: i128) -> i128 {
    if borrowed == 0 {
        return i128::MAX;
    }
    let supported = read_supported_collaterals(env);
    let mut numerator: i128 = 0;
    for asset in supported.iter() {
        let col = read_user_collateral(env, &asset, user);
        if col == 0 {
            continue;
        }
        let price = get_asset_price(env, &asset);
        let lt_bps = read_liquidation_threshold(env, &asset);
        numerator += col * price / RATE_PRECISION * lt_bps;
    }
    numerator * RATE_PRECISION / (BPS_DENOMINATOR * borrowed)
}

// ---------- Contract ----------

#[contract]
pub struct LendingContract;

#[contractimpl]
impl LendingContract {
    /// Initialize the lending contract.
    /// Collateral assets must be registered afterwards via `add_collateral`.
    pub fn initialize(
        env: Env,
        admin: Address,
        native_token: Address,
        price_feed: Address,
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
        env.storage().instance().set(&DataKey::PriceFeed, &price_feed);
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(borrow_rate_bps as i128));
        env.storage()
            .instance()
            .set(&DataKey::LiquidationBonusBps, &DEFAULT_LIQUIDATION_BONUS_BPS);
        extend_instance(&env);
    }

    /// Upgrade the contract WASM. Only callable by admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        read_admin(&env).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Bump instance TTL — can be called by anyone to keep the contract alive.
    pub fn bump_instance(env: Env) {
        extend_instance(&env);
    }

    // ==========================================================
    // Admin: collateral asset management
    // ==========================================================

    /// Register a new collateral asset with its per-asset risk parameters.
    /// `cf_bps`  — collateral factor in basis points  (e.g. 7000 = 70 %)
    /// `lt_bps`  — liquidation threshold in bps        (e.g. 8000 = 80 %)
    /// lt_bps must be >= cf_bps.
    pub fn add_collateral(env: Env, asset: Address, cf_bps: u32, lt_bps: u32) {
        read_admin(&env).require_auth();
        assert!(cf_bps > 0 && cf_bps <= 10_000, "invalid collateral factor");
        assert!(lt_bps > 0 && lt_bps <= 10_000, "invalid liquidation threshold");
        extend_instance(&env);

        let mut supported = read_supported_collaterals(&env);
        for a in supported.iter() {
            if a == asset {
                panic!("asset already supported");
            }
        }
        supported.push_back(asset.clone());
        write_supported_collaterals(&env, &supported);
        write_collateral_factor(&env, &asset, cf_bps as i128);
        write_liquidation_threshold(&env, &asset, lt_bps as i128);

        env.events().publish(
            (soroban_sdk::symbol_short!("add_col"),),
            (asset, cf_bps, lt_bps),
        );
    }

    /// Remove a collateral asset from the supported list.
    /// Should only be called when no users hold open positions in this asset.
    pub fn remove_collateral(env: Env, asset: Address) {
        read_admin(&env).require_auth();
        extend_instance(&env);

        let current = read_supported_collaterals(&env);
        let mut new_list = Vec::new(&env);
        let mut found = false;
        for a in current.iter() {
            if a == asset {
                found = true;
            } else {
                new_list.push_back(a);
            }
        }
        assert!(found, "asset not in supported list");
        write_supported_collaterals(&env, &new_list);
    }

    /// Update the collateral factor for a specific supported asset.
    pub fn set_collateral_factor(env: Env, asset: Address, cf_bps: u32) {
        read_admin(&env).require_auth();
        assert!(is_supported(&env, &asset), "asset not supported");
        assert!(cf_bps > 0 && cf_bps <= 10_000, "invalid collateral factor");
        extend_instance(&env);
        write_collateral_factor(&env, &asset, cf_bps as i128);

        env.events().publish(
            (soroban_sdk::symbol_short!("cf_upd"),),
            (asset, cf_bps),
        );
    }

    /// Update the liquidation threshold for a specific supported asset.
    pub fn set_liquidation_threshold(env: Env, asset: Address, lt_bps: u32) {
        read_admin(&env).require_auth();
        assert!(is_supported(&env, &asset), "asset not supported");
        assert!(lt_bps > 0 && lt_bps <= 10_000, "invalid liquidation threshold");
        extend_instance(&env);
        write_liquidation_threshold(&env, &asset, lt_bps as i128);
    }

    /// Update the price-feed contract address.
    pub fn set_price_feed(env: Env, new_price_feed: Address) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::PriceFeed, &new_price_feed);
    }

    /// Update the borrow rate.
    pub fn update_borrow_rate(env: Env, new_rate_bps: u32) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::BorrowRateBps, &(new_rate_bps as i128));
    }

    /// Update the liquidation bonus (max 50%).
    pub fn update_liquidation_bonus(env: Env, bonus_bps: u32) {
        read_admin(&env).require_auth();
        assert!(bonus_bps <= 5_000, "bonus exceeds maximum of 50%");
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::LiquidationBonusBps, &(bonus_bps as i128));
    }

    // ==========================================================
    // Core lending functions
    // ==========================================================

    /// Deposit a supported collateral asset.
    pub fn deposit_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        assert!(is_supported(&env, &asset), "asset not supported");
        extend_instance(&env);

        token::Client::new(&env, &asset).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        write_user_collateral(
            &env,
            &asset,
            &user,
            read_user_collateral(&env, &asset, &user) + amount,
        );
        write_total_collateral(
            &env,
            &asset,
            read_total_collateral(&env, &asset) + amount,
        );

        env.events().publish(
            (soroban_sdk::symbol_short!("deposit"),),
            (user, asset, amount),
        );
    }

    /// Withdraw a collateral asset, provided the position remains healthy afterwards.
    pub fn withdraw_collateral(env: Env, user: Address, asset: Address, amount: i128) {
        user.require_auth();
        assert!(amount > 0, "amount must be positive");
        assert!(is_supported(&env, &asset), "asset not supported");
        extend_instance(&env);

        let current = read_user_collateral(&env, &asset, &user);
        assert!(current >= amount, "insufficient collateral");

        // Tentatively apply the withdrawal, then health-check.
        write_user_collateral(&env, &asset, &user, current - amount);
        let borrowed = read_user_borrowed(&env, &user);
        if borrowed > 0 {
            let hf = compute_health_factor(&env, &user, borrowed);
            if hf < RATE_PRECISION {
                // Restore and revert.
                write_user_collateral(&env, &asset, &user, current);
                panic!("withdrawal would make position unhealthy");
            }
        }

        write_total_collateral(
            &env,
            &asset,
            read_total_collateral(&env, &asset) - amount,
        );

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

    /// Borrow XLM against the caller's deposited collateral (cross-asset).
    pub fn borrow(env: Env, user: Address, xlm_amount: i128) {
        user.require_auth();
        assert!(xlm_amount > 0, "amount must be positive");
        extend_instance(&env);

        let current_borrowed = read_user_borrowed(&env, &user);
        let new_borrowed = current_borrowed + xlm_amount;
        let max_borrow = compute_max_borrow(&env, &user);
        assert!(new_borrowed <= max_borrow, "borrow exceeds collateral limit");

        write_user_borrowed(&env, &user, new_borrowed);
        write_total_borrowed(&env, read_total_borrowed(&env) + xlm_amount);

        let native_client = token::Client::new(&env, &read_native_token(&env));
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
        write_total_borrowed(&env, read_total_borrowed(&env) - repay_amount);

        env.events().publish(
            (soroban_sdk::symbol_short!("repay"),),
            (user, repay_amount),
        );
    }

    /// Liquidate an unhealthy position (full-debt liquidation).
    ///
    /// The liquidator repays the full XLM debt and receives collateral (plus bonus)
    /// from `seize_assets` in the specified order until the debt value is covered.
    ///
    /// Reverts if the combined value of the specified assets is insufficient to
    /// cover `debt × (1 + bonus)`.
    pub fn liquidate(
        env: Env,
        liquidator: Address,
        borrower: Address,
        seize_assets: Vec<Address>,
    ) {
        liquidator.require_auth();
        extend_instance(&env);

        let borrowed = read_user_borrowed(&env, &borrower);
        assert!(borrowed > 0, "no debt to liquidate");

        let hf = compute_health_factor(&env, &borrower, borrowed);
        assert!(hf < RATE_PRECISION, "position is healthy, cannot liquidate");

        // Liquidator sends full debt to pool.
        token::Client::new(&env, &read_native_token(&env)).transfer(
            &liquidator,
            &env.current_contract_address(),
            &borrowed,
        );

        // XLM value the liquidator is entitled to receive in collateral.
        let bonus_bps = read_liquidation_bonus(&env);
        let debt_with_bonus = borrowed * (BPS_DENOMINATOR + bonus_bps) / BPS_DENOMINATOR;

        let mut debt_remaining = debt_with_bonus;

        for asset in seize_assets.iter() {
            if debt_remaining == 0 {
                break;
            }
            assert!(is_supported(&env, &asset), "seize asset not supported");

            let user_col = read_user_collateral(&env, &asset, &borrower);
            if user_col == 0 {
                continue;
            }

            let price = get_asset_price(&env, &asset);
            // Tokens required to cover remaining debt at this asset's price.
            let tokens_to_cover = debt_remaining * RATE_PRECISION / price;

            let seize_amount;
            if tokens_to_cover <= user_col {
                // Enough of this asset to fully cover remaining debt.
                seize_amount = tokens_to_cover;
                debt_remaining = 0;
            } else {
                // Take all of this asset and continue to the next.
                seize_amount = user_col;
                let xlm_seized = user_col * price / RATE_PRECISION;
                debt_remaining -= xlm_seized;
            }

            token::Client::new(&env, &asset).transfer(
                &env.current_contract_address(),
                &liquidator,
                &seize_amount,
            );
            write_user_collateral(&env, &asset, &borrower, user_col - seize_amount);
            write_total_collateral(
                &env,
                &asset,
                read_total_collateral(&env, &asset) - seize_amount,
            );
        }

        assert!(debt_remaining == 0, "insufficient collateral to cover debt");

        write_user_borrowed(&env, &borrower, 0);
        write_total_borrowed(&env, read_total_borrowed(&env) - borrowed);

        env.events().publish(
            (soroban_sdk::symbol_short!("liq"),),
            (liquidator, borrower, borrowed),
        );
    }

    // ==========================================================
    // Views
    // ==========================================================

    /// Returns `(total_collateral_xlm_value, borrowed)` for a user.
    ///
    /// `total_collateral_xlm_value` is the sum of each asset's balance
    /// converted to XLM stroops using current oracle prices.
    pub fn get_position(env: Env, user: Address) -> (i128, i128) {
        extend_instance(&env);
        extend_user_data(&env, &user);
        let mut total_xlm: i128 = 0;
        for asset in read_supported_collaterals(&env).iter() {
            let col = read_user_collateral(&env, &asset, &user);
            if col > 0 {
                let price = get_asset_price(&env, &asset);
                total_xlm += col * price / RATE_PRECISION;
            }
        }
        (total_xlm, read_user_borrowed(&env, &user))
    }

    /// Returns `(assets, amounts)` — every supported collateral address paired
    /// with the user's deposited balance (0 if none).
    pub fn get_user_collaterals(env: Env, user: Address) -> (Vec<Address>, Vec<i128>) {
        extend_instance(&env);
        let supported = read_supported_collaterals(&env);
        let mut amounts = Vec::new(&env);
        for asset in supported.iter() {
            amounts.push_back(read_user_collateral(&env, &asset, &user));
        }
        (supported, amounts)
    }

    /// Returns a `CollateralConfig` for every supported asset in registration order.
    ///
    /// Each entry carries the asset address, collateral factor (bps),
    /// liquidation threshold (bps), and total pool deposits for that asset —
    /// everything a UI needs to render the "Markets" or "Deposit" screen.
    pub fn get_collateral_configs(env: Env) -> Vec<CollateralConfig> {
        extend_instance(&env);
        let supported = read_supported_collaterals(&env);
        let mut configs: Vec<CollateralConfig> = Vec::new(&env);
        for asset in supported.iter() {
            configs.push_back(CollateralConfig {
                cf_bps: read_collateral_factor(&env, &asset),
                lt_bps: read_liquidation_threshold(&env, &asset),
                total_deposited: read_total_collateral(&env, &asset),
                asset,
            });
        }
        configs
    }

    /// Returns a complete, self-contained snapshot of a user's position.
    ///
    /// Includes per-asset collateral balances (zero-filled for assets the user
    /// has not deposited), the aggregate XLM-value of collateral, current debt,
    /// health factor, and remaining borrow capacity — all in a single call so
    /// that frontends and backends do not need to fan out multiple queries.
    pub fn get_user_position_detail(env: Env, user: Address) -> UserPositionDetail {
        extend_instance(&env);
        extend_user_data(&env, &user);

        let supported = read_supported_collaterals(&env);
        let borrowed = read_user_borrowed(&env, &user);

        let mut collaterals: Vec<UserCollateralEntry> = Vec::new(&env);
        let mut collateral_value_xlm: i128 = 0;

        for asset in supported.iter() {
            let amount = read_user_collateral(&env, &asset, &user);
            if amount > 0 {
                let price = get_asset_price(&env, &asset);
                collateral_value_xlm += amount * price / RATE_PRECISION;
            }
            collaterals.push_back(UserCollateralEntry {
                asset,
                amount,
            });
        }

        let health_factor = compute_health_factor(&env, &user, borrowed);

        let capacity = compute_max_borrow(&env, &user);
        let max_borrow = if capacity > borrowed {
            capacity - borrowed
        } else {
            0
        };

        UserPositionDetail {
            collaterals,
            collateral_value_xlm,
            borrowed,
            health_factor,
            max_borrow,
        }
    }

    /// Returns health factor scaled by RATE_PRECISION (1e7 = 1.0).
    /// Uses per-asset liquidation thresholds and oracle prices.
    pub fn health_factor(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let borrowed = read_user_borrowed(&env, &user);
        compute_health_factor(&env, &user, borrowed)
    }

    /// Returns the additional XLM the user can still borrow
    /// (i.e. max_borrow_capacity − already_borrowed, clamped to 0).
    pub fn max_borrow(env: Env, user: Address) -> i128 {
        extend_instance(&env);
        let already_borrowed = read_user_borrowed(&env, &user);
        let capacity = compute_max_borrow(&env, &user);
        if capacity > already_borrowed {
            capacity - already_borrowed
        } else {
            0
        }
    }

    pub fn get_supported_collaterals(env: Env) -> Vec<Address> {
        extend_instance(&env);
        read_supported_collaterals(&env)
    }

    pub fn get_collateral_factor(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        read_collateral_factor(&env, &asset)
    }

    pub fn get_liquidation_threshold(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        read_liquidation_threshold(&env, &asset)
    }

    pub fn total_borrowed(env: Env) -> i128 {
        extend_instance(&env);
        read_total_borrowed(&env)
    }

    pub fn total_collateral_for_asset(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        read_total_collateral(&env, &asset)
    }

    pub fn get_price_feed(env: Env) -> Address {
        extend_instance(&env);
        read_price_feed_addr(&env)
    }

    pub fn get_borrow_rate(env: Env) -> i128 {
        extend_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::BorrowRateBps)
            .unwrap_or(0)
    }

    pub fn get_liquidation_bonus(env: Env) -> i128 {
        extend_instance(&env);
        read_liquidation_bonus(&env)
    }

    pub fn get_pool_balance(env: Env) -> i128 {
        extend_instance(&env);
        token::Client::new(&env, &read_native_token(&env))
            .balance(&env.current_contract_address())
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

    // ---------------------------------------------------------------------------
    // Minimal mock price-feed contract used exclusively in tests.
    // It satisfies the same get_price(env, asset) -> i128 interface that the
    // lending contract calls via PriceFeedContractClient.
    // ---------------------------------------------------------------------------
    mod mock_price_feed {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

        #[derive(Clone)]
        #[contracttype]
        enum PKey {
            Price(Address),
        }

        #[contract]
        pub struct MockPriceFeed;

        #[contractimpl]
        impl MockPriceFeed {
            pub fn get_price(env: Env, asset: Address) -> i128 {
                env.storage()
                    .instance()
                    .get(&PKey::Price(asset))
                    .unwrap_or(10_000_000) // 1:1 default
            }

            pub fn set_price(env: Env, asset: Address, price: i128) {
                env.storage().instance().set(&PKey::Price(asset), &price);
            }
        }
    }

    use mock_price_feed::MockPriceFeedClient;

    /// Returns (env, lending_id, sxlm_id, native_id, price_feed_id, user, liquidator, admin).
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

        let sxlm_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        // Deploy mock price feed and price sXLM at 1:1 with XLM.
        let price_feed_id =
            env.register_contract(None, mock_price_feed::MockPriceFeed);
        MockPriceFeedClient::new(&env, &price_feed_id).set_price(&sxlm_id, &RATE_PRECISION);

        // Deploy lending contract.
        let contract_id = env.register_contract(None, LendingContract);
        let client = LendingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &native_id, &price_feed_id, &500);

        // Register sXLM as a collateral asset (CF=70 %, LT=80 %).
        client.add_collateral(&sxlm_id, &7000, &8000);

        // Mint tokens.
        StellarAssetClient::new(&env, &sxlm_id).mint(&user, &100_000_0000000);
        StellarAssetClient::new(&env, &sxlm_id).mint(&liquidator, &50_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&contract_id, &500_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&liquidator, &100_000_0000000);

        (
            env, contract_id, sxlm_id, native_id, price_feed_id, user, liquidator, admin,
        )
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, sxlm_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        assert_eq!(client.total_borrowed(), 0);
        assert_eq!(client.total_collateral_for_asset(&sxlm_id), 0);
        assert_eq!(client.get_borrow_rate(), 500);
        assert_eq!(client.get_liquidation_bonus(), DEFAULT_LIQUIDATION_BONUS_BPS);
    }

    #[test]
    fn test_add_collateral_registers_factors() {
        let (env, contract_id, sxlm_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        assert_eq!(client.get_collateral_factor(&sxlm_id), 7000);
        assert_eq!(client.get_liquidation_threshold(&sxlm_id), 8000);
        let supported = client.get_supported_collaterals();
        assert_eq!(supported.len(), 1);
        assert_eq!(supported.get(0).unwrap(), sxlm_id);
    }

    #[test]
    fn test_deposit_and_borrow() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        // Deposit 1 000 sXLM (10_000_000_000 stroops).
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        let (col_xlm, bor) = client.get_position(&user);
        assert_eq!(col_xlm, 10_000_000_000); // 1:1 price
        assert_eq!(bor, 0);

        // Borrow 700 XLM (70 % of 1 000 at 1:1 price, CF=70 %).
        client.borrow(&user, &7_000_000_000);
        let (_, bor2) = client.get_position(&user);
        assert_eq!(bor2, 7_000_000_000);
    }

    #[test]
    #[should_panic(expected = "borrow exceeds collateral limit")]
    fn test_borrow_exceeds_limit() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        // 80 % > CF 70 % → should panic.
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
        // No borrows — can withdraw freely.
        client.withdraw_collateral(&user, &sxlm_id, &5_000_000_000);
        let (col_xlm, _) = client.get_position(&user);
        assert_eq!(col_xlm, 5_000_000_000);
    }

    #[test]
    #[should_panic(expected = "withdrawal would make position unhealthy")]
    fn test_withdraw_unhealthy() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &7_000_000_000); // max borrow at CF 70 %

        // Withdraw 20 % of collateral → remaining = 8 000 XLM value.
        // HF = 8_000 * LT(80%) / 7_000 ≈ 0.914 < 1.0 → unhealthy.
        client.withdraw_collateral(&user, &sxlm_id, &2_000_000_000);
    }

    #[test]
    fn test_health_factor() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // HF = col * price / RATE_PRECISION * lt_bps * RATE_PRECISION
        //      / (BPS_DENOMINATOR * borrowed)
        // = 10_000_000_000 * 1e7 / 1e7 * 8000 * 1e7
        //   / (10_000 * 5_000_000_000)
        // = 10_000_000_000 * 8000 * 1e7 / (10_000 * 5_000_000_000)
        // = 16_000_000
        let hf = client.health_factor(&user);
        assert_eq!(hf, 16_000_000); // 1.6 × 1e7
    }

    #[test]
    fn test_health_factor_with_price_update() {
        let (env, contract_id, sxlm_id, _, price_feed_id, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);

        // Increase sXLM price to 1.2 × (12_000_000).
        MockPriceFeedClient::new(&env, &price_feed_id).set_price(&sxlm_id, &12_000_000);

        // HF = 10_000_000_000 * 12_000_000 / 1e7 * 8000 * 1e7
        //      / (10_000 * 5_000_000_000)
        // = 12_000_000_000 * 8000 * 1e7 / (10_000 * 5_000_000_000)
        // = 19_200_000
        let hf = client.health_factor(&user);
        assert_eq!(hf, 19_200_000); // 1.92 × 1e7
    }

    #[test]
    fn test_price_increase_expands_borrow_capacity() {
        let (env, contract_id, sxlm_id, _, price_feed_id, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);

        // At 1:1 price, max borrow = 1 000 × 0.7 = 700 XLM.
        client.borrow(&user, &7_000_000_000);

        // Price goes up to 1.5 × → max borrow = 1 000 × 1.5 × 0.7 = 1 050 XLM.
        MockPriceFeedClient::new(&env, &price_feed_id).set_price(&sxlm_id, &15_000_000);

        // Can borrow 300 more (total 1 000, within new 1 050 limit).
        client.borrow(&user, &3_000_000_000);
        let (_, bor) = client.get_position(&user);
        assert_eq!(bor, 10_000_000_000);
    }

    #[test]
    fn test_liquidation_single_asset() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let u = Address::generate(&env);
        let liq = Address::generate(&env);

        let sxlm_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        // Price feed with sXLM at 1:1.
        let pf_id = env.register_contract(None, mock_price_feed::MockPriceFeed);
        MockPriceFeedClient::new(&env, &pf_id).set_price(&sxlm_id, &RATE_PRECISION);

        // Lending contract with LT=50 % to make the position liquidatable.
        let contract2 = env.register_contract(None, LendingContract);
        let client2 = LendingContractClient::new(&env, &contract2);
        client2.initialize(&admin, &native_id, &pf_id, &500);
        client2.add_collateral(&sxlm_id, &7000, &5000); // CF=70 %, LT=50 %

        StellarAssetClient::new(&env, &sxlm_id).mint(&u, &100_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&contract2, &500_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&liq, &100_000_0000000);

        client2.deposit_collateral(&u, &sxlm_id, &10_000_000_000);
        client2.borrow(&u, &7_000_000_000);
        // HF = 10_000_000_000 * 5000 * 1e7 / (10_000 * 7_000_000_000) ≈ 7_142_857 < 1e7 → liquidatable

        let seize_assets = soroban_sdk::vec![&env, sxlm_id.clone()];
        client2.liquidate(&liq, &u, &seize_assets);

        let (_, bor) = client2.get_position(&u);
        assert_eq!(bor, 0);

        // Liquidator seizes debt_with_bonus worth of sXLM.
        // debt_with_bonus = 7_000_000_000 × 1.05 = 7_350_000_000 XLM value.
        // At price 1:1, tokens_to_cover = 7_350_000_000.
        // Remaining collateral = 10_000_000_000 − 7_350_000_000 = 2_650_000_000.
        assert_eq!(
            client2.total_collateral_for_asset(&sxlm_id),
            2_650_000_000
        );
    }

    #[test]
    fn test_admin_set_collateral_factor() {
        let (env, contract_id, sxlm_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);
        assert_eq!(client.get_collateral_factor(&sxlm_id), 7000);
        client.set_collateral_factor(&sxlm_id, &7500);
        assert_eq!(client.get_collateral_factor(&sxlm_id), 7500);
    }

    #[test]
    fn test_totals() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let user2 = Address::generate(&env);
        StellarAssetClient::new(&env, &sxlm_id).mint(&user2, &100_000_0000000);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.deposit_collateral(&user2, &sxlm_id, &5_000_000_000);
        assert_eq!(client.total_collateral_for_asset(&sxlm_id), 15_000_000_000);

        client.borrow(&user, &3_000_000_000);
        client.borrow(&user2, &2_000_000_000);
        assert_eq!(client.total_borrowed(), 5_000_000_000);
    }

    #[test]
    fn test_multi_collateral_deposit() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let sxlm_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        let pf_id = env.register_contract(None, mock_price_feed::MockPriceFeed);
        let pf = MockPriceFeedClient::new(&env, &pf_id);
        // USDC at 1.0 XLM, sXLM at 0.98 XLM.
        pf.set_price(&usdc_id, &10_000_000);
        pf.set_price(&sxlm_id, &9_800_000);

        let contract_id = env.register_contract(None, LendingContract);
        let client = LendingContractClient::new(&env, &contract_id);
        client.initialize(&admin, &native_id, &pf_id, &500);
        client.add_collateral(&usdc_id, &8000, &8500); // CF=80 %, LT=85 %
        client.add_collateral(&sxlm_id, &7000, &8000); // CF=70 %, LT=80 %

        StellarAssetClient::new(&env, &usdc_id).mint(&user, &5_000_0000000);
        StellarAssetClient::new(&env, &sxlm_id).mint(&user, &5_000_0000000);
        StellarAssetClient::new(&env, &native_id).mint(&contract_id, &500_000_0000000);

        client.deposit_collateral(&user, &usdc_id, &1_000_0000000);
        client.deposit_collateral(&user, &sxlm_id, &1_000_0000000);

        // max_borrow = USDC: 1_000_0000000 * 10_000_000 / 1e7 * 8000 / 10000
        //                  = 1_000_0000000 * 0.8 = 8_000_000_000
        //           + sXLM: 1_000_0000000 * 9_800_000 / 1e7 * 7000 / 10000
        //                  = 980_0000000 * 0.7 = 6_860_000_000
        // total             = 14_860_000_000
        let capacity = client.max_borrow(&user);
        assert_eq!(capacity, 14_860_000_000);

        let (assets, amounts) = client.get_user_collaterals(&user);
        assert_eq!(assets.len(), 2);
        assert_eq!(amounts.get(0).unwrap(), 1_000_0000000); // USDC
        assert_eq!(amounts.get(1).unwrap(), 1_000_0000000); // sXLM
    }

    #[test]
    fn test_add_and_remove_collateral() {
        let (env, contract_id, sxlm_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        assert_eq!(client.get_supported_collaterals().len(), 1);
        client.remove_collateral(&sxlm_id);
        assert_eq!(client.get_supported_collaterals().len(), 0);
    }

    #[test]
    fn test_get_collateral_configs_single_asset() {
        let (env, contract_id, sxlm_id, _, _, _, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let configs = client.get_collateral_configs();
        assert_eq!(configs.len(), 1);
        let cfg = configs.get(0).unwrap();
        assert_eq!(cfg.asset, sxlm_id);
        assert_eq!(cfg.cf_bps, 7000);
        assert_eq!(cfg.lt_bps, 8000);
        assert_eq!(cfg.total_deposited, 0);
    }

    #[test]
    fn test_get_collateral_configs_reflects_deposits() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &5_000_000_000);
        let configs = client.get_collateral_configs();
        assert_eq!(configs.get(0).unwrap().total_deposited, 5_000_000_000);
    }

    #[test]
    fn test_get_collateral_configs_multi_asset() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let usdc_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let sxlm_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        let pf_id = env.register_contract(None, mock_price_feed::MockPriceFeed);
        let contract_id = env.register_contract(None, LendingContract);
        let client = LendingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &native_id, &pf_id, &500);
        client.add_collateral(&usdc_id, &8000, &8500);
        client.add_collateral(&sxlm_id, &7000, &8000);

        let configs = client.get_collateral_configs();
        assert_eq!(configs.len(), 2);

        let usdc_cfg = configs.get(0).unwrap();
        assert_eq!(usdc_cfg.asset, usdc_id);
        assert_eq!(usdc_cfg.cf_bps, 8000);
        assert_eq!(usdc_cfg.lt_bps, 8500);
        assert_eq!(usdc_cfg.total_deposited, 0);

        let sxlm_cfg = configs.get(1).unwrap();
        assert_eq!(sxlm_cfg.asset, sxlm_id);
        assert_eq!(sxlm_cfg.cf_bps, 7000);
        assert_eq!(sxlm_cfg.lt_bps, 8000);
        assert_eq!(sxlm_cfg.total_deposited, 0);
    }

    #[test]
    fn test_get_user_position_detail_no_debt() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        let pos = client.get_user_position_detail(&user);

        assert_eq!(pos.collaterals.len(), 1);
        assert_eq!(pos.collaterals.get(0).unwrap().asset, sxlm_id);
        assert_eq!(pos.collaterals.get(0).unwrap().amount, 10_000_000_000);
        // 1:1 price → 10_000_000_000 XLM value
        assert_eq!(pos.collateral_value_xlm, 10_000_000_000);
        assert_eq!(pos.borrowed, 0);
        assert_eq!(pos.health_factor, i128::MAX);
        // max_borrow = 10_000_000_000 * 0.7 = 7_000_000_000 (no existing debt)
        assert_eq!(pos.max_borrow, 7_000_000_000);
    }

    #[test]
    fn test_get_user_position_detail_with_debt() {
        let (env, contract_id, sxlm_id, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);
        client.borrow(&user, &5_000_000_000);
        let pos = client.get_user_position_detail(&user);

        assert_eq!(pos.borrowed, 5_000_000_000);
        assert_eq!(pos.collateral_value_xlm, 10_000_000_000);
        // max_borrow = capacity(7_000_000_000) − borrowed(5_000_000_000) = 2_000_000_000
        assert_eq!(pos.max_borrow, 2_000_000_000);
        // HF = 10_000_000_000 * 8000 * 1e7 / (10_000 * 5_000_000_000) = 16_000_000
        assert_eq!(pos.health_factor, 16_000_000);
    }

    #[test]
    fn test_get_user_position_detail_zero_filled_for_undeposited_assets() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let usdc_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let sxlm_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let native_id =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();

        let pf_id = env.register_contract(None, mock_price_feed::MockPriceFeed);
        MockPriceFeedClient::new(&env, &pf_id).set_price(&usdc_id, &RATE_PRECISION);
        MockPriceFeedClient::new(&env, &pf_id).set_price(&sxlm_id, &RATE_PRECISION);

        let contract_id = env.register_contract(None, LendingContract);
        let client = LendingContractClient::new(&env, &contract_id);

        client.initialize(&admin, &native_id, &pf_id, &500);
        client.add_collateral(&usdc_id, &8000, &8500);
        client.add_collateral(&sxlm_id, &7000, &8000);

        StellarAssetClient::new(&env, &sxlm_id).mint(&user, &10_000_000_000);
        StellarAssetClient::new(&env, &native_id).mint(&contract_id, &500_000_0000000);

        // Only deposit sXLM; USDC entry should still appear with amount=0.
        client.deposit_collateral(&user, &sxlm_id, &10_000_000_000);

        let pos = client.get_user_position_detail(&user);
        assert_eq!(pos.collaterals.len(), 2);
        // First entry: USDC — not deposited.
        assert_eq!(pos.collaterals.get(0).unwrap().asset, usdc_id);
        assert_eq!(pos.collaterals.get(0).unwrap().amount, 0);
        // Second entry: sXLM — deposited.
        assert_eq!(pos.collaterals.get(1).unwrap().asset, sxlm_id);
        assert_eq!(pos.collaterals.get(1).unwrap().amount, 10_000_000_000);
    }

    #[test]
    #[should_panic(expected = "asset not supported")]
    fn test_deposit_unsupported_asset_panics() {
        let (env, contract_id, _, _, _, user, _, _) = setup_test();
        let client = LendingContractClient::new(&env, &contract_id);

        let random_token =
            env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        StellarAssetClient::new(&env, &random_token).mint(&user, &1_000_0000000);

        client.deposit_collateral(&user, &random_token, &1_000_0000000);
    }
}

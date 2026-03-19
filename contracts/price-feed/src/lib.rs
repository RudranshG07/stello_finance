#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

/// Prices are stored as `XLM_stroops per asset_base_unit`, scaled by RATE_PRECISION.
/// i.e. `value_xlm_stroops = asset_amount * price / RATE_PRECISION`
const RATE_PRECISION: i128 = 10_000_000; // 1e7

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days  (5 s/ledger)
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;         // ~30 days
const PRICE_LIFETIME_THRESHOLD: u32 = 518_400;     // ~30 days
const PRICE_BUMP_AMOUNT: u32 = 3_110_400;          // ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Initialized,
    Price(Address),
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_price_raw(env: &Env, asset: &Address) -> i128 {
    let key = DataKey::Price(asset.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, PRICE_LIFETIME_THRESHOLD, PRICE_BUMP_AMOUNT);
    }
    val
}

fn write_price_raw(env: &Env, asset: &Address, price: i128) {
    let key = DataKey::Price(asset.clone());
    env.storage().persistent().set(&key, &price);
    env.storage()
        .persistent()
        .extend_ttl(&key, PRICE_LIFETIME_THRESHOLD, PRICE_BUMP_AMOUNT);
}

#[contract]
pub struct PriceFeedContract;

#[contractimpl]
impl PriceFeedContract {
    /// Initialize the price-feed contract.
    pub fn initialize(env: Env, admin: Address) {
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

    /// Set the price for a collateral asset. Only callable by admin/oracle.
    ///
    /// `price` is expressed as XLM stroops per asset base unit,
    /// scaled by `RATE_PRECISION` (1e7).  So a 1:1 price (1 asset unit
    /// equals 1 XLM stroop) would be `RATE_PRECISION = 10_000_000`.
    pub fn set_price(env: Env, asset: Address, price: i128) {
        read_admin(&env).require_auth();
        assert!(price > 0, "price must be positive");
        extend_instance(&env);
        write_price_raw(&env, &asset, price);

        env.events().publish(
            (soroban_sdk::symbol_short!("set_price"),),
            (asset, price),
        );
    }

    /// Get the stored price for a collateral asset.
    ///
    /// Returns `price` scaled by `RATE_PRECISION`. Panics if no price has
    /// been set for the given asset.
    pub fn get_price(env: Env, asset: Address) -> i128 {
        extend_instance(&env);
        let price = read_price_raw(&env, &asset);
        assert!(price > 0, "no price set for asset");
        price
    }

    /// Returns `RATE_PRECISION` so callers can interpret prices correctly.
    pub fn rate_precision(_env: Env) -> i128 {
        RATE_PRECISION
    }

    /// Returns the current admin address.
    pub fn get_admin(env: Env) -> Address {
        extend_instance(&env);
        read_admin(&env)
    }

    /// Transfer admin role to a new address. Only callable by the current admin.
    pub fn set_admin(env: Env, new_admin: Address) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (soroban_sdk::symbol_short!("set_admin"),),
            new_admin,
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, PriceFeedContract);
        let client = PriceFeedContractClient::new(&env, &contract_id);
        client.initialize(&admin);
        (env, contract_id, admin)
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let (env, contract_id, admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);
        client.initialize(&admin);
    }

    #[test]
    fn test_set_and_get_price() {
        let (env, contract_id, _admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);

        let asset = Address::generate(&env);
        // 1:1 price → RATE_PRECISION
        client.set_price(&asset, &RATE_PRECISION);
        assert_eq!(client.get_price(&asset), RATE_PRECISION);

        // Update price to 1.5× (15_000_000)
        client.set_price(&asset, &15_000_000);
        assert_eq!(client.get_price(&asset), 15_000_000);
    }

    #[test]
    fn test_multiple_assets() {
        let (env, contract_id, _admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);

        let usdc = Address::generate(&env);
        let eurc = Address::generate(&env);
        let sxlm = Address::generate(&env);

        client.set_price(&usdc, &10_000_000); // 1.0×
        client.set_price(&eurc, &11_500_000); // 1.15×
        client.set_price(&sxlm, &9_800_000);  // 0.98×

        assert_eq!(client.get_price(&usdc), 10_000_000);
        assert_eq!(client.get_price(&eurc), 11_500_000);
        assert_eq!(client.get_price(&sxlm), 9_800_000);
    }

    #[test]
    #[should_panic(expected = "no price set for asset")]
    fn test_get_unset_price_panics() {
        let (env, contract_id, _admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);

        let unknown = Address::generate(&env);
        client.get_price(&unknown);
    }

    #[test]
    #[should_panic(expected = "price must be positive")]
    fn test_set_zero_price_panics() {
        let (env, contract_id, _admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);

        let asset = Address::generate(&env);
        client.set_price(&asset, &0);
    }

    #[test]
    fn test_set_admin() {
        let (env, contract_id, _admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);

        let new_admin = Address::generate(&env);
        client.set_admin(&new_admin);
        assert_eq!(client.get_admin(), new_admin);
    }

    #[test]
    fn test_rate_precision() {
        let (env, contract_id, _admin) = setup();
        let client = PriceFeedContractClient::new(&env, &contract_id);
        assert_eq!(client.rate_precision(), RATE_PRECISION);
    }
}

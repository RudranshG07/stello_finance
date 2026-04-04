#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, BytesN, Env, String,
};
use soroban_token_sdk::TokenUtils;

// ---------- TTL constants ----------
// Testnet: ~5s per ledger
// 30 days  ≈  518_400 ledgers
// 180 days ≈ 3_110_400 ledgers (near testnet max)
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days  — extend if below this
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;        // bump to ~30 days
const BALANCE_LIFETIME_THRESHOLD: u32 = 518_400;  // ~30 days — extend persistent if below this
const BALANCE_BUMP_AMOUNT: u32 = 3_110_400;       // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Minter,
    Allowance(AllowanceKey),
    Balance(Address),
    TotalSupply,
    Name,
    Symbol,
    Decimals,
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

// ---------- Storage helpers ----------

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_balance(env: &Env, addr: &Address) {
    let key = DataKey::Balance(addr.clone());
    env.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_minter(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Minter).unwrap()
}

fn read_balance(env: &Env, addr: &Address) -> i128 {
    let key = DataKey::Balance(addr.clone());
    let val: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    // Extend TTL whenever we read a balance that exists
    if val > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
    }
    val
}

fn write_balance(env: &Env, addr: &Address, amount: i128) {
    let key = DataKey::Balance(addr.clone());
    env.storage().persistent().set(&key, &amount);
    // Always extend TTL on write
    env.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

fn read_total_supply(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalSupply)
        .unwrap_or(0)
}

fn write_total_supply(env: &Env, amount: i128) {
    env.storage().instance().set(&DataKey::TotalSupply, &amount);
}

fn read_allowance(env: &Env, from: &Address, spender: &Address) -> i128 {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn write_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    env.storage().persistent().set(&key, &amount);
    env.storage()
        .persistent()
        .extend_ttl(&key, BALANCE_LIFETIME_THRESHOLD, BALANCE_BUMP_AMOUNT);
}

fn check_nonnegative(amount: i128) {
    if amount < 0 {
        panic!("amount must be non-negative");
    }
}

fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
    let allowance = read_allowance(env, from, spender);
    if allowance < amount {
        panic!("insufficient allowance");
    }
    write_allowance(env, from, spender, allowance - amount);
}

#[contract]
pub struct SxlmToken;

#[contractimpl]
impl SxlmToken {
    /// Initialize the sXLM token contract.
    /// `admin`  - protocol admin address
    /// `minter` - the staking contract address (only address allowed to mint/burn)
    pub fn initialize(env: Env, admin: Address, minter: Address, decimals: u32, name: String, symbol: String) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Minter, &minter);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        write_total_supply(&env, 0);
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

    /// Bump a user's balance TTL — can be called by anyone.
    pub fn bump_balance(env: Env, user: Address) {
        extend_balance(&env, &user);
        extend_instance(&env);
    }

    /// Mint sXLM tokens — only callable by the minter (staking contract).
    pub fn mint(env: Env, to: Address, amount: i128) {
        check_nonnegative(amount);
        let minter = read_minter(&env);
        minter.require_auth();
        extend_instance(&env);

        let balance = read_balance(&env, &to);
        write_balance(&env, &to, balance + amount);
        write_total_supply(&env, read_total_supply(&env) + amount);

        TokenUtils::new(&env).events().mint(minter, to, amount);
    }

    /// Burn sXLM tokens — only callable by the minter (staking contract).
    pub fn burn(env: Env, from: Address, amount: i128) {
        check_nonnegative(amount);
        let minter = read_minter(&env);
        minter.require_auth();
        extend_instance(&env);

        let balance = read_balance(&env, &from);
        if balance < amount {
            panic!("insufficient balance to burn");
        }
        write_balance(&env, &from, balance - amount);
        write_total_supply(&env, read_total_supply(&env) - amount);

        TokenUtils::new(&env).events().burn(from, amount);
    }

    // --- SEP-41 Token Interface ---

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        extend_instance(&env);
        read_allowance(&env, &from, &spender)
    }

    pub fn approve(env: Env, from: Address, spender: Address, amount: i128, _expiration_ledger: u32) {
        from.require_auth();
        check_nonnegative(amount);
        extend_instance(&env);
        write_allowance(&env, &from, &spender, amount);

        TokenUtils::new(&env)
            .events()
            .approve(from, spender, amount, _expiration_ledger);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        extend_instance(&env);
        read_balance(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        check_nonnegative(amount);
        extend_instance(&env);

        let from_balance = read_balance(&env, &from);
        if from_balance < amount {
            panic!("insufficient balance");
        }
        write_balance(&env, &from, from_balance - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);

        TokenUtils::new(&env).events().transfer(from, to, amount);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        check_nonnegative(amount);
        extend_instance(&env);
        spend_allowance(&env, &from, &spender, amount);

        let from_balance = read_balance(&env, &from);
        if from_balance < amount {
            panic!("insufficient balance");
        }
        write_balance(&env, &from, from_balance - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);

        TokenUtils::new(&env).events().transfer(from, to, amount);
    }

    pub fn total_supply(env: Env) -> i128 {
        extend_instance(&env);
        read_total_supply(&env)
    }

    pub fn decimals(env: Env) -> u32 {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::Decimals).unwrap()
    }

    pub fn name(env: Env) -> String {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }

    // --- Admin functions ---

    /// Update the minter address (e.g., if staking contract is redeployed).
    pub fn set_minter(env: Env, new_minter: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Minter, &new_minter);
    }

    /// Transfer admin role.
    pub fn set_admin(env: Env, new_admin: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn minter(env: Env) -> Address {
        extend_instance(&env);
        read_minter(&env)
    }

    pub fn admin(env: Env) -> Address {
        extend_instance(&env);
        read_admin(&env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Env, String};

    fn setup_token(env: &Env) -> (SxlmTokenClient<'_>, Address, Address) {
        let contract_id = env.register_contract(None, SxlmToken);
        let client = SxlmTokenClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let minter = Address::generate(env);

        client.initialize(
            &admin,
            &minter,
            &7u32,
            &String::from_str(env, "Staked XLM"),
            &String::from_str(env, "sXLM"),
        );

        (client, admin, minter)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (client, _, _) = setup_token(&env);
        assert_eq!(client.name(), String::from_str(&env, "Staked XLM"));
        assert_eq!(client.symbol(), String::from_str(&env, "sXLM"));
        assert_eq!(client.decimals(), 7u32);
        assert_eq!(client.total_supply(), 0i128);
    }

    #[test]
    fn test_mint_and_burn() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _) = setup_token(&env);
        let user = Address::generate(&env);

        client.mint(&user, &1_000_0000000i128);
        assert_eq!(client.balance(&user), 1_000_0000000i128);
        assert_eq!(client.total_supply(), 1_000_0000000i128);

        client.burn(&user, &400_0000000i128);
        assert_eq!(client.balance(&user), 600_0000000i128);
        assert_eq!(client.total_supply(), 600_0000000i128);
    }

    #[test]
    fn test_transfer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _) = setup_token(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        client.mint(&user1, &1_000_0000000i128);
        client.transfer(&user1, &user2, &300_0000000i128);
        assert_eq!(client.balance(&user1), 700_0000000i128);
        assert_eq!(client.balance(&user2), 300_0000000i128);
    }

    #[test]
    fn test_approve_and_transfer_from() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _) = setup_token(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.mint(&owner, &1_000_0000000i128);
        client.approve(&owner, &spender, &500_0000000i128, &1000u32);
        assert_eq!(client.allowance(&owner, &spender), 500_0000000i128);

        client.transfer_from(&spender, &owner, &recipient, &200_0000000i128);
        assert_eq!(client.balance(&owner), 800_0000000i128);
        assert_eq!(client.balance(&recipient), 200_0000000i128);
        assert_eq!(client.allowance(&owner, &spender), 300_0000000i128);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        let (client, admin, minter) = setup_token(&env);
        client.initialize(
            &admin,
            &minter,
            &7u32,
            &String::from_str(&env, "Staked XLM"),
            &String::from_str(&env, "sXLM"),
        );
    }

    #[test]
    #[should_panic(expected = "insufficient balance to burn")]
    fn test_burn_more_than_balance_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _) = setup_token(&env);
        let user = Address::generate(&env);

        client.mint(&user, &100_0000000i128);
        client.burn(&user, &200_0000000i128);
    }

    #[test]
    fn test_zero_balance_by_default() {
        let env = Env::default();
        let (client, _, _) = setup_token(&env);
        let random_user = Address::generate(&env);
        assert_eq!(client.balance(&random_user), 0);
    }

    #[test]
    fn test_set_minter() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, minter) = setup_token(&env);
        let new_minter = Address::generate(&env);

        assert_eq!(client.minter(), minter);
        client.set_minter(&new_minter);
        assert_eq!(client.minter(), new_minter);
    }
}

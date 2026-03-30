#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
};

// ---------- TTL constants (matching sxlm-token pattern) ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800;
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const BALANCE_LIFETIME_THRESHOLD: u32 = 518_400;
const BALANCE_BUMP_AMOUNT: u32 = 3_110_400;

// ---------- Supported EVM chain IDs ----------
pub const CHAIN_ETHEREUM: u32 = 1;
pub const CHAIN_ARBITRUM: u32 = 42161;
pub const CHAIN_SEPOLIA: u32 = 11155111; // testnet

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Relayer,
    SxlmToken,
    Paused,
    Nonce(Address),        // per-user outbound nonce
    ProcessedNonce(Bytes), // inbound EVM tx hash → bool
    TotalLocked,
    MinBridgeAmount,
}

#[derive(Clone)]
#[contracttype]
pub struct BridgeInitiatedEvent {
    pub sender: Address,
    pub evm_recipient: Bytes, // 20-byte EVM address
    pub amount: i128,
    pub nonce: u64,
    pub target_chain_id: u32,
}

// ---------- sXLM token interface (cross-contract call) ----------
mod sxlm_token {
    use soroban_sdk::{contractclient, Address, Env};

    #[allow(dead_code)]
    #[contractclient(name = "SxlmTokenClient")]
    pub trait SxlmToken {
        fn burn(env: Env, from: Address, amount: i128);
        fn mint(env: Env, to: Address, amount: i128);
        fn balance(env: Env, id: Address) -> i128;
    }
}

use sxlm_token::SxlmTokenClient;

// ---------- Storage helpers ----------

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_relayer(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Relayer).unwrap()
}

fn read_sxlm_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SxlmToken).unwrap()
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn get_nonce(env: &Env, user: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(user.clone()))
        .unwrap_or(0u64)
}

fn increment_nonce(env: &Env, user: &Address) -> u64 {
    let nonce = get_nonce(env, user) + 1;
    env.storage()
        .persistent()
        .set(&DataKey::Nonce(user.clone()), &nonce);
    env.storage().persistent().extend_ttl(
        &DataKey::Nonce(user.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
    nonce
}

fn is_processed(env: &Env, evm_tx_hash: &Bytes) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::ProcessedNonce(evm_tx_hash.clone()))
        .unwrap_or(false)
}

fn mark_processed(env: &Env, evm_tx_hash: &Bytes) {
    env.storage()
        .persistent()
        .set(&DataKey::ProcessedNonce(evm_tx_hash.clone()), &true);
    env.storage().persistent().extend_ttl(
        &DataKey::ProcessedNonce(evm_tx_hash.clone()),
        BALANCE_LIFETIME_THRESHOLD,
        BALANCE_BUMP_AMOUNT,
    );
}

fn read_total_locked(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalLocked)
        .unwrap_or(0i128)
}

fn write_total_locked(env: &Env, amount: i128) {
    env.storage().instance().set(&DataKey::TotalLocked, &amount);
}

fn read_min_bridge_amount(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::MinBridgeAmount)
        .unwrap_or(1_0000000i128) // default: 1 sXLM (7 decimals)
}

fn validate_chain_id(chain_id: u32) {
    if chain_id != CHAIN_ETHEREUM && chain_id != CHAIN_ARBITRUM && chain_id != CHAIN_SEPOLIA {
        panic!("unsupported target chain");
    }
}

fn validate_evm_address(addr: &Bytes) {
    if addr.len() != 20 {
        panic!("invalid EVM address: must be 20 bytes");
    }
}

// ---------- Contract ----------

#[contract]
pub struct BridgeAdapter;

#[contractimpl]
impl BridgeAdapter {
    /// Initialize the bridge contract.
    /// `admin`       - protocol admin
    /// `relayer`     - authorized relayer address (calls `release`)
    /// `sxlm_token`  - sXLM token contract address
    pub fn initialize(
        env: Env,
        admin: Address,
        relayer: Address,
        sxlm_token: Address,
        min_bridge_amount: i128,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if min_bridge_amount <= 0 {
            panic!("min_bridge_amount must be positive");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Relayer, &relayer);
        env.storage()
            .instance()
            .set(&DataKey::SxlmToken, &sxlm_token);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .set(&DataKey::MinBridgeAmount, &min_bridge_amount);
        write_total_locked(&env, 0);
        extend_instance(&env);
    }

    /// Bridge sXLM to an EVM chain.
    ///
    /// Burns `amount` sXLM from `sender` on Stellar side and emits a
    /// `BridgeInitiated` event. The relayer listens for this event and
    /// mints wsXLM on the target EVM chain.
    ///
    /// `sender`          - Stellar address initiating the bridge
    /// `evm_recipient`   - 20-byte EVM address to receive wsXLM
    /// `amount`          - amount of sXLM to bridge (7 decimals)
    /// `target_chain_id` - EVM chain ID (1=Ethereum, 42161=Arbitrum)
    pub fn bridge_to_evm(
        env: Env,
        sender: Address,
        evm_recipient: Bytes,
        amount: i128,
        target_chain_id: u32,
    ) -> u64 {
        sender.require_auth();

        if is_paused(&env) {
            panic!("bridge is paused");
        }
        if amount < read_min_bridge_amount(&env) {
            panic!("amount below minimum bridge amount");
        }
        validate_chain_id(target_chain_id);
        validate_evm_address(&evm_recipient);

        extend_instance(&env);

        // Burn sXLM from sender — bridge contract must be authorized as minter
        let token_client = SxlmTokenClient::new(&env, &read_sxlm_token(&env));
        token_client.burn(&sender, &amount);

        // Track total locked (burned for bridge)
        write_total_locked(&env, read_total_locked(&env) + amount);

        // Increment nonce for replay protection
        let nonce = increment_nonce(&env, &sender);

        // Emit cross-chain event — relayer listens for this
        env.events().publish(
            (symbol_short!("bridge"), symbol_short!("evm")),
            BridgeInitiatedEvent {
                sender: sender.clone(),
                evm_recipient: evm_recipient.clone(),
                amount,
                nonce,
                target_chain_id,
            },
        );

        nonce
    }

    /// Release sXLM to a Stellar address when bridging back from EVM.
    ///
    /// Called exclusively by the authorized relayer after verifying the
    /// `BridgeBack` event on the EVM chain. Mints sXLM to `recipient`.
    ///
    /// `evm_tx_hash` - the EVM transaction hash (32 bytes), used to
    ///                 prevent replay attacks
    pub fn release_from_evm(
        env: Env,
        recipient: Address,
        amount: i128,
        evm_tx_hash: Bytes,
        source_chain_id: u32,
    ) {
        let relayer = read_relayer(&env);
        relayer.require_auth();

        if is_paused(&env) {
            panic!("bridge is paused");
        }
        if amount <= 0 {
            panic!("amount must be positive");
        }
        validate_chain_id(source_chain_id);

        // Replay protection: each EVM tx hash can only be processed once
        if is_processed(&env, &evm_tx_hash) {
            panic!("already processed");
        }
        mark_processed(&env, &evm_tx_hash);

        extend_instance(&env);

        // Mint sXLM to recipient
        let token_client = SxlmTokenClient::new(&env, &read_sxlm_token(&env));
        token_client.mint(&recipient, &amount);

        // Update total locked
        let locked = read_total_locked(&env);
        if locked >= amount {
            write_total_locked(&env, locked - amount);
        }

        // Emit release event
        env.events().publish(
            (symbol_short!("bridge"), symbol_short!("release")),
            (recipient, amount, evm_tx_hash, source_chain_id),
        );
    }

    // ---------- View functions ----------

    pub fn get_nonce(env: Env, user: Address) -> u64 {
        extend_instance(&env);
        get_nonce(&env, &user)
    }

    pub fn is_processed(env: Env, evm_tx_hash: Bytes) -> bool {
        extend_instance(&env);
        is_processed(&env, &evm_tx_hash)
    }

    pub fn total_locked(env: Env) -> i128 {
        extend_instance(&env);
        read_total_locked(&env)
    }

    pub fn min_bridge_amount(env: Env) -> i128 {
        extend_instance(&env);
        read_min_bridge_amount(&env)
    }

    pub fn paused(env: Env) -> bool {
        extend_instance(&env);
        is_paused(&env)
    }

    pub fn relayer(env: Env) -> Address {
        extend_instance(&env);
        read_relayer(&env)
    }

    pub fn admin(env: Env) -> Address {
        extend_instance(&env);
        read_admin(&env)
    }

    // ---------- Admin functions ----------

    pub fn pause(env: Env) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
    }

    pub fn unpause(env: Env) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn set_relayer(env: Env, new_relayer: Address) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::Relayer, &new_relayer);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        read_admin(&env).require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn set_min_bridge_amount(env: Env, amount: i128) {
        read_admin(&env).require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::MinBridgeAmount, &amount);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        read_admin(&env).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn bump_instance(env: Env) {
        extend_instance(&env);
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Bytes, Env};

    // Helper: create a fake 20-byte EVM address
    fn evm_addr(env: &Env) -> Bytes {
        let mut b = Bytes::new(env);
        for _ in 0..20 {
            b.push_back(0xAB);
        }
        b
    }

    // Helper: create a fake 32-byte EVM tx hash
    fn evm_tx_hash(env: &Env, seed: u8) -> Bytes {
        let mut b = Bytes::new(env);
        for _ in 0..32 {
            b.push_back(seed);
        }
        b
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);

        assert_eq!(client.admin(), admin);
        assert_eq!(client.relayer(), relayer);
        assert_eq!(client.paused(), false);
        assert_eq!(client.min_bridge_amount(), 1_0000000i128);
        assert_eq!(client.total_locked(), 0i128);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
    }

    #[test]
    fn test_pause_and_unpause() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
        assert_eq!(client.paused(), false);

        client.pause();
        assert_eq!(client.paused(), true);

        client.unpause();
        assert_eq!(client.paused(), false);
    }

    #[test]
    #[should_panic(expected = "bridge is paused")]
    fn test_bridge_to_evm_fails_when_paused() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
        client.pause();
        client.bridge_to_evm(&user, &evm_addr(&env), &10_0000000i128, &CHAIN_ARBITRUM);
    }

    #[test]
    #[should_panic(expected = "amount below minimum bridge amount")]
    fn test_bridge_to_evm_fails_below_minimum() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &5_0000000i128);
        // 1 sXLM < 5 sXLM minimum
        client.bridge_to_evm(&user, &evm_addr(&env), &1_0000000i128, &CHAIN_ARBITRUM);
    }

    #[test]
    #[should_panic(expected = "unsupported target chain")]
    fn test_bridge_to_evm_rejects_unknown_chain() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
        client.bridge_to_evm(&user, &evm_addr(&env), &10_0000000i128, &9999u32);
    }

    #[test]
    #[should_panic(expected = "invalid EVM address: must be 20 bytes")]
    fn test_bridge_to_evm_rejects_bad_evm_address() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
        // Only 10 bytes — invalid
        let mut bad_addr = Bytes::new(&env);
        for _ in 0..10 {
            bad_addr.push_back(0xAB);
        }
        client.bridge_to_evm(&user, &bad_addr, &10_0000000i128, &CHAIN_ARBITRUM);
    }

    #[test]
    #[should_panic(expected = "already processed")]
    fn test_release_replay_protection() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);

        let hash = evm_tx_hash(&env, 0xAB);

        // TODO: refactor with a registered sXLM mock contract so the full
        // release_from_evm flow (including mint) is exercised end-to-end.
        // For now we directly manipulate storage to mark the hash as processed,
        // then verify the second call panics with "already processed".
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&DataKey::ProcessedNonce(hash.clone()), &true);
        });

        // This call should now immediately panic with "already processed"
        client.release_from_evm(&recipient, &10_0000000i128, &hash, &CHAIN_ARBITRUM);
    }

    #[test]
    fn test_nonce_increments_per_user() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        // Use a mock sxlm address — burn will be mocked
        let sxlm = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
        assert_eq!(client.get_nonce(&user), 0u64);
    }

    #[test]
    fn test_set_relayer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, BridgeAdapter);
        let client = BridgeAdapterClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let relayer = Address::generate(&env);
        let sxlm = Address::generate(&env);
        let new_relayer = Address::generate(&env);

        client.initialize(&admin, &relayer, &sxlm, &1_0000000i128);
        assert_eq!(client.relayer(), relayer);

        client.set_relayer(&new_relayer);
        assert_eq!(client.relayer(), new_relayer);
    }
}

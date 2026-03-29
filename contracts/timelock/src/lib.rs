#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, Address, BytesN, Env, String,
};

const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800;
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const OPERATION_LIFETIME_THRESHOLD: u32 = 518_400;
const OPERATION_BUMP_AMOUNT: u32 = 3_110_400;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    GovernanceContract,
    Guardian,
    MinDelayLedgers,
    StakingContract,
    LendingContract,
    LpPoolContract,
    Initialized,
    Operation(u64),
}

#[derive(Clone)]
#[contracttype]
pub struct Operation {
    pub proposal_id: u64,
    pub param_key: String,
    pub new_value: i128,
    pub eta_ledger: u32,
    pub cancelled: bool,
    pub executed: bool,
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_operation(env: &Env, proposal_id: u64) {
    let key = DataKey::Operation(proposal_id);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, OPERATION_LIFETIME_THRESHOLD, OPERATION_BUMP_AMOUNT);
    }
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_governance_contract(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::GovernanceContract)
        .unwrap()
}

fn read_guardian(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Guardian).unwrap()
}

fn read_min_delay(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::MinDelayLedgers)
        .unwrap_or(34_560u32)
}

fn read_staking_contract(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::StakingContract)
        .unwrap()
}

fn read_lending_contract(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::LendingContract)
        .unwrap()
}

fn read_lp_pool_contract(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::LpPoolContract)
        .unwrap()
}

fn read_operation(env: &Env, proposal_id: u64) -> Operation {
    let key = DataKey::Operation(proposal_id);
    let operation: Operation = env.storage().persistent().get(&key).unwrap();
    env.storage()
        .persistent()
        .extend_ttl(&key, OPERATION_LIFETIME_THRESHOLD, OPERATION_BUMP_AMOUNT);
    operation
}

fn write_operation(env: &Env, operation: &Operation) {
    let key = DataKey::Operation(operation.proposal_id);
    env.storage().persistent().set(&key, operation);
    env.storage()
        .persistent()
        .extend_ttl(&key, OPERATION_LIFETIME_THRESHOLD, OPERATION_BUMP_AMOUNT);
}

fn require_governance_invoker(env: &Env) {
    read_governance_contract(env).require_auth();
}

fn require_guardian_auth(env: &Env, guardian: &Address) {
    guardian.require_auth();
    assert!(guardian.clone() == read_guardian(env), "not guardian");
}

fn require_u32_value(value: i128, label: &str) -> u32 {
    assert!(value >= 0, "negative value");
    assert!(value <= u32::MAX as i128, "{}", label);
    value as u32
}

fn key_matches(env: &Env, actual: &String, expected: &str) -> bool {
    actual.clone() == String::from_str(env, expected)
}

#[contractclient(name = "StakingAdminClient")]
pub trait StakingAdminInterface {
    fn set_protocol_fee_bps(env: Env, bps: u32);
    fn set_cooldown_period(env: Env, new_cooldown: u32);
}

#[contractclient(name = "LendingAdminClient")]
pub trait LendingAdminInterface {
    fn update_collateral_factor(env: Env, new_cf_bps: u32);
    fn update_borrow_rate(env: Env, new_rate_bps: u32);
    fn update_liquidation_threshold(env: Env, new_lt_bps: u32);
}

#[contractclient(name = "LpPoolAdminClient")]
pub trait LpPoolAdminInterface {
    fn set_protocol_fee_bps(env: Env, bps: u32);
}

#[contract]
pub struct TimelockContract;

#[contractimpl]
impl TimelockContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        governance_contract: Address,
        guardian: Address,
        min_delay_ledgers: u32,
        staking_contract: Address,
        lending_contract: Address,
        lp_pool_contract: Address,
    ) {
        let already: bool = env.storage().instance().get(&DataKey::Initialized).unwrap_or(false);
        if already {
            panic!("already initialized");
        }

        assert!(min_delay_ledgers > 0, "invalid min delay");

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GovernanceContract, &governance_contract);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage()
            .instance()
            .set(&DataKey::MinDelayLedgers, &min_delay_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::StakingContract, &staking_contract);
        env.storage()
            .instance()
            .set(&DataKey::LendingContract, &lending_contract);
        env.storage()
            .instance()
            .set(&DataKey::LpPoolContract, &lp_pool_contract);
        extend_instance(&env);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin = read_admin(&env);
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn bump_instance(env: Env) {
        extend_instance(&env);
    }

    pub fn set_guardian(env: Env, guardian: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
    }

    pub fn set_min_delay_ledgers(env: Env, min_delay_ledgers: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(min_delay_ledgers > 0, "invalid min delay");
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::MinDelayLedgers, &min_delay_ledgers);
    }

    pub fn schedule(
        env: Env,
        proposal_id: u64,
        param_key: String,
        new_value: i128,
        eta_ledger: u32,
    ) {
        extend_instance(&env);
        require_governance_invoker(&env);

        let current_ledger = env.ledger().sequence();
        let min_eta = current_ledger + read_min_delay(&env);
        assert!(eta_ledger >= min_eta, "eta shorter than min delay");
        assert!(
            !env.storage().persistent().has(&DataKey::Operation(proposal_id)),
            "operation already scheduled"
        );

        let operation = Operation {
            proposal_id,
            param_key: param_key.clone(),
            new_value,
            eta_ledger,
            cancelled: false,
            executed: false,
        };
        write_operation(&env, &operation);

        env.events().publish(
            (soroban_sdk::symbol_short!("queued"),),
            (proposal_id, param_key, eta_ledger),
        );
    }

    pub fn cancel(env: Env, guardian: Address, proposal_id: u64) {
        extend_instance(&env);
        require_guardian_auth(&env, &guardian);

        let mut operation = read_operation(&env, proposal_id);
        assert!(!operation.executed, "operation already executed");
        assert!(!operation.cancelled, "operation already cancelled");
        operation.cancelled = true;
        write_operation(&env, &operation);

        env.events().publish(
            (soroban_sdk::symbol_short!("cancel"),),
            (proposal_id, guardian),
        );
    }

    pub fn execute(env: Env, proposal_id: u64) {
        extend_instance(&env);

        let mut operation = read_operation(&env, proposal_id);
        assert!(!operation.executed, "operation already executed");
        assert!(!operation.cancelled, "operation cancelled");
        assert!(
            env.ledger().sequence() >= operation.eta_ledger,
            "timelock not expired"
        );

        if key_matches(&env, &operation.param_key, "protocol_fee_bps") {
            StakingAdminClient::new(&env, &read_staking_contract(&env))
                .set_protocol_fee_bps(&require_u32_value(operation.new_value, "invalid protocol fee"));
        } else if key_matches(&env, &operation.param_key, "cooldown_period") {
            StakingAdminClient::new(&env, &read_staking_contract(&env))
                .set_cooldown_period(&require_u32_value(operation.new_value, "invalid cooldown"));
        } else if key_matches(&env, &operation.param_key, "collateral_factor") {
            LendingAdminClient::new(&env, &read_lending_contract(&env))
                .update_collateral_factor(&require_u32_value(operation.new_value, "invalid collateral factor"));
        } else if key_matches(&env, &operation.param_key, "borrow_rate_bps") {
            LendingAdminClient::new(&env, &read_lending_contract(&env))
                .update_borrow_rate(&require_u32_value(operation.new_value, "invalid borrow rate"));
        } else if key_matches(&env, &operation.param_key, "liquidation_threshold") {
            LendingAdminClient::new(&env, &read_lending_contract(&env))
                .update_liquidation_threshold(&require_u32_value(operation.new_value, "invalid liquidation threshold"));
        } else if key_matches(&env, &operation.param_key, "lp_protocol_fee_bps") {
            LpPoolAdminClient::new(&env, &read_lp_pool_contract(&env))
                .set_protocol_fee_bps(&require_u32_value(operation.new_value, "invalid lp protocol fee"));
        } else {
            panic!("unsupported action");
        }

        operation.executed = true;
        write_operation(&env, &operation);

        env.events().publish(
            (soroban_sdk::symbol_short!("exec"),),
            (proposal_id, operation.param_key, operation.new_value),
        );
    }

    pub fn get_operation(env: Env, proposal_id: u64) -> Operation {
        extend_instance(&env);
        extend_operation(&env, proposal_id);
        read_operation(&env, proposal_id)
    }

    pub fn is_operation_cancelled(env: Env, proposal_id: u64) -> bool {
        extend_instance(&env);
        if !env.storage().persistent().has(&DataKey::Operation(proposal_id)) {
            return false;
        }
        read_operation(&env, proposal_id).cancelled
    }

    pub fn is_operation_executed(env: Env, proposal_id: u64) -> bool {
        extend_instance(&env);
        if !env.storage().persistent().has(&DataKey::Operation(proposal_id)) {
            return false;
        }
        read_operation(&env, proposal_id).executed
    }

    pub fn min_delay_ledgers(env: Env) -> u32 {
        extend_instance(&env);
        read_min_delay(&env)
    }

    pub fn guardian(env: Env) -> Address {
        extend_instance(&env);
        read_guardian(&env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[contract]
    struct MockTarget;

    #[derive(Clone)]
    #[contracttype]
    enum MockKey {
        Fee,
        Cooldown,
        CollateralFactor,
        BorrowRate,
        LiquidationThreshold,
        LpFee,
    }

    #[contractimpl]
    impl MockTarget {
        pub fn set_protocol_fee_bps(env: Env, bps: u32) {
            env.storage().instance().set(&MockKey::Fee, &bps);
        }

        pub fn set_cooldown_period(env: Env, cooldown: u32) {
            env.storage().instance().set(&MockKey::Cooldown, &cooldown);
        }

        pub fn update_collateral_factor(env: Env, value: u32) {
            env.storage().instance().set(&MockKey::CollateralFactor, &value);
        }

        pub fn update_borrow_rate(env: Env, value: u32) {
            env.storage().instance().set(&MockKey::BorrowRate, &value);
        }

        pub fn update_liquidation_threshold(env: Env, value: u32) {
            env.storage()
                .instance()
                .set(&MockKey::LiquidationThreshold, &value);
        }

        pub fn get_value(env: Env, key: u32) -> u32 {
            match key {
                0 => env.storage().instance().get(&MockKey::Fee).unwrap_or(0),
                1 => env.storage().instance().get(&MockKey::Cooldown).unwrap_or(0),
                2 => env.storage()
                    .instance()
                    .get(&MockKey::CollateralFactor)
                    .unwrap_or(0),
                3 => env.storage().instance().get(&MockKey::BorrowRate).unwrap_or(0),
                4 => env.storage()
                    .instance()
                    .get(&MockKey::LiquidationThreshold)
                    .unwrap_or(0),
                _ => env.storage().instance().get(&MockKey::LpFee).unwrap_or(0),
            }
        }
    }

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let governance = env.register_contract(None, MockTarget);
        let guardian = Address::generate(&env);

        let staking = env.register_contract(None, MockTarget);
        let lending = env.register_contract(None, MockTarget);
        let lp = env.register_contract(None, MockTarget);
        let timelock_id = env.register_contract(None, TimelockContract);
        let client = TimelockContractClient::new(&env, &timelock_id);

        client.initialize(
            &admin,
            &governance,
            &guardian,
            &50u32,
            &staking,
            &lending,
            &lp,
        );

        (env, timelock_id, guardian)
    }

    #[test]
    fn test_initialize_and_views() {
        let (env, timelock_id, guardian) = setup();
        let client = TimelockContractClient::new(&env, &timelock_id);
        assert_eq!(client.guardian(), guardian);
        assert_eq!(client.min_delay_ledgers(), 50);
    }
}

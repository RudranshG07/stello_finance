#![no_std]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, token, Address, BytesN, Env, String,
};

const BPS_DENOMINATOR: i128 = 10_000;
const MIN_PROPOSAL_BALANCE: i128 = 100_0000000;

const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800;
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const PROPOSAL_LIFETIME_THRESHOLD: u32 = 518_400;
const PROPOSAL_BUMP_AMOUNT: u32 = 3_110_400;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    SxlmToken,
    TimelockContract,
    VotingPeriodLedgers,
    QuorumBps,
    Initialized,
    ProposalCount,
    Proposal(u64),
    Vote(u64, Address),
    ReferenceSupply,
}

#[derive(Clone)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub param_key: String,
    pub new_value: i128,
    pub votes_for: i128,
    pub votes_against: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub queued_ledger: u32,
    pub eta_ledger: u32,
    pub executed: bool,
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_proposal(env: &Env, id: u64) {
    let key = DataKey::Proposal(id);
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
    }
}

fn extend_vote(env: &Env, proposal_id: u64, voter: &Address) {
    let key = DataKey::Vote(proposal_id, voter.clone());
    if env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
    }
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_sxlm_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SxlmToken).unwrap()
}

fn read_timelock_contract(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::TimelockContract)
        .unwrap()
}

fn read_voting_period(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::VotingPeriodLedgers)
        .unwrap_or(17_280u32)
}

fn read_quorum_bps(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::QuorumBps)
        .unwrap_or(1_000)
}

fn next_proposal_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ProposalCount)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::ProposalCount, &(id + 1));
    id
}

fn read_proposal(env: &Env, id: u64) -> Proposal {
    let key = DataKey::Proposal(id);
    let proposal: Proposal = env.storage().persistent().get(&key).unwrap();
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
    proposal
}

fn write_proposal(env: &Env, proposal: &Proposal) {
    let key = DataKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
}

fn has_voted(env: &Env, proposal_id: u64, voter: &Address) -> bool {
    let key = DataKey::Vote(proposal_id, voter.clone());
    let voted: bool = env.storage().persistent().get(&key).unwrap_or(false);
    if voted {
        env.storage()
            .persistent()
            .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
    }
    voted
}

fn set_voted(env: &Env, proposal_id: u64, voter: &Address) {
    let key = DataKey::Vote(proposal_id, voter.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
}

fn key_matches(env: &Env, actual: &String, expected: &str) -> bool {
    actual.clone() == String::from_str(env, expected)
}

fn validate_param(env: &Env, key: &String, value: i128) {
    assert!(value >= 0, "parameter must be non-negative");

    if key_matches(env, key, "protocol_fee_bps")
        || key_matches(env, key, "collateral_factor")
        || key_matches(env, key, "borrow_rate_bps")
        || key_matches(env, key, "liquidation_threshold")
        || key_matches(env, key, "lp_protocol_fee_bps")
    {
        assert!(value <= 10_000, "parameter exceeds max bps");
        return;
    }

    if key_matches(env, key, "cooldown_period") {
        assert!(value > 0, "invalid cooldown");
        return;
    }

    panic!("unsupported proposal action");
}

fn quorum_met(env: &Env, proposal: &Proposal) -> bool {
    let total_votes = proposal.votes_for + proposal.votes_against;
    if total_votes <= 0 {
        return false;
    }

    let reference_supply: i128 = env.storage().instance().get(&DataKey::ReferenceSupply).unwrap_or(0);
    if reference_supply <= 0 {
        return true;
    }

    let quorum_bps = read_quorum_bps(env);
    total_votes >= reference_supply * quorum_bps / BPS_DENOMINATOR
}

fn proposal_passed(env: &Env, proposal: &Proposal) -> bool {
    quorum_met(env, proposal) && proposal.votes_for > proposal.votes_against
}

#[contractclient(name = "TimelockClient")]
pub trait TimelockInterface {
    fn min_delay_ledgers(env: Env) -> u32;
    fn schedule(env: Env, proposal_id: u64, param_key: String, new_value: i128, eta_ledger: u32);
    fn execute(env: Env, proposal_id: u64);
    fn is_operation_cancelled(env: Env, proposal_id: u64) -> bool;
    fn is_operation_executed(env: Env, proposal_id: u64) -> bool;
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        sxlm_token: Address,
        timelock_contract: Address,
        voting_period_ledgers: u32,
        quorum_bps: u32,
    ) {
        let already: bool = env.storage().instance().get(&DataKey::Initialized).unwrap_or(false);
        if already {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SxlmToken, &sxlm_token);
        env.storage()
            .instance()
            .set(&DataKey::TimelockContract, &timelock_contract);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriodLedgers, &voting_period_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::QuorumBps, &(quorum_bps as i128));
        env.storage().instance().set(&DataKey::ReferenceSupply, &0i128);
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

    pub fn set_reference_supply(env: Env, supply: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(supply >= 0, "supply must be non-negative");
        extend_instance(&env);
        env.storage().instance().set(&DataKey::ReferenceSupply, &supply);
    }

    pub fn create_proposal(
        env: Env,
        proposer: Address,
        param_key: String,
        new_value: i128,
    ) -> u64 {
        proposer.require_auth();
        extend_instance(&env);
        validate_param(&env, &param_key, new_value);

        let sxlm = read_sxlm_token(&env);
        let balance = token::Client::new(&env, &sxlm).balance(&proposer);
        assert!(
            balance >= MIN_PROPOSAL_BALANCE,
            "insufficient sXLM to create proposal"
        );

        let id = next_proposal_id(&env);
        let current_ledger = env.ledger().sequence();
        let voting_period = read_voting_period(&env);

        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            param_key: param_key.clone(),
            new_value,
            votes_for: 0,
            votes_against: 0,
            start_ledger: current_ledger,
            end_ledger: current_ledger + voting_period,
            queued_ledger: 0,
            eta_ledger: 0,
            executed: false,
        };
        write_proposal(&env, &proposal);

        env.events().publish(
            (soroban_sdk::symbol_short!("propose"),),
            (id, proposer, param_key, new_value),
        );
        id
    }

    pub fn vote(env: Env, voter: Address, proposal_id: u64, support: bool) {
        voter.require_auth();
        extend_instance(&env);
        extend_vote(&env, proposal_id, &voter);

        let mut proposal = read_proposal(&env, proposal_id);
        assert!(proposal.queued_ledger == 0, "proposal already queued");
        assert!(!proposal.executed, "proposal already executed");

        let current_ledger = env.ledger().sequence();
        assert!(current_ledger <= proposal.end_ledger, "voting period has ended");
        assert!(!has_voted(&env, proposal_id, &voter), "already voted");

        let sxlm = read_sxlm_token(&env);
        let weight = token::Client::new(&env, &sxlm).balance(&voter);
        assert!(weight > 0, "no sXLM to vote with");

        if support {
            proposal.votes_for += weight;
        } else {
            proposal.votes_against += weight;
        }

        set_voted(&env, proposal_id, &voter);
        write_proposal(&env, &proposal);

        env.events().publish(
            (soroban_sdk::symbol_short!("voted"),),
            (proposal_id, voter, support, weight),
        );
    }

    pub fn queue_proposal(env: Env, proposal_id: u64) {
        extend_instance(&env);
        extend_proposal(&env, proposal_id);

        let mut proposal = read_proposal(&env, proposal_id);
        assert!(!proposal.executed, "proposal already executed");
        assert!(proposal.queued_ledger == 0, "proposal already queued");
        assert!(
            env.ledger().sequence() > proposal.end_ledger,
            "voting period not ended"
        );
        assert!(proposal_passed(&env, &proposal), "proposal did not pass");

        let timelock_address = read_timelock_contract(&env);
        let timelock = TimelockClient::new(&env, &timelock_address);
        let current_ledger = env.ledger().sequence();
        let eta_ledger = current_ledger + timelock.min_delay_ledgers();

        timelock.schedule(
            &proposal_id,
            &proposal.param_key.clone(),
            &proposal.new_value,
            &eta_ledger,
        );

        proposal.queued_ledger = current_ledger;
        proposal.eta_ledger = eta_ledger;
        write_proposal(&env, &proposal);

        env.events().publish(
            (soroban_sdk::symbol_short!("queued"),),
            (proposal_id, eta_ledger),
        );
    }

    pub fn execute_proposal(env: Env, proposal_id: u64) {
        extend_instance(&env);
        extend_proposal(&env, proposal_id);

        let mut proposal = read_proposal(&env, proposal_id);
        assert!(!proposal.executed, "proposal already executed");
        assert!(proposal.queued_ledger > 0, "proposal not queued");

        let timelock = TimelockClient::new(&env, &read_timelock_contract(&env));
        assert!(
            !timelock.is_operation_cancelled(&proposal_id),
            "proposal cancelled"
        );

        timelock.execute(&proposal_id);
        proposal.executed = true;
        write_proposal(&env, &proposal);

        env.events().publish(
            (soroban_sdk::symbol_short!("executed"),),
            (proposal_id, proposal.param_key, proposal.new_value),
        );
    }

    pub fn get_proposal(env: Env, id: u64) -> Proposal {
        extend_instance(&env);
        read_proposal(&env, id)
    }

    pub fn proposal_count(env: Env) -> u64 {
        extend_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    pub fn get_vote_count(env: Env, id: u64) -> (i128, i128) {
        extend_instance(&env);
        let proposal = read_proposal(&env, id);
        (proposal.votes_for, proposal.votes_against)
    }

    pub fn get_proposal_state(env: Env, id: u64) -> String {
        extend_instance(&env);
        let proposal = read_proposal(&env, id);
        let timelock = TimelockClient::new(&env, &read_timelock_contract(&env));

        if proposal.executed || timelock.is_operation_executed(&id) {
            return String::from_str(&env, "executed");
        }

        if proposal.queued_ledger > 0 {
            if timelock.is_operation_cancelled(&id) {
                return String::from_str(&env, "cancelled");
            }
            return String::from_str(&env, "queued");
        }

        if env.ledger().sequence() <= proposal.end_ledger {
            return String::from_str(&env, "active");
        }

        if proposal_passed(&env, &proposal) {
            return String::from_str(&env, "passed");
        }

        String::from_str(&env, "rejected")
    }

    pub fn can_queue_proposal(env: Env, id: u64) -> bool {
        extend_instance(&env);
        let proposal = read_proposal(&env, id);
        !proposal.executed
            && proposal.queued_ledger == 0
            && env.ledger().sequence() > proposal.end_ledger
            && proposal_passed(&env, &proposal)
    }

    pub fn can_execute_proposal(env: Env, id: u64) -> bool {
        extend_instance(&env);
        let proposal = read_proposal(&env, id);
        if proposal.executed || proposal.queued_ledger == 0 {
            return false;
        }

        let timelock = TimelockClient::new(&env, &read_timelock_contract(&env));
        !timelock.is_operation_cancelled(&id)
            && !timelock.is_operation_executed(&id)
            && env.ledger().sequence() >= proposal.eta_ledger
    }

    pub fn timelock_contract(env: Env) -> Address {
        extend_instance(&env);
        read_timelock_contract(&env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token::StellarAssetClient, Env};

    #[contract]
    struct MockTimelock;

    #[derive(Clone)]
    #[contracttype]
    enum MockKey {
        Delay,
        Cancelled(u64),
        Executed(u64),
    }

    #[contractimpl]
    impl MockTimelock {
        pub fn min_delay_ledgers(env: Env) -> u32 {
            env.storage().instance().get(&MockKey::Delay).unwrap_or(50u32)
        }

        pub fn schedule(
            _env: Env,
            _proposal_id: u64,
            _param_key: String,
            _new_value: i128,
            _eta_ledger: u32,
        ) {
        }

        pub fn execute(env: Env, proposal_id: u64) {
            env.storage()
                .instance()
                .set(&MockKey::Executed(proposal_id), &true);
        }

        pub fn is_operation_cancelled(env: Env, proposal_id: u64) -> bool {
            env.storage()
                .instance()
                .get(&MockKey::Cancelled(proposal_id))
                .unwrap_or(false)
        }

        pub fn is_operation_executed(env: Env, proposal_id: u64) -> bool {
            env.storage()
                .instance()
                .get(&MockKey::Executed(proposal_id))
                .unwrap_or(false)
        }
    }

    fn setup_test() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let sxlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let timelock_id = env.register_contract(None, MockTimelock);
        let contract_id = env.register_contract(None, GovernanceContract);

        let client = GovernanceContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &timelock_id, &100, &1000);

        let sxlm_admin = StellarAssetClient::new(&env, &sxlm_id);
        sxlm_admin.mint(&proposer, &10_000_0000000);
        sxlm_admin.mint(&voter, &5_000_0000000);

        (env, contract_id, sxlm_id, proposer, voter)
    }

    #[test]
    fn test_create_vote_queue_execute() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "collateral_factor"),
            &7500,
        );

        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        env.ledger().with_mut(|li| {
            li.sequence_number += 101;
        });

        assert!(client.can_queue_proposal(&0));
        client.queue_proposal(&0);
        assert_eq!(client.get_proposal_state(&0), String::from_str(&env, "queued"));

        env.ledger().with_mut(|li| {
            li.sequence_number += 50;
        });

        assert!(client.can_execute_proposal(&0));
        client.execute_proposal(&0);
        assert_eq!(
            client.get_proposal_state(&0),
            String::from_str(&env, "executed")
        );
    }

    #[test]
    #[should_panic(expected = "unsupported proposal action")]
    fn test_rejects_unknown_param() {
        let (env, contract_id, _, proposer, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "buffer_safety_factor"),
            &250,
        );
    }
}

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, String, Symbol,
};

const BPS_DENOMINATOR: i128 = 10_000;
const MIN_PROPOSAL_BALANCE: i128 = 100_0000000; // 100 sXLM minimum to create proposal
const DEFAULT_TIMELOCK_DELAY_SECS: u64 = 48 * 60 * 60; // 48 hours
const MAX_TIMELOCK_DELAY_SECS: u64 = 30 * 24 * 60 * 60; // 30 days hard cap

// ---------- TTL constants ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // bump to ~30 days
const PROPOSAL_LIFETIME_THRESHOLD: u32 = 518_400; // ~30 days
const PROPOSAL_BUMP_AMOUNT: u32 = 3_110_400; // bump to ~180 days

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Guardian,
    SxlmToken,
    VotingPeriodLedgers,
    QuorumBps,
    Initialized,
    ProposalCount,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter) → bool
    TimelockQueue(u64), // proposal_id -> TimelockEntry
    ExecutionDelaySecs,
    InterestRate,
    FeeParameter,
    CollateralFactor,
    // Total sXLM supply reference for quorum calculation (set by admin)
    ReferenceSupply,
}

#[derive(Clone)]
#[contracttype]
pub enum ProposalAction {
    UpdateRate { new_rate: i128 },
    UpdateFee { new_fee: i128 },
    UpdateCollateralFactor { new_factor: i128 },
}

#[derive(Clone)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action: ProposalAction,
    pub votes_for: i128,
    pub votes_against: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
}

#[derive(Clone)]
#[contracttype]
pub enum TimelockStatus {
    Queued,
    Executed,
    Cancelled,
}

#[derive(Clone)]
#[contracttype]
pub struct TimelockEntry {
    pub proposal_id: u64,
    pub execution_time: u64,
    pub status: TimelockStatus,
}

// --- Storage helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_persistent_key(env: &Env, key: &DataKey) {
    if env.storage().persistent().has(key) {
        env.storage()
            .persistent()
            .extend_ttl(key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
    }
}

fn extend_proposal(env: &Env, id: u64) {
    extend_persistent_key(env, &DataKey::Proposal(id));
}

fn extend_vote(env: &Env, proposal_id: u64, voter: &Address) {
    extend_persistent_key(env, &DataKey::Vote(proposal_id, voter.clone()));
}

fn extend_timelock(env: &Env, proposal_id: u64) {
    extend_persistent_key(env, &DataKey::TimelockQueue(proposal_id));
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_guardian(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Guardian).unwrap()
}

fn read_sxlm_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SxlmToken).unwrap()
}

fn read_voting_period(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::VotingPeriodLedgers)
        .unwrap_or(17_280u32) // ~24 hours
}

fn read_quorum_bps(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::QuorumBps).unwrap_or(1000) // 10%
}

fn read_delay_secs(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::ExecutionDelaySecs)
        .unwrap_or(DEFAULT_TIMELOCK_DELAY_SECS)
}

fn next_proposal_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ProposalCount)
        .unwrap_or(0);
    env.storage().instance().set(&DataKey::ProposalCount, &(id + 1));
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
    let val: bool = env.storage().persistent().get(&key).unwrap_or(false);
    if val {
        env.storage()
            .persistent()
            .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
    }
    val
}

fn set_voted(env: &Env, proposal_id: u64, voter: &Address) {
    let key = DataKey::Vote(proposal_id, voter.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
}

fn read_timelock_entry(env: &Env, proposal_id: u64) -> Option<TimelockEntry> {
    let key = DataKey::TimelockQueue(proposal_id);
    let entry = env.storage().persistent().get(&key);
    if entry.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
    }
    entry
}

fn write_timelock_entry(env: &Env, entry: &TimelockEntry) {
    let key = DataKey::TimelockQueue(entry.proposal_id);
    env.storage().persistent().set(&key, entry);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
}

fn check_quorum_and_passed(env: &Env, proposal: &Proposal) {
    let current_ledger = env.ledger().sequence();
    assert!(current_ledger > proposal.end_ledger, "voting period not ended");

    let total_votes = proposal.votes_for + proposal.votes_against;
    assert!(total_votes > 0, "no votes cast");

    let quorum_bps = read_quorum_bps(env);
    let reference_supply: i128 = env
        .storage()
        .instance()
        .get(&DataKey::ReferenceSupply)
        .unwrap_or(0);

    if reference_supply > 0 {
        let min_votes_required = reference_supply * quorum_bps / BPS_DENOMINATOR;
        assert!(total_votes >= min_votes_required, "quorum not met");
    }

    assert!(proposal.votes_for > proposal.votes_against, "proposal did not pass");
}

fn proposal_passes(env: &Env, proposal: &Proposal) -> bool {
    if env.ledger().sequence() <= proposal.end_ledger {
        return false;
    }

    let total_votes = proposal.votes_for + proposal.votes_against;
    if total_votes <= 0 || proposal.votes_for <= proposal.votes_against {
        return false;
    }

    let quorum_bps = read_quorum_bps(env);
    let reference_supply: i128 = env
        .storage()
        .instance()
        .get(&DataKey::ReferenceSupply)
        .unwrap_or(0);

    if reference_supply > 0 {
        return total_votes >= reference_supply * quorum_bps / BPS_DENOMINATOR;
    }

    true
}

fn validate_action(action: &ProposalAction) {
    match action {
        ProposalAction::UpdateRate { new_rate } => {
            assert!(*new_rate >= 0, "rate must be non-negative");
            assert!(*new_rate <= BPS_DENOMINATOR, "rate exceeds 100%");
        }
        ProposalAction::UpdateFee { new_fee } => {
            assert!(*new_fee >= 0, "fee must be non-negative");
            assert!(*new_fee <= BPS_DENOMINATOR, "fee exceeds 100%");
        }
        ProposalAction::UpdateCollateralFactor { new_factor } => {
            assert!(*new_factor >= 0, "collateral factor must be non-negative");
            assert!(
                *new_factor <= BPS_DENOMINATOR,
                "collateral factor exceeds 100%"
            );
        }
    }
}

fn apply_action(env: &Env, action: &ProposalAction) {
    match action {
        ProposalAction::UpdateRate { new_rate } => {
            env.storage().persistent().set(&DataKey::InterestRate, new_rate);
            extend_persistent_key(env, &DataKey::InterestRate);
        }
        ProposalAction::UpdateFee { new_fee } => {
            env.storage().persistent().set(&DataKey::FeeParameter, new_fee);
            extend_persistent_key(env, &DataKey::FeeParameter);
        }
        ProposalAction::UpdateCollateralFactor { new_factor } => {
            env.storage()
                .persistent()
                .set(&DataKey::CollateralFactor, new_factor);
            extend_persistent_key(env, &DataKey::CollateralFactor);
        }
    }
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        guardian: Address,
        sxlm_token: Address,
        voting_period_ledgers: u32,
        quorum_bps: u32,
        execution_delay_secs: u64,
    ) {
        let already: bool = env.storage().instance().get(&DataKey::Initialized).unwrap_or(false);
        if already {
            panic!("already initialized");
        }

        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage().instance().set(&DataKey::SxlmToken, &sxlm_token);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriodLedgers, &voting_period_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::QuorumBps, &(quorum_bps as i128));
        env.storage().instance().set(
            &DataKey::ExecutionDelaySecs,
            &if execution_delay_secs == 0 {
                DEFAULT_TIMELOCK_DELAY_SECS
            } else {
                execution_delay_secs
            },
        );
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

    pub fn set_guardian(env: Env, guardian: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
    }

    pub fn set_execution_delay(env: Env, delay_secs: u64) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(delay_secs > 0, "delay must be positive");
        assert!(delay_secs <= MAX_TIMELOCK_DELAY_SECS, "delay too large");
        extend_instance(&env);
        env.storage().instance().set(&DataKey::ExecutionDelaySecs, &delay_secs);
    }

    pub fn create_proposal(env: Env, proposer: Address, action: ProposalAction) -> u64 {
        proposer.require_auth();
        extend_instance(&env);
        validate_action(&action);

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
            action: action.clone(),
            votes_for: 0,
            votes_against: 0,
            start_ledger: current_ledger,
            end_ledger: current_ledger + voting_period,
        };

        write_proposal(&env, &proposal);

        env.events()
            .publish((symbol_short!("propose"),), (id, proposer, action));

        id
    }

    pub fn vote(env: Env, voter: Address, proposal_id: u64, support: bool) {
        voter.require_auth();
        extend_instance(&env);
        extend_vote(&env, proposal_id, &voter);

        let mut proposal = read_proposal(&env, proposal_id);

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
            (symbol_short!("voted"),),
            (proposal_id, voter, support, weight),
        );

        // Integration point: once proposal is passed and period has ended, queue it automatically.
        if current_ledger == proposal.end_ledger {
            let has_queue = read_timelock_entry(&env, proposal_id).is_some();
            if !has_queue && proposal_passes(&env, &proposal) {
                Self::queue_proposal(env.clone(), proposal_id);
            }
        }
    }

    pub fn queue_proposal(env: Env, proposal_id: u64) {
        extend_instance(&env);
        extend_proposal(&env, proposal_id);
        extend_timelock(&env, proposal_id);

        let proposal = read_proposal(&env, proposal_id);
        check_quorum_and_passed(&env, &proposal);

        let existing = read_timelock_entry(&env, proposal_id);
        if let Some(entry) = existing {
            match entry.status {
                TimelockStatus::Queued => panic!("proposal already queued"),
                TimelockStatus::Executed => panic!("proposal already executed"),
                TimelockStatus::Cancelled => panic!("proposal cancelled"),
            }
        }

        let now = env.ledger().timestamp();
        let delay = read_delay_secs(&env);
        assert!(delay > 0, "delay must be positive");
        assert!(delay <= MAX_TIMELOCK_DELAY_SECS, "delay too large");
        let entry = TimelockEntry {
            proposal_id,
            execution_time: now + delay,
            status: TimelockStatus::Queued,
        };

        write_timelock_entry(&env, &entry);

        env.events().publish(
            (Symbol::new(&env, "ProposalQueued"),),
            (proposal_id, entry.execution_time),
        );
    }

    pub fn execute_proposal(env: Env, proposal_id: u64) {
        extend_instance(&env);
        extend_proposal(&env, proposal_id);
        extend_timelock(&env, proposal_id);

        let proposal = read_proposal(&env, proposal_id);

        // Integration fallback: if passed and not queued, queue first and require a second call after timelock.
        if read_timelock_entry(&env, proposal_id).is_none() {
            Self::queue_proposal(env.clone(), proposal_id);
            return;
        }

        let mut entry = read_timelock_entry(&env, proposal_id).unwrap();

        match entry.status {
            TimelockStatus::Queued => {}
            TimelockStatus::Executed => panic!("proposal already executed"),
            TimelockStatus::Cancelled => panic!("proposal cancelled"),
        }

        let now = env.ledger().timestamp();
        assert!(now >= entry.execution_time, "timelock not expired");

        // Defensive revalidation right before execution.
        check_quorum_and_passed(&env, &proposal);

        // State transition before action application to minimize reentrancy-like risk.
        entry.status = TimelockStatus::Executed;
        write_timelock_entry(&env, &entry);

        apply_action(&env, &proposal.action);

        env.events().publish(
            (Symbol::new(&env, "ProposalExecuted"),),
            (proposal_id, now),
        );
    }

    pub fn cancel_proposal(env: Env, guardian: Address, proposal_id: u64) {
        guardian.require_auth();
        extend_instance(&env);
        extend_timelock(&env, proposal_id);

        let stored_guardian = read_guardian(&env);
        assert!(guardian == stored_guardian, "not guardian");

        let mut entry = read_timelock_entry(&env, proposal_id).unwrap();
        match entry.status {
            TimelockStatus::Queued => {
                entry.status = TimelockStatus::Cancelled;
                write_timelock_entry(&env, &entry);
                env.events().publish(
                    (Symbol::new(&env, "ProposalCancelled"),),
                    (proposal_id, env.ledger().timestamp()),
                );
            }
            TimelockStatus::Executed => panic!("proposal already executed"),
            TimelockStatus::Cancelled => panic!("proposal already cancelled"),
        }
    }

    // --- Views ---

    pub fn get_proposal(env: Env, id: u64) -> Proposal {
        extend_instance(&env);
        read_proposal(&env, id)
    }

    pub fn get_timelock_entry(env: Env, proposal_id: u64) -> Option<TimelockEntry> {
        extend_instance(&env);
        read_timelock_entry(&env, proposal_id)
    }

    pub fn proposal_count(env: Env) -> u64 {
        extend_instance(&env);
        env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0)
    }

    pub fn get_vote_count(env: Env, id: u64) -> (i128, i128) {
        extend_instance(&env);
        let proposal = read_proposal(&env, id);
        (proposal.votes_for, proposal.votes_against)
    }

    pub fn get_execution_delay(env: Env) -> u64 {
        extend_instance(&env);
        read_delay_secs(&env)
    }

    pub fn get_guardian(env: Env) -> Address {
        extend_instance(&env);
        read_guardian(&env)
    }

    pub fn get_interest_rate(env: Env) -> i128 {
        extend_instance(&env);
        let key = DataKey::InterestRate;
        let value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        extend_persistent_key(&env, &key);
        value
    }

    pub fn get_fee_parameter(env: Env) -> i128 {
        extend_instance(&env);
        let key = DataKey::FeeParameter;
        let value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        extend_persistent_key(&env, &key);
        value
    }

    pub fn get_collateral_factor(env: Env) -> i128 {
        extend_instance(&env);
        let key = DataKey::CollateralFactor;
        let value: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        extend_persistent_key(&env, &key);
        value
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Events, Ledger};
    use soroban_sdk::{token::StellarAssetClient, Address, Env};
    use std::println;

    fn setup_test() -> (Env, Address, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let sxlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
        let contract_id = env.register_contract(None, GovernanceContract);

        let client = GovernanceContractClient::new(&env, &contract_id);
        client.initialize(&admin, &guardian, &sxlm_id, &100, &1000, &0); // default 48h delay

        let sxlm_admin = StellarAssetClient::new(&env, &sxlm_id);
        sxlm_admin.mint(&proposer, &10_000_0000000);
        sxlm_admin.mint(&voter, &5_000_0000000);

        (env, contract_id, sxlm_id, guardian, proposer, voter)
    }

    fn close_voting_window(env: &Env, ledgers_to_advance: u32) {
        env.ledger().with_mut(|ledger_info| {
            ledger_info.sequence_number += ledgers_to_advance;
        });
    }

    fn set_time_to(env: &Env, unix_timestamp: u64) {
        env.ledger().with_mut(|ledger_info| {
            ledger_info.timestamp = unix_timestamp;
        });
    }

    fn print_status_transition(
        client: &GovernanceContractClient,
        proposal_id: u64,
        label: &str,
    ) {
        let status_text = match client.get_timelock_entry(&proposal_id) {
            Some(entry) => match entry.status {
                TimelockStatus::Queued => "Queued",
                TimelockStatus::Executed => "Executed",
                TimelockStatus::Cancelled => "Cancelled",
            },
            None => "NotQueued",
        };
        println!("[FLOW] {label}: proposal_id={proposal_id}, status={status_text}");
    }

    fn assert_event_contains(env: &Env, expected_fragment: &str) {
        let all_events = env.events().all();
        let debug_dump = std::format!("{:?}", all_events);
        assert!(
            debug_dump.contains(expected_fragment),
            "missing expected event fragment: {}",
            expected_fragment
        );
    }

    fn passed_and_queued_fee_proposal(
        env: &Env,
        client: &GovernanceContractClient,
        proposer: &Address,
        voter: &Address,
        proposal_id: u64,
        new_fee: i128,
    ) {
        client.create_proposal(proposer, &ProposalAction::UpdateFee { new_fee });
        client.vote(proposer, &proposal_id, &true);
        client.vote(voter, &proposal_id, &true);
        close_voting_window(env, 101);
        client.queue_proposal(&proposal_id);
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, _, guardian, _, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        assert_eq!(client.proposal_count(), 0);
        assert_eq!(client.get_guardian(), guardian);
        assert_eq!(client.get_execution_delay(), DEFAULT_TIMELOCK_DELAY_SECS);
    }

    #[test]
    fn test_create_proposal_with_validated_action() {
        let (env, contract_id, _, _, proposer, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        let id = client.create_proposal(&proposer, &ProposalAction::UpdateFee { new_fee: 500 });
        assert_eq!(id, 0);
        assert_eq!(client.proposal_count(), 1);

        let p = client.get_proposal(&0);
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    fn test_vote_adds_weight_to_for_votes() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(&proposer, &ProposalAction::UpdateFee { new_fee: 500 });
        client.vote(&voter, &0, &true);

        let (votes_for, votes_against) = client.get_vote_count(&0);
        assert_eq!(votes_for, 5_000_0000000);
        assert_eq!(votes_against, 0);
    }

    #[test]
    #[should_panic(expected = "already voted")]
    fn test_double_vote_rejected() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(&proposer, &ProposalAction::UpdateFee { new_fee: 500 });

        client.vote(&voter, &0, &true);
        client.vote(&voter, &0, &false);
    }

    #[test]
    fn test_proposal_queueing_sets_execution_time() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        let start_timestamp = env.ledger().timestamp();
        passed_and_queued_fee_proposal(&env, &client, &proposer, &voter, 0, 420);

        let entry = client.get_timelock_entry(&0).unwrap();
        assert!(matches!(entry.status, TimelockStatus::Queued));
        assert_eq!(
            entry.execution_time,
            start_timestamp + client.get_execution_delay()
        );

        assert_event_contains(&env, "ProposalQueued");
    }

    #[test]
    fn test_timelock_enforcement_and_post_delay_execution() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        passed_and_queued_fee_proposal(&env, &client, &proposer, &voter, 0, 425);
        let queued_entry = client.get_timelock_entry(&0).unwrap();

        // Before delay: must fail.
        let early_attempt = std::panic::catch_unwind(|| {
            client.execute_proposal(&0);
        });
        assert!(early_attempt.is_err());

        // Exact boundary: must succeed.
        set_time_to(&env, queued_entry.execution_time);
        client.execute_proposal(&0);

        let post_exec = client.get_timelock_entry(&0).unwrap();
        assert!(matches!(post_exec.status, TimelockStatus::Executed));
        assert_eq!(client.get_fee_parameter(), 425);
        assert_event_contains(&env, "ProposalExecuted");
    }

    #[test]
    #[should_panic(expected = "timelock not expired")]
    fn test_execute_before_delay_fails() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        passed_and_queued_fee_proposal(&env, &client, &proposer, &voter, 0, 100);
        client.execute_proposal(&0);
    }

    #[test]
    fn test_execute_after_delay_succeeds_and_action_applies() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &ProposalAction::UpdateCollateralFactor { new_factor: 7500 },
        );

        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        close_voting_window(&env, 101);

        client.queue_proposal(&0);

        let entry = client.get_timelock_entry(&0).unwrap();
        assert!(matches!(entry.status, TimelockStatus::Queued));

        set_time_to(&env, entry.execution_time);

        client.execute_proposal(&0);
        let updated = client.get_timelock_entry(&0).unwrap();
        assert!(matches!(updated.status, TimelockStatus::Executed));
        assert_eq!(client.get_collateral_factor(), 7500);

        // Second execution attempt must fail (double execution prevention).
        let second_attempt = std::panic::catch_unwind(|| {
            client.execute_proposal(&0);
        });
        assert!(second_attempt.is_err());
    }

    #[test]
    #[should_panic(expected = "proposal did not pass")]
    fn test_queue_failed_proposal() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(&proposer, &ProposalAction::UpdateRate { new_rate: 200 });

        client.vote(&proposer, &0, &false);
        client.vote(&voter, &0, &true);

        close_voting_window(&env, 101);

        client.queue_proposal(&0);
    }

    #[test]
    fn test_guardian_can_cancel_queued_proposal() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        let guardian = client.get_guardian();
        passed_and_queued_fee_proposal(&env, &client, &proposer, &voter, 0, 300);

        client.cancel_proposal(&guardian, &0);

        let entry = client.get_timelock_entry(&0).unwrap();
        assert!(matches!(entry.status, TimelockStatus::Cancelled));
        assert_event_contains(&env, "ProposalCancelled");
    }

    #[test]
    #[should_panic(expected = "proposal cancelled")]
    fn test_cancelled_proposal_cannot_execute() {
        let (env, contract_id, _, guardian, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(&proposer, &ProposalAction::UpdateFee { new_fee: 300 });
        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        close_voting_window(&env, 101);

        client.queue_proposal(&0);
        let entry = client.get_timelock_entry(&0).unwrap();
        client.cancel_proposal(&guardian, &0);

        set_time_to(&env, entry.execution_time);

        client.execute_proposal(&0);
    }

    #[test]
    #[should_panic]
    fn test_execute_non_existent_proposal_fails() {
        let (env, contract_id, _, _, _, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.execute_proposal(&999);
    }

    #[test]
    #[should_panic(expected = "proposal already executed")]
    fn test_cancel_executed_proposal_fails() {
        let (env, contract_id, _, guardian, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        passed_and_queued_fee_proposal(&env, &client, &proposer, &voter, 0, 360);
        let entry = client.get_timelock_entry(&0).unwrap();
        set_time_to(&env, entry.execution_time);

        client.execute_proposal(&0);
        client.cancel_proposal(&guardian, &0);
    }

    #[test]
    #[should_panic(expected = "proposal already queued")]
    fn test_queue_already_queued_proposal_fails() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        passed_and_queued_fee_proposal(&env, &client, &proposer, &voter, 0, 333);
        client.queue_proposal(&0);
    }

    #[test]
    fn test_multiple_proposals_can_queue_and_execute_independently() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(&proposer, &ProposalAction::UpdateFee { new_fee: 410 });
        client.create_proposal(&proposer, &ProposalAction::UpdateRate { new_rate: 275 });

        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);
        client.vote(&proposer, &1, &true);
        client.vote(&voter, &1, &true);

        close_voting_window(&env, 101);

        client.queue_proposal(&0);
        client.queue_proposal(&1);

        let entry_0 = client.get_timelock_entry(&0).unwrap();
        let entry_1 = client.get_timelock_entry(&1).unwrap();

        set_time_to(&env, entry_0.execution_time);
        client.execute_proposal(&0);
        client.execute_proposal(&1);

        assert!(matches!(client.get_timelock_entry(&0).unwrap().status, TimelockStatus::Executed));
        assert!(matches!(client.get_timelock_entry(&1).unwrap().status, TimelockStatus::Executed));
        assert_eq!(client.get_fee_parameter(), 410);
        assert_eq!(client.get_interest_rate(), 275);
    }

    #[test]
    fn test_boundary_execution_time_exact_timestamp() {
        let (env, contract_id, _, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        passed_and_queued_fee_proposal(&env, &client, &proposer, &voter, 0, 555);
        let queued_entry = client.get_timelock_entry(&0).unwrap();

        set_time_to(&env, queued_entry.execution_time);
        client.execute_proposal(&0);

        assert!(matches!(
            client.get_timelock_entry(&0).unwrap().status,
            TimelockStatus::Executed
        ));
    }

    #[test]
    fn test_end_to_end_flow_with_proof_logs() {
        let (env, contract_id, _, guardian, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        // 1) Create proposal
        let proposal_id = client.create_proposal(&proposer, &ProposalAction::UpdateRate { new_rate: 300 });
        println!("[PROOF] Proposal created: id={proposal_id}, action=UpdateRate(300)");
        print_status_transition(&client, proposal_id, "After create");

        // 2) Vote and pass
        client.vote(&proposer, &proposal_id, &true);
        client.vote(&voter, &proposal_id, &true);
        println!("[PROOF] Proposal passed: id={proposal_id}, votes recorded");

        // 3) Queue into timelock
        close_voting_window(&env, 101);
        client.queue_proposal(&proposal_id);
        let queued = client.get_timelock_entry(&proposal_id).unwrap();
        println!(
            "[PROOF] Proposal queued: id={}, execution_time={}",
            proposal_id, queued.execution_time
        );
        print_status_transition(&client, proposal_id, "After queue");

        // 4) Attempt execution before delay (expected fail)
        let early_execution = std::panic::catch_unwind(|| {
            client.execute_proposal(&proposal_id);
        });
        assert!(early_execution.is_err());
        println!("[PROOF] Early execution failed as expected: id={proposal_id}");

        // 5) Advance time and execute
        set_time_to(&env, queued.execution_time);
        client.execute_proposal(&proposal_id);
        println!("[PROOF] Execution after delay succeeded: id={proposal_id}");

        // 6) Verify state change
        assert_eq!(client.get_interest_rate(), 300);
        assert!(matches!(
            client.get_timelock_entry(&proposal_id).unwrap().status,
            TimelockStatus::Executed
        ));
        println!("[PROOF] State change confirmed: interest_rate=300, status=Executed");
        print_status_transition(&client, proposal_id, "After execute");

        // 7) Verify all event types were emitted in this run.
        assert_event_contains(&env, "ProposalQueued");
        assert_event_contains(&env, "ProposalExecuted");

        // 8) Cancel path event check in same flow using second proposal.
        let cancel_id = client.create_proposal(&proposer, &ProposalAction::UpdateFee { new_fee: 222 });
        client.vote(&proposer, &cancel_id, &true);
        client.vote(&voter, &cancel_id, &true);
        close_voting_window(&env, 101);
        client.queue_proposal(&cancel_id);
        client.cancel_proposal(&guardian, &cancel_id);
        assert_event_contains(&env, "ProposalCancelled");
    }

    #[test]
    #[should_panic(expected = "fee exceeds 100%")]
    fn test_custom_validation_rejects_invalid_fee_action() {
        let (env, contract_id, _, _, proposer, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &ProposalAction::UpdateFee {
                new_fee: BPS_DENOMINATOR + 1,
            },
        );
    }

    #[test]
    #[should_panic(expected = "delay too large")]
    fn test_custom_validation_rejects_large_delay() {
        let (env, contract_id, _, _, _, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);
        client.set_execution_delay(&(MAX_TIMELOCK_DELAY_SECS + 1));
    }
}

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, String};

const BPS_DENOMINATOR: i128 = 10_000;
const MIN_PROPOSAL_BALANCE: i128 = 100_0000000; // 100 sXLM minimum to create proposal

// Default timelock delay: ~48 hours at ~5s/ledger
const DEFAULT_TIMELOCK_DELAY: u32 = 34_560;

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
    TimelockDelay,
    Initialized,
    ProposalCount,
    Proposal(u64),
    Vote(u64, Address),
    TimelockEntry(u64), // proposal_id → TimelockEntry
    Param(String),
    ReferenceSupply,
}

#[derive(Clone)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub param_key: String,
    pub new_value: String,
    pub votes_for: i128,
    pub votes_against: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub executed: bool,
    pub queued: bool,
}

/// A passed proposal waiting in the timelock queue.
#[derive(Clone)]
#[contracttype]
pub struct TimelockEntry {
    pub proposal_id: u64,
    pub param_key: String,
    pub new_value: String,
    pub eta_ledger: u32, // earliest ledger at which execution is allowed
    pub cancelled: bool,
}

// --- Storage helpers ---

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn extend_proposal(env: &Env, id: u64) {
    let key = DataKey::Proposal(id);
    if env.storage().persistent().has(&key) {
        env.storage().persistent().extend_ttl(
            &key,
            PROPOSAL_LIFETIME_THRESHOLD,
            PROPOSAL_BUMP_AMOUNT,
        );
    }
}

fn extend_vote(env: &Env, proposal_id: u64, voter: &Address) {
    let key = DataKey::Vote(proposal_id, voter.clone());
    if env.storage().persistent().has(&key) {
        env.storage().persistent().extend_ttl(
            &key,
            PROPOSAL_LIFETIME_THRESHOLD,
            PROPOSAL_BUMP_AMOUNT,
        );
    }
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn read_guardian(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Guardian)
}

fn read_timelock_delay(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::TimelockDelay)
        .unwrap_or(DEFAULT_TIMELOCK_DELAY)
}

fn read_timelock_entry(env: &Env, proposal_id: u64) -> Option<TimelockEntry> {
    let key = DataKey::TimelockEntry(proposal_id);
    let entry: Option<TimelockEntry> = env.storage().persistent().get(&key);
    if entry.is_some() {
        env.storage().persistent().extend_ttl(
            &key,
            PROPOSAL_LIFETIME_THRESHOLD,
            PROPOSAL_BUMP_AMOUNT,
        );
    }
    entry
}

fn write_timelock_entry(env: &Env, entry: &TimelockEntry) {
    let key = DataKey::TimelockEntry(entry.proposal_id);
    env.storage().persistent().set(&key, entry);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_LIFETIME_THRESHOLD, PROPOSAL_BUMP_AMOUNT);
}

fn read_sxlm_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SxlmToken).unwrap()
}

fn read_voting_period(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::VotingPeriodLedgers)
        .unwrap_or(17280u32) // ~24 hours
}

fn read_quorum_bps(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::QuorumBps)
        .unwrap_or(1000) // 10%
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
    // Extend TTL on read
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
        env.storage().persistent().extend_ttl(
            &key,
            PROPOSAL_LIFETIME_THRESHOLD,
            PROPOSAL_BUMP_AMOUNT,
        );
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

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initialize the governance contract.
    pub fn initialize(
        env: Env,
        admin: Address,
        sxlm_token: Address,
        voting_period_ledgers: u32,
        quorum_bps: u32,
        delay_ledgers: u32,
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
            .set(&DataKey::VotingPeriodLedgers, &voting_period_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::QuorumBps, &(quorum_bps as i128));
        // Default reference supply: 0 means quorum check uses absolute minimum
        env.storage()
            .instance()
            .set(&DataKey::ReferenceSupply, &0i128);
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &delay_ledgers);
    }

    /// Set the timelock delay (in ledgers). Only callable by admin.
    pub fn set_timelock_delay(env: Env, delay_ledgers: u32) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &delay_ledgers);
    }

    /// Set the guardian address. Only callable by admin.
    pub fn set_guardian(env: Env, guardian: Address) {
        let admin = read_admin(&env);
        admin.require_auth();
        extend_instance(&env);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
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

    /// Set the reference total supply for quorum calculation. Only callable by admin.
    pub fn set_reference_supply(env: Env, supply: i128) {
        let admin = read_admin(&env);
        admin.require_auth();
        assert!(supply >= 0, "supply must be non-negative");
        extend_instance(&env);
        env.storage()
            .instance()
            .set(&DataKey::ReferenceSupply, &supply);
    }

    /// Create a new governance proposal. Proposer must hold minimum sXLM balance.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        param_key: String,
        new_value: String,
    ) -> u64 {
        proposer.require_auth();
        extend_instance(&env);

        // Check minimum sXLM balance
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
            new_value: new_value.clone(),
            votes_for: 0,
            votes_against: 0,
            start_ledger: current_ledger,
            end_ledger: current_ledger + voting_period,
            executed: false,
            queued: false,
        };

        write_proposal(&env, &proposal);

        env.events().publish(
            (soroban_sdk::symbol_short!("propose"),),
            (id, proposer, param_key),
        );

        id
    }

    /// Vote on a proposal. Vote weight = sXLM balance at time of vote.
    pub fn vote(env: Env, voter: Address, proposal_id: u64, support: bool) {
        voter.require_auth();
        extend_instance(&env);
        extend_vote(&env, proposal_id, &voter);

        let mut proposal = read_proposal(&env, proposal_id);

        // Check voting period
        let current_ledger = env.ledger().sequence();
        assert!(
            current_ledger <= proposal.end_ledger,
            "voting period has ended"
        );

        // Check not already voted
        assert!(!has_voted(&env, proposal_id, &voter), "already voted");

        // Get voter's sXLM balance as vote weight
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

    /// Queue a passed proposal into the timelock. Anyone can call this.
    pub fn queue_proposal(env: Env, proposal_id: u64) {
        extend_instance(&env);
        extend_proposal(&env, proposal_id);

        let mut proposal = read_proposal(&env, proposal_id);

        assert!(!proposal.executed, "proposal already executed");
        assert!(!proposal.queued, "proposal already queued");

        let current_ledger = env.ledger().sequence();
        assert!(
            current_ledger > proposal.end_ledger,
            "voting period not ended"
        );

        // Quorum check
        let total_votes = proposal.votes_for + proposal.votes_against;
        assert!(total_votes > 0, "no votes cast");

        let quorum_bps = read_quorum_bps(&env);
        let reference_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReferenceSupply)
            .unwrap_or(0);
        if reference_supply > 0 {
            let min_votes_required = reference_supply * quorum_bps / BPS_DENOMINATOR;
            assert!(total_votes >= min_votes_required, "quorum not met");
        }

        assert!(
            proposal.votes_for > proposal.votes_against,
            "proposal did not pass"
        );

        let delay = read_timelock_delay(&env);
        let eta = current_ledger + delay;

        let entry = TimelockEntry {
            proposal_id,
            param_key: proposal.param_key.clone(),
            new_value: proposal.new_value.clone(),
            eta_ledger: eta,
            cancelled: false,
        };
        write_timelock_entry(&env, &entry);

        proposal.queued = true;
        write_proposal(&env, &proposal);

        env.events()
            .publish((soroban_sdk::symbol_short!("queued"),), (proposal_id, eta));
    }

    /// Cancel a queued proposal. Only callable by guardian or admin.
    pub fn cancel_proposal(env: Env, proposal_id: u64) {
        extend_instance(&env);

        // Must be guardian or admin
        let caller_is_guardian = read_guardian(&env)
            .map(|g| {
                g.require_auth();
                true
            })
            .unwrap_or(false);

        if !caller_is_guardian {
            let admin = read_admin(&env);
            admin.require_auth();
        }

        let mut entry =
            read_timelock_entry(&env, proposal_id).expect("no timelock entry for proposal");

        assert!(!entry.cancelled, "already cancelled");

        let proposal = read_proposal(&env, proposal_id);
        assert!(!proposal.executed, "already executed");

        entry.cancelled = true;
        write_timelock_entry(&env, &entry);

        env.events()
            .publish((soroban_sdk::symbol_short!("cancelled"),), proposal_id);
    }

    /// Execute a queued proposal after its timelock has elapsed. Anyone can call.
    pub fn execute_queued(env: Env, proposal_id: u64) {
        extend_instance(&env);
        extend_proposal(&env, proposal_id);

        let entry = read_timelock_entry(&env, proposal_id).expect("no timelock entry for proposal");

        assert!(!entry.cancelled, "proposal was cancelled");

        let current_ledger = env.ledger().sequence();
        assert!(current_ledger >= entry.eta_ledger, "timelock not elapsed");

        let mut proposal = read_proposal(&env, proposal_id);
        assert!(!proposal.executed, "proposal already executed");

        // Write the approved parameter on-chain
        let param_key = DataKey::Param(entry.param_key.clone());
        env.storage().persistent().set(&param_key, &entry.new_value);
        env.storage().persistent().extend_ttl(
            &param_key,
            PROPOSAL_LIFETIME_THRESHOLD,
            PROPOSAL_BUMP_AMOUNT,
        );

        proposal.executed = true;
        write_proposal(&env, &proposal);

        env.events().publish(
            (soroban_sdk::symbol_short!("executed"),),
            (proposal_id, entry.param_key, entry.new_value),
        );
    }

    /// Legacy direct execute (kept for backward compat — skips timelock, admin only).
    pub fn execute_proposal(env: Env, proposal_id: u64) {
        extend_instance(&env);
        extend_proposal(&env, proposal_id);

        // Only admin can bypass timelock
        let admin = read_admin(&env);
        admin.require_auth();

        let mut proposal = read_proposal(&env, proposal_id);

        assert!(!proposal.executed, "proposal already executed");

        let current_ledger = env.ledger().sequence();
        assert!(
            current_ledger > proposal.end_ledger,
            "voting period not ended"
        );

        let total_votes = proposal.votes_for + proposal.votes_against;
        assert!(total_votes > 0, "no votes cast");

        let quorum_bps = read_quorum_bps(&env);
        let reference_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ReferenceSupply)
            .unwrap_or(0);

        if reference_supply > 0 {
            let min_votes_required = reference_supply * quorum_bps / BPS_DENOMINATOR;
            assert!(total_votes >= min_votes_required, "quorum not met");
        }

        assert!(
            proposal.votes_for > proposal.votes_against,
            "proposal did not pass"
        );

        let param_key = DataKey::Param(proposal.param_key.clone());
        env.storage()
            .persistent()
            .set(&param_key, &proposal.new_value);
        env.storage().persistent().extend_ttl(
            &param_key,
            PROPOSAL_LIFETIME_THRESHOLD,
            PROPOSAL_BUMP_AMOUNT,
        );

        proposal.executed = true;
        write_proposal(&env, &proposal);

        env.events().publish(
            (soroban_sdk::symbol_short!("executed"),),
            (proposal_id, proposal.param_key, proposal.new_value),
        );
    }

    // --- Views ---

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

    /// Read an approved governance parameter value.
    pub fn get_param(env: Env, key: String) -> String {
        extend_instance(&env);
        let param_key = DataKey::Param(key);
        let val: String = env
            .storage()
            .persistent()
            .get(&param_key)
            .unwrap_or(String::from_str(&env, ""));
        // Extend TTL if it exists
        if env.storage().persistent().has(&param_key) {
            env.storage().persistent().extend_ttl(
                &param_key,
                PROPOSAL_LIFETIME_THRESHOLD,
                PROPOSAL_BUMP_AMOUNT,
            );
        }
        val
    }

    /// Get the timelock entry for a queued proposal.
    pub fn get_timelock_entry(env: Env, proposal_id: u64) -> TimelockEntry {
        extend_instance(&env);
        read_timelock_entry(&env, proposal_id).expect("no timelock entry")
    }

    /// Get the configured timelock delay in ledgers.
    pub fn get_timelock_delay(env: Env) -> u32 {
        extend_instance(&env);
        read_timelock_delay(&env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token::StellarAssetClient, Env, String};

    fn setup_test() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let sxlm_id = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let contract_id = env.register_contract(None, GovernanceContract);

        let client = GovernanceContractClient::new(&env, &contract_id);
        client.initialize(&admin, &sxlm_id, &100, &1000, &34560); // 100 ledgers voting, 10% quorum, ~48hr delay

        let sxlm_admin = StellarAssetClient::new(&env, &sxlm_id);
        sxlm_admin.mint(&proposer, &10_000_0000000);
        sxlm_admin.mint(&voter, &5_000_0000000);

        (env, contract_id, sxlm_id, proposer, voter)
    }

    #[test]
    fn test_initialize() {
        let (env, contract_id, _, _, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);
        assert_eq!(client.proposal_count(), 0);
        assert_eq!(client.get_timelock_delay(), DEFAULT_TIMELOCK_DELAY);
    }

    #[test]
    fn test_create_proposal() {
        let (env, contract_id, _, proposer, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        let id = client.create_proposal(
            &proposer,
            &String::from_str(&env, "protocol_fee_bps"),
            &String::from_str(&env, "500"),
        );
        assert_eq!(id, 0);
        assert_eq!(client.proposal_count(), 1);

        let p = client.get_proposal(&0);
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
        assert!(!p.executed);
        assert!(!p.queued);
    }

    #[test]
    fn test_vote() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "protocol_fee_bps"),
            &String::from_str(&env, "500"),
        );
        client.vote(&voter, &0, &true);

        let (votes_for, votes_against) = client.get_vote_count(&0);
        assert_eq!(votes_for, 5_000_0000000);
        assert_eq!(votes_against, 0);
    }

    #[test]
    #[should_panic(expected = "already voted")]
    fn test_double_vote() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "protocol_fee_bps"),
            &String::from_str(&env, "500"),
        );
        client.vote(&voter, &0, &true);
        client.vote(&voter, &0, &false);
    }

    #[test]
    fn test_queue_and_execute_queued() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        // Use a short timelock delay for testing
        client.set_timelock_delay(&10);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "collateral_factor"),
            &String::from_str(&env, "7500"),
        );
        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        // Advance past voting period
        env.ledger().with_mut(|li| {
            li.sequence_number += 101;
        });

        client.queue_proposal(&0);

        let p = client.get_proposal(&0);
        assert!(p.queued);
        assert!(!p.executed);

        let entry = client.get_timelock_entry(&0);
        assert!(!entry.cancelled);
        // eta = current_ledger (101) + delay (10) = 111
        assert_eq!(entry.eta_ledger, 111);

        // Advance past timelock
        env.ledger().with_mut(|li| {
            li.sequence_number += 11;
        });

        client.execute_queued(&0);

        let p = client.get_proposal(&0);
        assert!(p.executed);

        let value = client.get_param(&String::from_str(&env, "collateral_factor"));
        assert_eq!(value, String::from_str(&env, "7500"));
    }

    #[test]
    #[should_panic(expected = "timelock not elapsed")]
    fn test_execute_queued_too_early() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);
        client.set_timelock_delay(&500);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "fee"),
            &String::from_str(&env, "100"),
        );
        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        env.ledger().with_mut(|li| {
            li.sequence_number += 101;
        });
        client.queue_proposal(&0);

        // Don't advance past timelock
        client.execute_queued(&0);
    }

    #[test]
    fn test_guardian_cancel() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);
        client.set_timelock_delay(&500);

        let guardian = Address::generate(&env);
        client.set_guardian(&guardian);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "fee"),
            &String::from_str(&env, "100"),
        );
        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        env.ledger().with_mut(|li| {
            li.sequence_number += 101;
        });
        client.queue_proposal(&0);

        client.cancel_proposal(&0);

        let entry = client.get_timelock_entry(&0);
        assert!(entry.cancelled);
    }

    #[test]
    #[should_panic(expected = "proposal was cancelled")]
    fn test_execute_cancelled_proposal() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);
        client.set_timelock_delay(&10);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "fee"),
            &String::from_str(&env, "100"),
        );
        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        env.ledger().with_mut(|li| {
            li.sequence_number += 101;
        });
        client.queue_proposal(&0);
        client.cancel_proposal(&0);

        env.ledger().with_mut(|li| {
            li.sequence_number += 20;
        });
        client.execute_queued(&0);
    }

    #[test]
    #[should_panic(expected = "proposal did not pass")]
    fn test_queue_failed_proposal() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "fee"),
            &String::from_str(&env, "100"),
        );
        client.vote(&proposer, &0, &false); // 10k against
        client.vote(&voter, &0, &true); // 5k for

        env.ledger().with_mut(|li| {
            li.sequence_number += 101;
        });
        client.queue_proposal(&0);
    }

    #[test]
    fn test_vote_against() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "fee"),
            &String::from_str(&env, "100"),
        );
        client.vote(&voter, &0, &false);

        let (votes_for, votes_against) = client.get_vote_count(&0);
        assert_eq!(votes_for, 0);
        assert_eq!(votes_against, 5_000_0000000);
    }

    #[test]
    fn test_get_param_default() {
        let (env, contract_id, _, _, _) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);
        let val = client.get_param(&String::from_str(&env, "nonexistent"));
        assert_eq!(val, String::from_str(&env, ""));
    }

    #[test]
    fn test_execute_proposal_legacy_admin_bypass() {
        let (env, contract_id, _, proposer, voter) = setup_test();
        let client = GovernanceContractClient::new(&env, &contract_id);

        client.create_proposal(
            &proposer,
            &String::from_str(&env, "collateral_factor"),
            &String::from_str(&env, "7500"),
        );
        client.vote(&proposer, &0, &true);
        client.vote(&voter, &0, &true);

        env.ledger().with_mut(|li| {
            li.sequence_number += 101;
        });

        client.execute_proposal(&0);

        let p = client.get_proposal(&0);
        assert!(p.executed);
        let value = client.get_param(&String::from_str(&env, "collateral_factor"));
        assert_eq!(value, String::from_str(&env, "7500"));
    }
}

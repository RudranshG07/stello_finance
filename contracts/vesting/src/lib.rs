#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, Vec};

// ---------- TTL constants (~5 s/ledger on Stellar) ----------
const INSTANCE_LIFETIME_THRESHOLD: u32 = 100_800; // ~7 days — extend if below
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // bump to ~30 days
const SCHEDULE_LIFETIME_THRESHOLD: u32 = 518_400; // ~30 days
const SCHEDULE_BUMP_AMOUNT: u32 = 3_110_400; // bump to ~180 days

// ---------- Storage keys ----------

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Initialized,
    ScheduleCount,
    Schedule(u64),
    /// Vec<u64> of schedule IDs owned by this beneficiary.
    BeneficiarySchedules(Address),
}

// ---------- Data types ----------

/// A linear vesting schedule with an optional cliff.
///
/// Timeline:
///   start_ledger ─── cliff_ledger ─── end_ledger
///
/// • Before cliff_ledger : 0 tokens vested (cliff blocks claims)
/// • cliff_ledger..end_ledger : linear unlock proportional to elapsed ledgers
///   from start_ledger (so cliff grants an instant "catch-up" chunk)
/// • After end_ledger : 100% vested
///
/// If `revocable` is true, admin can call `revoke()` at any time:
///   – unvested tokens are returned to admin
///   – beneficiary can still claim any already-vested-but-unclaimed tokens
#[derive(Clone)]
#[contracttype]
pub struct VestingSchedule {
    pub id: u64,
    pub beneficiary: Address,
    /// The token being vested (sXLM contract address or native XLM SAC).
    pub token: Address,
    /// Total tokens locked into this schedule (in stroops / smallest unit).
    pub total_amount: i128,
    /// Ledger at which the linear unlock calculation begins (may be in future).
    pub start_ledger: u32,
    /// Earliest ledger at which any tokens can be claimed.
    pub cliff_ledger: u32,
    /// Ledger at which 100% of tokens are vested.
    pub end_ledger: u32,
    /// Tokens already claimed by beneficiary.
    pub claimed: i128,
    /// Whether admin can revoke unvested tokens.
    pub revocable: bool,
    /// Set to true after `revoke()` is called.
    pub revoked: bool,
    /// Vested amount captured at revocation time; 0 while schedule is active.
    /// After revoke, beneficiary can claim up to this amount (minus `claimed`).
    pub vested_at_revoke: i128,
}

// ---------- Storage helpers ----------

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn next_schedule_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::ScheduleCount)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::ScheduleCount, &(id + 1));
    id
}

fn read_schedule(env: &Env, id: u64) -> VestingSchedule {
    let key = DataKey::Schedule(id);
    let schedule: VestingSchedule = env
        .storage()
        .persistent()
        .get(&key)
        .expect("schedule not found");
    env.storage()
        .persistent()
        .extend_ttl(&key, SCHEDULE_LIFETIME_THRESHOLD, SCHEDULE_BUMP_AMOUNT);
    schedule
}

fn write_schedule(env: &Env, schedule: &VestingSchedule) {
    let key = DataKey::Schedule(schedule.id);
    env.storage().persistent().set(&key, schedule);
    env.storage()
        .persistent()
        .extend_ttl(&key, SCHEDULE_LIFETIME_THRESHOLD, SCHEDULE_BUMP_AMOUNT);
}

fn append_beneficiary_schedule(env: &Env, beneficiary: &Address, schedule_id: u64) {
    let key = DataKey::BeneficiarySchedules(beneficiary.clone());
    let mut list: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    list.push_back(schedule_id);
    env.storage().persistent().set(&key, &list);
    env.storage()
        .persistent()
        .extend_ttl(&key, SCHEDULE_LIFETIME_THRESHOLD, SCHEDULE_BUMP_AMOUNT);
}

fn read_beneficiary_schedule_ids(env: &Env, beneficiary: &Address) -> Vec<u64> {
    let key = DataKey::BeneficiarySchedules(beneficiary.clone());
    let list: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    if !list.is_empty() {
        env.storage()
            .persistent()
            .extend_ttl(&key, SCHEDULE_LIFETIME_THRESHOLD, SCHEDULE_BUMP_AMOUNT);
    }
    list
}

// ---------- Pure vesting math ----------

/// Compute how many tokens are fully vested at `current_ledger`.
/// Does NOT subtract `claimed` — callers do that themselves.
fn compute_vested(schedule: &VestingSchedule, current_ledger: u32) -> i128 {
    // Cliff not yet reached → nothing vested
    if current_ledger < schedule.cliff_ledger {
        return 0;
    }

    // Past end → fully vested
    if current_ledger >= schedule.end_ledger {
        return schedule.total_amount;
    }

    // Linear interpolation from start_ledger to end_ledger
    let elapsed = (current_ledger - schedule.start_ledger) as i128;
    let duration = (schedule.end_ledger - schedule.start_ledger) as i128;

    if duration == 0 {
        return schedule.total_amount;
    }

    schedule.total_amount * elapsed / duration
}

// ---------- Contract ----------

#[contract]
pub struct VestingContract;

#[contractimpl]
impl VestingContract {
    // ======================================================
    // Admin / lifecycle
    // ======================================================

    /// Initialize the vesting contract. Can only be called once.
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
        env.storage().instance().set(&DataKey::ScheduleCount, &0u64);
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

    // ======================================================
    // Core: create / claim / revoke
    // ======================================================

    /// Create a new vesting schedule.
    ///
    /// Admin must have approved this contract to transfer `total_amount` of
    /// `token` (i.e. called `token.approve(vesting_contract, amount)` first),
    /// or simply transfer the tokens to this contract beforehand.
    ///
    /// Returns the new schedule ID.
    ///
    /// Constraints:
    ///   start_ledger ≤ cliff_ledger < end_ledger
    pub fn create_schedule(
        env: Env,
        caller: Address,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_ledger: u32,
        cliff_ledger: u32,
        end_ledger: u32,
        revocable: bool,
    ) -> u64 {
        caller.require_auth();

        if total_amount <= 0 {
            panic!("total_amount must be positive");
        }
        if cliff_ledger < start_ledger {
            panic!("cliff_ledger must be >= start_ledger");
        }
        if end_ledger <= cliff_ledger {
            panic!("end_ledger must be > cliff_ledger");
        }

        extend_instance(&env);

        // Pull tokens from caller into this contract.
        // Caller needs sufficient balance and the transfer must succeed.
        token::Client::new(&env, &token).transfer(
            &caller,
            &env.current_contract_address(),
            &total_amount,
        );

        let id = next_schedule_id(&env);

        let schedule = VestingSchedule {
            id,
            beneficiary: beneficiary.clone(),
            token,
            total_amount,
            start_ledger,
            cliff_ledger,
            end_ledger,
            claimed: 0,
            revocable,
            revoked: false,
            vested_at_revoke: 0,
        };

        write_schedule(&env, &schedule);
        append_beneficiary_schedule(&env, &beneficiary, id);

        env.events().publish(
            (soroban_sdk::symbol_short!("vst_new"),),
            (id, beneficiary, total_amount, start_ledger, end_ledger),
        );

        id
    }

    /// Claim vested tokens for a given schedule.
    /// Only the beneficiary may call this.
    /// Returns the amount transferred.
    pub fn claim(env: Env, beneficiary: Address, schedule_id: u64) -> i128 {
        beneficiary.require_auth();
        extend_instance(&env);

        let mut schedule = read_schedule(&env, schedule_id);

        if schedule.beneficiary != beneficiary {
            panic!("not your schedule");
        }

        // After revocation, beneficiary may still claim vested_at_revoke - claimed
        let effective_vested = if schedule.revoked {
            schedule.vested_at_revoke
        } else {
            compute_vested(&schedule, env.ledger().sequence())
        };

        let claimable = effective_vested - schedule.claimed;
        if claimable <= 0 {
            panic!("nothing to claim yet");
        }

        schedule.claimed += claimable;
        write_schedule(&env, &schedule);

        token::Client::new(&env, &schedule.token).transfer(
            &env.current_contract_address(),
            &beneficiary,
            &claimable,
        );

        env.events().publish(
            (soroban_sdk::symbol_short!("vst_clm"),),
            (schedule_id, beneficiary, claimable),
        );

        claimable
    }

    /// Revoke a revocable schedule. Only admin may call.
    ///
    /// Immediately transfers the unvested portion back to admin.
    /// The beneficiary can still claim any already-vested-but-unclaimed tokens.
    pub fn revoke(env: Env, admin: Address, schedule_id: u64) {
        admin.require_auth();

        let stored_admin = read_admin(&env);
        if admin != stored_admin {
            panic!("only admin can revoke");
        }

        extend_instance(&env);

        let mut schedule = read_schedule(&env, schedule_id);

        if !schedule.revocable {
            panic!("schedule is not revocable");
        }
        if schedule.revoked {
            panic!("schedule already revoked");
        }

        let current_ledger = env.ledger().sequence();
        let vested_now = compute_vested(&schedule, current_ledger);
        let unvested = schedule.total_amount - vested_now;

        // Snapshot the vested amount so beneficiary can still claim it
        schedule.revoked = true;
        schedule.vested_at_revoke = vested_now;
        write_schedule(&env, &schedule);

        // Return unvested tokens to admin
        if unvested > 0 {
            token::Client::new(&env, &schedule.token).transfer(
                &env.current_contract_address(),
                &admin,
                &unvested,
            );
        }

        env.events().publish(
            (soroban_sdk::symbol_short!("vst_rev"),),
            (schedule_id, vested_now, unvested),
        );
    }

    // ======================================================
    // View functions
    // ======================================================

    /// Returns how many tokens the beneficiary can claim right now.
    pub fn get_claimable(env: Env, schedule_id: u64) -> i128 {
        extend_instance(&env);
        let schedule = read_schedule(&env, schedule_id);

        let effective_vested = if schedule.revoked {
            schedule.vested_at_revoke
        } else {
            compute_vested(&schedule, env.ledger().sequence())
        };

        let claimable = effective_vested - schedule.claimed;
        if claimable < 0 {
            0
        } else {
            claimable
        }
    }

    /// Returns the full vesting schedule struct.
    pub fn get_schedule(env: Env, schedule_id: u64) -> VestingSchedule {
        extend_instance(&env);
        read_schedule(&env, schedule_id)
    }

    /// Returns all schedule IDs where `beneficiary` is the recipient.
    pub fn get_schedules(env: Env, beneficiary: Address) -> Vec<u64> {
        extend_instance(&env);
        read_beneficiary_schedule_ids(&env, &beneficiary)
    }

    /// Returns total number of schedules ever created.
    pub fn schedule_count(env: Env) -> u64 {
        extend_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::ScheduleCount)
            .unwrap_or(0)
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    fn setup() -> (Env, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        // Deploy a mock token
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let token_address = token_id.address();

        // Mint 10_000 tokens to admin
        StellarAssetClient::new(&env, &token_address).mint(&admin, &10_000_0000000);

        // Deploy vesting contract
        let vesting_id = env.register(VestingContract, ());
        let vesting_address = vesting_id.address();

        // Approve vesting contract to pull tokens from admin (or admin will transfer directly)

        (env, admin, beneficiary, token_address, vesting_address)
    }

    #[test]
    fn test_initialize() {
        let (env, admin, _, _, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        assert_eq!(vesting.schedule_count(), 0);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_initialize_panics() {
        let (env, admin, _, _, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);
        vesting.initialize(&admin);
    }

    #[test]
    fn test_create_schedule_basic() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let ledger_now = env.ledger().sequence();
        let id = vesting.create_schedule(
            &admin,
            &beneficiary,
            &token,
            &1_000_0000000,
            &ledger_now,
            &(ledger_now + 100),  // cliff after 100 ledgers
            &(ledger_now + 1_000), // fully vested after 1000 ledgers
            &true,
        );

        assert_eq!(id, 0);
        assert_eq!(vesting.schedule_count(), 1);

        let schedule = vesting.get_schedule(&id);
        assert_eq!(schedule.total_amount, 1_000_0000000);
        assert_eq!(schedule.claimed, 0);
        assert!(!schedule.revoked);
    }

    #[test]
    fn test_cliff_blocks_early_claim() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let ledger_now = env.ledger().sequence();
        let id = vesting.create_schedule(
            &admin,
            &beneficiary,
            &token,
            &1_000_0000000,
            &ledger_now,
            &(ledger_now + 500), // cliff at ledger 500
            &(ledger_now + 1_000),
            &false,
        );

        // At ledger 0 → below cliff → nothing to claim
        assert_eq!(vesting.get_claimable(&id), 0);
    }

    #[test]
    fn test_cliff_unlocks_at_cliff_ledger() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let start: u32 = 100;
        let cliff: u32 = 600;
        let end: u32 = 1_100;

        env.ledger().with_mut(|li| li.sequence_number = start);

        let id = vesting.create_schedule(
            &admin,
            &beneficiary,
            &token,
            &1_000_0000000,
            &start,
            &cliff,
            &end,
            &false,
        );

        // Jump to cliff ledger
        env.ledger().with_mut(|li| li.sequence_number = cliff);
        let claimable = vesting.get_claimable(&id);
        // elapsed = cliff - start = 500, duration = end - start = 1000
        // vested = 1_000_0000000 * 500/1000 = 500_0000000
        assert_eq!(claimable, 500_0000000);
    }

    #[test]
    fn test_linear_unlock_and_claim() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let start: u32 = 0;
        let cliff: u32 = 0; // no cliff
        let end: u32 = 1_000;

        let id = vesting.create_schedule(
            &admin,
            &beneficiary,
            &token,
            &1_000_0000000,
            &start,
            &cliff,
            &end,
            &false,
        );

        // At ledger 500 → 50% vested
        env.ledger().with_mut(|li| li.sequence_number = 500);
        assert_eq!(vesting.get_claimable(&id), 500_0000000);

        // Claim
        let claimed = vesting.claim(&beneficiary, &id);
        assert_eq!(claimed, 500_0000000);

        // Immediately after — nothing more to claim at same ledger
        assert_eq!(vesting.get_claimable(&id), 0);

        // At end ledger → remaining 50%
        env.ledger().with_mut(|li| li.sequence_number = 1_000);
        assert_eq!(vesting.get_claimable(&id), 500_0000000);
        vesting.claim(&beneficiary, &id);

        // Fully claimed
        assert_eq!(vesting.get_claimable(&id), 0);
        let schedule = vesting.get_schedule(&id);
        assert_eq!(schedule.claimed, 1_000_0000000);
    }

    #[test]
    fn test_full_vest_at_end_ledger() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let start: u32 = 0;
        let end: u32 = 500;

        let id = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000, &start, &start, &end, &false,
        );

        env.ledger().with_mut(|li| li.sequence_number = 999);
        assert_eq!(vesting.get_claimable(&id), 1_000_0000000);
    }

    #[test]
    fn test_revoke_returns_unvested_to_admin() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let token_client = TokenClient::new(&env, &token);
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let start: u32 = 0;
        let end: u32 = 1_000;

        let id = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000, &start, &start, &end, &true,
        );

        // At ledger 200 → 20% vested
        env.ledger().with_mut(|li| li.sequence_number = 200);

        let admin_balance_before = token_client.balance(&admin);
        vesting.revoke(&admin, &id);
        let admin_balance_after = token_client.balance(&admin);

        // Admin got back 80% (unvested)
        assert_eq!(admin_balance_after - admin_balance_before, 800_0000000);

        // Beneficiary can still claim the 20% vested
        assert_eq!(vesting.get_claimable(&id), 200_0000000);
        vesting.claim(&beneficiary, &id);
        assert_eq!(vesting.get_claimable(&id), 0);
    }

    #[test]
    #[should_panic(expected = "schedule is not revocable")]
    fn test_revoke_non_revocable_panics() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let id = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000, &0, &0, &1_000, &false, // revocable = false
        );
        vesting.revoke(&admin, &id);
    }

    #[test]
    #[should_panic(expected = "schedule already revoked")]
    fn test_double_revoke_panics() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let id = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000, &0, &0, &1_000, &true,
        );
        vesting.revoke(&admin, &id);
        vesting.revoke(&admin, &id);
    }

    #[test]
    #[should_panic(expected = "nothing to claim yet")]
    fn test_claim_before_cliff_panics() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let id = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000, &0, &500, &1_000, &false,
        );
        // ledger 0 < cliff 500 → panic
        vesting.claim(&beneficiary, &id);
    }

    #[test]
    #[should_panic(expected = "not your schedule")]
    fn test_claim_wrong_beneficiary_panics() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let id = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000, &0, &0, &1_000, &false,
        );

        let stranger = Address::generate(&env);
        env.ledger().with_mut(|li| li.sequence_number = 500);
        vesting.claim(&stranger, &id);
    }

    #[test]
    fn test_get_schedules_returns_all_ids_for_beneficiary() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        let id0 = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &100_0000000, &0, &0, &100, &false,
        );
        let id1 = vesting.create_schedule(
            &admin, &beneficiary, &token,
            &200_0000000, &0, &0, &200, &true,
        );

        let ids = vesting.get_schedules(&beneficiary);
        assert_eq!(ids.len(), 2);
        assert_eq!(ids.get(0).unwrap(), id0);
        assert_eq!(ids.get(1).unwrap(), id1);
    }

    #[test]
    #[should_panic(expected = "cliff_ledger must be >= start_ledger")]
    fn test_cliff_before_start_panics() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000,
            &100,  // start
            &50,   // cliff < start → panic
            &500,
            &false,
        );
    }

    #[test]
    #[should_panic(expected = "end_ledger must be > cliff_ledger")]
    fn test_end_before_cliff_panics() {
        let (env, admin, beneficiary, token, vesting_address) = setup();
        let vesting = VestingContractClient::new(&env, &vesting_address);
        vesting.initialize(&admin);

        vesting.create_schedule(
            &admin, &beneficiary, &token,
            &1_000_0000000,
            &0,
            &500, // cliff
            &500, // end == cliff → panic
            &false,
        );
    }
}

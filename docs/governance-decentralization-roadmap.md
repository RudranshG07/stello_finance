# Governance Decentralization Roadmap

This repo now supports on-chain governance proposal execution through a dedicated timelock contract.

## Current implementation status

- Governance proposals are created and voted on-chain.
- Passed proposals must be queued into the timelock before execution.
- Timelock execution is permissionless after the delay expires.
- The emergency guardian can cancel queued proposals before execution.
- Staking, lending, and LP pool admin ownership are transferred to the timelock during deployment.
- The backend mirrors proposal lifecycle state into PostgreSQL so proposal reads can fall back to cached data.
- The frontend reads governance metadata from the backend and only exposes guardian cancellation to the configured guardian wallet.
- The keeper can submit ready executions with the governance relayer, but manual execution remains available if the keeper is offline.

## What was implemented

### 1. Timelock execution layer

- Added a dedicated Soroban timelock contract.
- Added configurable `min_delay_ledgers` with a 48h-style default deployment value.
- Added queue, cancel, execute, guardian, and status read methods.
- Restricted scheduling to governance and cancellation to the guardian.

### 2. Governance contract flow

- Extended proposal lifecycle to cover `Active`, `Passed`, `Rejected`, `Queued`, `Cancelled`, and `Executed`.
- Replaced direct parameter execution with `queue_proposal` and timelock-backed `execute_proposal`.
- Stored `queued_ledger` and `eta_ledger` on proposals for backend/frontend visibility.
- Kept proposals single-action and restricted parameter keys to the supported allowlist.

### 3. Governed target contracts

- Staking protocol fee moved from a compile-time constant to instance storage.
- Staking gained a governed `set_protocol_fee_bps`.
- Lending and LP pool admin ownership can now be handed to timelock.
- Supported governed actions now cover:
  - staking fee updates
  - staking cooldown updates
  - lending collateral factor changes
  - lending borrow rate changes
  - lending liquidation threshold changes
  - LP protocol fee changes

### 4. Backend integration

- Removed the admin-side parameter-application path from governance execution.
- Added queue, cancel, execute, proposal, detail, and metadata API support for timelock governance.
- Persisted proposal lifecycle fields in the DB cache:
  - `status`
  - `queuedAt`
  - `etaAt`
  - `cancelledAt`
  - `executedAt`
  - `cancelledBy`
  - ledger and action-readiness fields
- Added cached fallback reads for proposal list/detail endpoints.

### 5. Frontend integration

- Added queue, execute, and guardian-cancel actions to the governance page.
- Added queued and cancelled state rendering.
- Added human-readable timelock ETA and delay display.
- Added guardian-aware button gating based on backend metadata.
- Added cached-data messaging when proposal reads come from the DB mirror instead of live chain reads.

## Phased admin-key deprecation

### Phase 1: Timelock-owned protocol parameters

- `protocol_fee_bps`
- `cooldown_period`
- `collateral_factor`
- `borrow_rate_bps`
- `liquidation_threshold`
- `lp_protocol_fee_bps`

These parameter setters are no longer expected to be applied by an off-chain admin workflow. Governance plus timelock is the normal path.

### Phase 2: Emergency-only guardian role

- The guardian may cancel a queued proposal that appears malicious or unsafe.
- The guardian does not bypass voting and does not execute parameter changes directly.
- Manual execution remains open to any participant once the timelock delay has elapsed.

### Phase 3: Residual admin surface review

The remaining admin-controlled functions should be reviewed and categorized:

- retain as explicit emergency or operational controls
- transfer to governance in a future upgrade
- remove if redundant

This review should include deployment ownership, upgrade authority, and any maintenance-only setters that still depend on the legacy admin key.

## Operational expectations

- If the keeper is online, it will submit ready governance executions using the governance relayer.
- If the keeper is offline, any user may still execute a queued proposal manually after the timelock expires.
- Backend proposal reads may fall back to the last synced DB cache if live chain reads fail.
- State-changing governance actions still require fresh on-chain validation before a transaction is built.

## Remaining rollout work

- Run the latest Prisma migrations in the deployed backend environment.
- Deploy the updated timelock/governance-aware contract set and publish the resulting contract IDs.
- Set `GOVERNANCE_RELAYER_SECRET_KEY`, `GOVERNANCE_GUARDIAN_ADDRESS`, and `TIMELOCK_CONTRACT_ID` in deployed backend/frontend environments.
- Confirm on-chain admin ownership for staking, lending, and LP pool now points to the timelock after deployment.

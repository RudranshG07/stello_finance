/**
 * Types for the Hubble/Galexie-compatible Soroban event indexer.
 *
 * The indexer consumes Soroban contract events via the RPC `getEvents` method
 * (the same stream that Stellar's Hubble/Galexie pipeline exposes) and persists
 * deduped rows to Postgres.
 */

// ─── Raw RPC types ──────────────────────────────────────────────────────────

export interface RawSorobanEvent {
  /** Event type — always "contract" for Soroban events. */
  type: string;
  ledger: number;
  /** ISO-8601 timestamp when the ledger closed. */
  ledgerClosedAt: string;
  contractId: string;
  /**
   * Compound event ID: "0{ledger:10d}{txIndex:10d}{eventIndex:10d}" (31 chars).
   * Used for pagination cursors and extracting the per-tx event index.
   */
  id: string;
  paginationToken: string;
  /** Base64-encoded XDR ScVal topics. */
  topic: string[];
  /** Base64-encoded XDR ScVal value (may be wrapped in an object). */
  value: { xdr: string } | string;
  txHash: string;
  inSuccessfulContractCall: boolean;
}

export interface GetEventsResponse {
  result?: {
    events: RawSorobanEvent[];
    latestLedger: number;
    /** Cursor to use for the next page. */
    cursor?: string;
  };
  error?: { code: number; message: string };
}

// ─── Parsed / decoded event types ───────────────────────────────────────────

export interface ParsedEventBase {
  txHash: string;
  eventIndex: number;
  contractId: string;
  ledger: number;
  ledgerClosedAt: Date;
}

export interface ParsedStakeEvent extends ParsedEventBase {
  kind: "stake";
  wallet: string;
  amount: bigint;
  eventType: "STAKE" | "UNSTAKE";
}

export interface ParsedBorrowEvent extends ParsedEventBase {
  kind: "borrow";
  wallet: string;
  amount: bigint;
  asset: string;
}

export interface ParsedRepayEvent extends ParsedEventBase {
  kind: "repay";
  wallet: string;
  amount: bigint;
  asset: string;
}

export interface ParsedFlashLoanEvent extends ParsedEventBase {
  kind: "flash_loan";
  wallet: string;
  amount: bigint;
  asset: string;
  fee: bigint;
}

export interface ParsedLiquidationEvent extends ParsedEventBase {
  kind: "liquidation";
  liquidator: string;
  borrower: string;
  debtRepaid: bigint;
  collateralSeized: bigint;
}

export type ParsedEvent =
  | ParsedStakeEvent
  | ParsedBorrowEvent
  | ParsedRepayEvent
  | ParsedFlashLoanEvent
  | ParsedLiquidationEvent;

// ─── Indexer state ───────────────────────────────────────────────────────────

export interface ContractCursor {
  contractId: string;
  lastLedger: number;
}

export interface IndexerState {
  /** Per-contract ledger cursors loaded from Postgres. */
  cursors: Map<string, number>;
  /** Whether the initial backfill pass has completed. */
  backfillComplete: boolean;
}

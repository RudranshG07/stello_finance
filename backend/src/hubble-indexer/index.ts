/**
 * HubbleIndexer — Soroban contract event backfill + live sync worker.
 *
 * Architecture
 * ────────────
 * 1. On startup, reads per-contract ledger cursors from the `indexer_cursors`
 *    Postgres table.
 * 2. Runs a backfill pass: pages through `getEvents` from the earliest known
 *    cursor up to the chain tip, writing deduped rows into event tables.
 * 3. After backfill completes, switches to live-polling mode (every
 *    LIVE_POLL_INTERVAL_MS), continuing from the latest ledger.
 * 4. Cursor state is flushed to Postgres after every batch so the worker can
 *    resume safely after a restart.
 *
 * Deduplication
 * ─────────────
 * Every event write uses `createMany({ skipDuplicates: true })` which relies
 * on the `@@unique([txHash, eventIndex])` constraints in schema.prisma.
 *
 * Reliability
 * ───────────
 * - Individual RPC fetches are retried up to MAX_RETRIES times with
 *   exponential back-off before propagating an error.
 * - A configurable inter-page delay (BACKFILL_BATCH_DELAY_MS) prevents the
 *   backfill loop from overwhelming the RPC endpoint.
 * - A simple token-bucket rate limiter caps concurrent RPC calls per second
 *   to avoid 429 responses from shared or public RPC nodes.
 * - Cursors are flushed to Postgres every CURSOR_FLUSH_EVERY_N_PAGES pages
 *   during backfill, so a crash mid-backfill only replays the last N pages.
 *
 * Relation to the legacy EventListenerService
 * ────────────────────────────────────────────
 * The legacy service (`event-listener/index.ts`) continues to run alongside
 * this indexer for business-logic side-effects (event bus, withdrawal queue).
 * This indexer exclusively owns the analytics event tables.
 */

import { PrismaClient } from "@prisma/client";
import { config } from "../config/index.js";
import { parseEvent, persistEvents } from "./processor.js";
import type { GetEventsResponse, RawSorobanEvent } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of events the RPC returns per page. */
const PAGE_LIMIT = 200;

/** Milliseconds between live-poll ticks. */
const LIVE_POLL_INTERVAL_MS = 10_000;

/** Base milliseconds to wait before a retry or after an error. */
const RETRY_DELAY_BASE_MS = 2_000;

/** Maximum number of consecutive live-poll errors before giving up the loop. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Maximum number of retries for a single RPC fetch call. */
const MAX_RETRIES = 3;

/**
 * Minimum delay between consecutive RPC pages during backfill (ms).
 * Keeps the indexer from rate-limiting shared/public RPC nodes.
 */
const BACKFILL_BATCH_DELAY_MS = 150;

/**
 * Flush cursors to Postgres every N backfill pages so that a crash mid-backfill
 * only needs to replay at most N pages worth of events.
 */
const CURSOR_FLUSH_EVERY_N_PAGES = 10;

/**
 * Maximum RPC calls allowed per second (token-bucket rate limiter).
 * Set conservatively to avoid 429s on public Soroban RPC nodes.
 */
const RPC_MAX_CALLS_PER_SECOND = 4;

/** All contract IDs monitored by this indexer. */
const CONTRACT_IDS = [
  config.contracts.stakingContractId,
  config.contracts.lendingContractId,
  config.contracts.lpPoolContractId,
  config.contracts.governanceContractId,
  config.contracts.sxlmTokenContractId,
].filter(Boolean);

// ─── Simple token-bucket rate limiter ────────────────────────────────────────

/**
 * A lightweight token-bucket that limits how many times `acquire()` can
 * resolve per second.  Each call to `acquire()` waits until a token is
 * available before resolving.
 */
class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private lastRefillMs: number;
  private queue: Array<() => void> = [];

  constructor(callsPerSecond: number) {
    this.maxTokens = callsPerSecond;
    this.tokens = callsPerSecond;
    this.lastRefillMs = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // No token available — queue the caller and wait.
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillMs) / 1_000;
    const added = elapsed * this.maxTokens;
    this.tokens = Math.min(this.maxTokens, this.tokens + added);
    this.lastRefillMs = now;

    // Drain the queue as tokens become available.
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
  }
}

// ─── HubbleIndexer ───────────────────────────────────────────────────────────

export class HubbleIndexer {
  private prisma: PrismaClient;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** Highest ledger observed across all contracts during the current run. */
  private globalLastLedger = 0;

  /** Per-contract ledger cursor (contract ID → last fully-processed ledger). */
  private cursors: Map<string, number> = new Map();

  private consecutiveErrors = 0;

  private readonly rateLimiter = new RateLimiter(RPC_MAX_CALLS_PER_SECOND);

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    console.log("[HubbleIndexer] Initializing...");
    await this.loadCursors();
    this.running = true;

    // Run backfill asynchronously so initialize() returns promptly.
    this.runBackfillThenLive().catch((err) => {
      console.error("[HubbleIndexer] Fatal error in indexer loop:", err);
    });

    console.log("[HubbleIndexer] Started (backfill running in background)");
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("[HubbleIndexer] Shut down");
  }

  // ─── Cursor management ──────────────────────────────────────────────────────

  private async loadCursors(): Promise<void> {
    const rows = await this.prisma.indexerCursor.findMany();
    for (const row of rows) {
      this.cursors.set(row.contractId, row.lastLedger);
    }

    this.globalLastLedger = rows.reduce(
      (max, r) => Math.max(max, r.lastLedger),
      0
    );

    console.log(
      `[HubbleIndexer] Loaded ${rows.length} cursors, ` +
        `globalLastLedger=${this.globalLastLedger}`
    );
  }

  /**
   * Persist the current per-contract cursor values to Postgres.
   * Uses upsert so the first run also creates the rows.
   */
  private async flushCursors(): Promise<void> {
    const ops = Array.from(this.cursors.entries()).map(
      ([contractId, lastLedger]) =>
        this.prisma.indexerCursor.upsert({
          where: { contractId },
          create: { contractId, lastLedger },
          update: { lastLedger },
        })
    );
    await Promise.all(ops);
  }

  // ─── Retry helper ────────────────────────────────────────────────────────────

  /**
   * Run `fn` up to MAX_RETRIES times with exponential back-off.
   * Throws the last error if all attempts fail.
   */
  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1);
          console.warn(
            `[HubbleIndexer] ${label} failed (attempt ${attempt}/${MAX_RETRIES}), ` +
              `retrying in ${delay}ms:`,
            err
          );
          await sleep(delay);
        }
      }
    }
    throw lastErr;
  }

  // ─── Core indexing logic ────────────────────────────────────────────────────

  private async runBackfillThenLive(): Promise<void> {
    // ── Backfill ──────────────────────────────────────────────────────────────
    const startLedger = this.globalLastLedger > 0 ? this.globalLastLedger : 1;
    console.log(
      `[HubbleIndexer] Starting backfill from ledger ${startLedger}`
    );
    await this.indexFromLedger(startLedger, true);
    console.log("[HubbleIndexer] Backfill complete, switching to live mode");

    // ── Live polling ──────────────────────────────────────────────────────────
    if (this.running) {
      this.scheduleLivePoll();
    }
  }

  private scheduleLivePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      try {
        const ledger = this.globalLastLedger > 0 ? this.globalLastLedger : 1;
        await this.indexFromLedger(ledger, false);
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors++;
        const delay =
          RETRY_DELAY_BASE_MS *
          Math.min(Math.pow(2, this.consecutiveErrors - 1), 32);
        console.error(
          `[HubbleIndexer] Live poll error (attempt ${this.consecutiveErrors}), ` +
            `retrying in ${delay}ms:`,
          err
        );
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(
            `[HubbleIndexer] ${MAX_CONSECUTIVE_ERRORS} consecutive errors — ` +
              `backing off for ${delay}ms before retrying`
          );
        }
        await sleep(delay);
      } finally {
        if (this.running) {
          this.pollTimer = setTimeout(
            () => this.scheduleLivePoll(),
            LIVE_POLL_INTERVAL_MS
          );
        }
      }
    }, LIVE_POLL_INTERVAL_MS);
  }

  /**
   * Fetch and persist all events starting from `startLedger` (inclusive),
   * paginating until the chain tip.
   *
   * @param startLedger - First ledger to fetch (used on the first page only).
   * @param isBackfill  - When true, adds inter-page delay and flushes cursors
   *                      every CURSOR_FLUSH_EVERY_N_PAGES pages.
   */
  private async indexFromLedger(
    startLedger?: number,
    isBackfill = false
  ): Promise<void> {
    let cursor: string | undefined;
    let isFirstPage = true;
    let pageCount = 0;
    let totalEvents = 0;

    while (this.running) {
      const response = await this.withRetry(
        () =>
          this.fetchEventPage(
            isFirstPage ? startLedger : undefined,
            isFirstPage ? undefined : cursor
          ),
        `fetchEventPage(ledger=${startLedger}, cursor=${cursor})`
      );

      if (!response.result) {
        if (response.error) {
          throw new Error(
            `[HubbleIndexer] RPC error ${response.error.code}: ${response.error.message}`
          );
        }
        break;
      }

      const { events, latestLedger, cursor: nextCursor } = response.result;

      if (events.length > 0) {
        await this.processBatch(events);
        totalEvents += events.length;
      }

      // Advance global cursor to the chain tip even if there were no events.
      if (latestLedger > this.globalLastLedger) {
        this.globalLastLedger = latestLedger;
      }

      pageCount++;
      isFirstPage = false;

      // Periodic mid-backfill cursor flush to minimise replay on crash.
      if (isBackfill && pageCount % CURSOR_FLUSH_EVERY_N_PAGES === 0) {
        await this.flushCursors();
        console.log(
          `[HubbleIndexer] Backfill checkpoint: page ${pageCount}, ` +
            `${totalEvents} events indexed, ledger ${this.globalLastLedger}`
        );
      }

      // No more pages or we've caught up to the tip.
      if (!nextCursor || events.length < PAGE_LIMIT) {
        break;
      }

      cursor = nextCursor;

      // Rate-controlled inter-page delay during backfill.
      if (isBackfill) {
        await sleep(BACKFILL_BATCH_DELAY_MS);
      }
    }

    if (isBackfill && totalEvents > 0) {
      console.log(
        `[HubbleIndexer] Backfill finished: ${pageCount} pages, ` +
          `${totalEvents} events, ledger ${this.globalLastLedger}`
      );
    }

    // Ensure contracts with no events yet still have a cursor row.
    for (const id of CONTRACT_IDS) {
      if (!this.cursors.has(id)) {
        this.cursors.set(id, this.globalLastLedger);
      }
    }

    await this.flushCursors();
  }

  // ─── Batch processing ───────────────────────────────────────────────────────

  private async processBatch(events: RawSorobanEvent[]): Promise<void> {
    const parsed = events
      .filter((e) => e.inSuccessfulContractCall !== false)
      .map(parseEvent)
      .filter((e): e is NonNullable<typeof e> => e !== null);

    if (parsed.length > 0) {
      await persistEvents(this.prisma, parsed);

      console.log(
        `[HubbleIndexer] Persisted ${parsed.length}/${events.length} events ` +
          `(ledgers ${events[0]?.ledger}–${events[events.length - 1]?.ledger})`
      );
    }

    // Update per-contract cursors.
    for (const event of events) {
      const prev = this.cursors.get(event.contractId) ?? 0;
      if (event.ledger > prev) {
        this.cursors.set(event.contractId, event.ledger);
      }
      if (event.ledger > this.globalLastLedger) {
        this.globalLastLedger = event.ledger;
      }
    }
  }

  // ─── RPC fetch ───────────────────────────────────────────────────────────────

  /**
   * Fetch a page of Soroban contract events from the RPC.
   * Acquires a rate-limiter token before making the network call.
   *
   * @param startLedger - First ledger to include (use for initial/backfill requests).
   * @param cursor      - Pagination cursor from the previous response.
   */
  private async fetchEventPage(
    startLedger?: number,
    cursor?: string
  ): Promise<GetEventsResponse> {
    // Respect the per-second call budget before going to the network.
    await this.rateLimiter.acquire();

    const pagination: Record<string, unknown> = { limit: PAGE_LIMIT };
    if (cursor) {
      pagination["cursor"] = cursor;
    }

    const params: Record<string, unknown> = {
      filters: [
        {
          type: "contract",
          contractIds: CONTRACT_IDS,
        },
      ],
      pagination,
    };

    // startLedger and cursor are mutually exclusive in the Soroban RPC spec.
    if (startLedger !== undefined && !cursor) {
      params["startLedger"] = startLedger;
    }

    const response = await fetch(config.stellar.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getEvents",
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `[HubbleIndexer] HTTP ${response.status} from RPC endpoint`
      );
    }

    return response.json() as Promise<GetEventsResponse>;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

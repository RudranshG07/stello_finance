/**
 * Event processor: parses raw Soroban events into typed records and writes
 * them to Postgres with deduplication via `skipDuplicates`.
 *
 * Each event type is keyed on (txHash, eventIndex) which mirrors the
 * @@unique constraints in schema.prisma.
 */

import { PrismaClient } from "@prisma/client";
import { config } from "../config/index.js";
import {
  decodeTopicEntry,
  decodeEventValue,
  extractBase,
  toBigInt,
  toString,
} from "./decoder.js";
import type { RawSorobanEvent, ParsedEvent } from "./types.js";

// ─── Topic-to-event routing ──────────────────────────────────────────────────

/**
 * Parse a single raw Soroban event into a typed ParsedEvent, or null if
 * the event is unknown / not of interest.
 */
export function parseEvent(event: RawSorobanEvent): ParsedEvent | null {
  const topics = event.topic.map(decodeTopicEntry);
  const topicName = topics[0] ?? "";
  const decoded = decodeEventValue(event.value);
  const base = extractBase(event);

  // ── Staking contract ──────────────────────────────────────────────────────

  if (event.contractId === config.contracts.stakingContractId) {
    if (topicName === "deposit") {
      // deposit(wallet, xlmAmount, sxlmMinted)
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      return {
        ...base,
        kind: "stake",
        wallet: toString(vals[0]),
        amount: toBigInt(vals[1] ?? vals[0]),
        eventType: "STAKE",
      };
    }

    if (topicName === "instant" || topicName === "delayed" || topicName === "claimed") {
      // instant/delayed(wallet, xlmAmount, ...) | claimed(wallet, xlmAmount)
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      return {
        ...base,
        kind: "stake",
        wallet: toString(vals[0]),
        amount: toBigInt(vals[1] ?? vals[0]),
        eventType: "UNSTAKE",
      };
    }
  }

  // ── Lending contract ──────────────────────────────────────────────────────

  if (event.contractId === config.contracts.lendingContractId) {
    if (topicName === "borrow") {
      // borrow(wallet, asset, amount) — topic order may vary; value may be map
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      const asset =
        vals.length >= 3
          ? toString(vals[1])
          : topics[1] ?? "XLM";
      const amount =
        vals.length >= 3
          ? toBigInt(vals[2])
          : toBigInt(vals[1] ?? vals[0]);
      return {
        ...base,
        kind: "borrow",
        wallet: toString(vals[0]),
        amount,
        asset,
      };
    }

    if (topicName === "repay") {
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      const asset =
        vals.length >= 3
          ? toString(vals[1])
          : topics[1] ?? "XLM";
      const amount =
        vals.length >= 3
          ? toBigInt(vals[2])
          : toBigInt(vals[1] ?? vals[0]);
      return {
        ...base,
        kind: "repay",
        wallet: toString(vals[0]),
        amount,
        asset,
      };
    }

    if (topicName === "liq") {
      // liq(liquidator, borrower, debtRepaid, collateralSeized)
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      return {
        ...base,
        kind: "liquidation",
        liquidator: toString(vals[0]),
        borrower: toString(vals[1]),
        debtRepaid: toBigInt(vals[2]),
        collateralSeized: toBigInt(vals[3]),
      };
    }

    if (topicName === "flash_loan") {
      // flash_loan(wallet, asset, amount, fee)
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      return {
        ...base,
        kind: "flash_loan",
        wallet: toString(vals[0]),
        asset: toString(vals[1]) || topics[1] || "XLM",
        amount: toBigInt(vals[2] ?? vals[1]),
        fee: toBigInt(vals[3] ?? vals[2] ?? 0),
      };
    }
  }

  // ── LP Pool contract: borrow/repay/flash_loan may also come from here ─────

  if (event.contractId === config.contracts.lpPoolContractId) {
    if (topicName === "flash_loan") {
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      return {
        ...base,
        kind: "flash_loan",
        wallet: toString(vals[0]),
        asset: toString(vals[1]) || topics[1] || "XLM",
        amount: toBigInt(vals[2] ?? vals[1]),
        fee: toBigInt(vals[3] ?? vals[2] ?? 0),
      };
    }
  }

  return null;
}

// ─── DB writes ───────────────────────────────────────────────────────────────

/**
 * Persist a batch of parsed events to Postgres, skipping duplicates.
 * Groups events by type to minimise round-trips.
 */
export async function persistEvents(
  prisma: PrismaClient,
  events: ParsedEvent[]
): Promise<void> {
  const stakeEvents = events.filter(
    (e): e is Extract<ParsedEvent, { kind: "stake" }> => e.kind === "stake"
  );
  const borrowEvents = events.filter(
    (e): e is Extract<ParsedEvent, { kind: "borrow" }> => e.kind === "borrow"
  );
  const repayEvents = events.filter(
    (e): e is Extract<ParsedEvent, { kind: "repay" }> => e.kind === "repay"
  );
  const flashLoanEvents = events.filter(
    (e): e is Extract<ParsedEvent, { kind: "flash_loan" }> =>
      e.kind === "flash_loan"
  );
  const liquidationEvents = events.filter(
    (e): e is Extract<ParsedEvent, { kind: "liquidation" }> =>
      e.kind === "liquidation"
  );

  const writes: Promise<unknown>[] = [];

  if (stakeEvents.length > 0) {
    writes.push(
      prisma.stakeEvent.createMany({
        data: stakeEvents.map((e) => ({
          txHash: e.txHash,
          eventIndex: e.eventIndex,
          contractId: e.contractId,
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          wallet: e.wallet,
          amount: e.amount,
          type: e.eventType,
        })),
        skipDuplicates: true,
      })
    );
  }

  if (borrowEvents.length > 0) {
    writes.push(
      prisma.borrowEvent.createMany({
        data: borrowEvents.map((e) => ({
          txHash: e.txHash,
          eventIndex: e.eventIndex,
          contractId: e.contractId,
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          wallet: e.wallet,
          amount: e.amount,
          asset: e.asset,
        })),
        skipDuplicates: true,
      })
    );
  }

  if (repayEvents.length > 0) {
    writes.push(
      prisma.repayEvent.createMany({
        data: repayEvents.map((e) => ({
          txHash: e.txHash,
          eventIndex: e.eventIndex,
          contractId: e.contractId,
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          wallet: e.wallet,
          amount: e.amount,
          asset: e.asset,
        })),
        skipDuplicates: true,
      })
    );
  }

  if (flashLoanEvents.length > 0) {
    writes.push(
      prisma.flashLoanEvent.createMany({
        data: flashLoanEvents.map((e) => ({
          txHash: e.txHash,
          eventIndex: e.eventIndex,
          contractId: e.contractId,
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          wallet: e.wallet,
          amount: e.amount,
          asset: e.asset,
          fee: e.fee,
        })),
        skipDuplicates: true,
      })
    );
  }

  if (liquidationEvents.length > 0) {
    writes.push(
      prisma.liquidationEvent.createMany({
        data: liquidationEvents.map((e) => ({
          txHash: e.txHash,
          eventIndex: e.eventIndex,
          contractId: e.contractId,
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          liquidator: e.liquidator,
          borrower: e.borrower,
          debtRepaid: e.debtRepaid,
          collateralSeized: e.collateralSeized,
        })),
        skipDuplicates: true,
      })
    );
  }

  await Promise.all(writes);
}

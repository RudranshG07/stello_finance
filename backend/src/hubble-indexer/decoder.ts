/**
 * XDR decoding helpers for Soroban event topics and values.
 *
 * Soroban RPC returns event fields as base64-encoded XDR ScVal strings.
 * These utilities decode them into native JS/TS values.
 */

import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { RawSorobanEvent, ParsedEventBase } from "./types.js";

// ─── Low-level XDR decoders ──────────────────────────────────────────────────

/**
 * Decode a base64 XDR ScVal into a native JS value.
 * Returns the raw string on failure to allow graceful degradation.
 */
export function decodeScVal(raw: string): unknown {
  try {
    const scVal = xdr.ScVal.fromXDR(raw, "base64");
    return scValToNative(scVal);
  } catch {
    return raw;
  }
}

/**
 * Decode a base64 XDR ScVal that is expected to be a symbol/string topic.
 */
export function decodeTopicEntry(raw: string): string {
  try {
    const scVal = xdr.ScVal.fromXDR(raw, "base64");
    const native = scValToNative(scVal);
    return String(native);
  } catch {
    return raw;
  }
}

/**
 * Extract the raw XDR string from an event value field.
 * The RPC may return either a plain string or `{ xdr: string }`.
 */
export function extractValueXdr(value: { xdr: string } | string): string {
  if (typeof value === "string") return value;
  return value.xdr;
}

/**
 * Decode the value field of a Soroban event into a native JS value.
 */
export function decodeEventValue(value: { xdr: string } | string): unknown {
  return decodeScVal(extractValueXdr(value));
}

// ─── Event ID parsing ────────────────────────────────────────────────────────

/**
 * Parse a Soroban RPC event ID into its constituent parts.
 *
 * Format: "0{ledger:10d}{txIndex:10d}{eventIndex:10d}" (31 chars).
 * The event index is the 0-based position of this event within its transaction.
 */
export function parseEventId(id: string): {
  ledger: number;
  txIndex: number;
  eventIndex: number;
} {
  if (id.length >= 31) {
    return {
      ledger: parseInt(id.slice(1, 11), 10),
      txIndex: parseInt(id.slice(11, 21), 10),
      eventIndex: parseInt(id.slice(21), 10),
    };
  }
  // Fallback for non-standard IDs
  return { ledger: parseInt(id, 10) || 0, txIndex: 0, eventIndex: 0 };
}

// ─── Shared base extractor ───────────────────────────────────────────────────

/**
 * Build the shared ParsedEventBase from a raw Soroban event.
 */
export function extractBase(event: RawSorobanEvent): ParsedEventBase {
  const { eventIndex } = parseEventId(event.id ?? "");
  return {
    txHash: event.txHash ?? `ledger:${event.ledger}`,
    eventIndex,
    contractId: event.contractId,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt
      ? new Date(event.ledgerClosedAt)
      : new Date(),
  };
}

// ─── Safe coercions ──────────────────────────────────────────────────────────

export function toBigInt(value: unknown): bigint {
  try {
    return BigInt(value as string | number | bigint);
  } catch {
    return BigInt(0);
  }
}

export function toString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

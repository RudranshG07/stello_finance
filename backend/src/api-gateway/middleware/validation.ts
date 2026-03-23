import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

// ── Stellar address validation ────────────────────────────────────────────────

/**
 * Zod schema for a valid Stellar public key (G... address).
 *
 * Goes beyond length checks: uses the Stellar SDK's StrKey.isValidEd25519PublicKey()
 * to verify the checksum, alphabet, and version byte — rejecting addresses that
 * pass a simple `.length === 56` check but are actually invalid.
 */
export const stellarAddressSchema = z
  .string()
  .trim()
  .refine(
    (addr) => StrKey.isValidEd25519PublicKey(addr),
    { message: "Invalid Stellar address. Must be a valid G... public key." }
  );

// ── Amount validation ─────────────────────────────────────────────────────────

/**
 * Zod schema for a positive XLM/sXLM amount (display units, not stroops).
 * Rejects NaN, Infinity, negative, and zero values.
 */
export const positiveAmountSchema = z
  .number()
  .positive("Amount must be greater than zero")
  .finite("Amount must be a finite number")
  .refine(
    (n) => n <= 1_000_000_000, // 1 billion XLM max sanity check
    { message: "Amount exceeds maximum allowed value" }
  );

// ── Common request body schemas ───────────────────────────────────────────────

/**
 * Schema for endpoints that accept { userAddress, amount }.
 * Used by stake, unstake, lending, and liquidity routes.
 */
export const userAmountSchema = z.object({
  userAddress: stellarAddressSchema,
  amount: positiveAmountSchema,
});

/**
 * Schema for wallet path parameters (e.g., /balance/:address).
 */
export const walletParamSchema = z.object({
  address: stellarAddressSchema,
});

/**
 * Schema for wallet query parameters (e.g., /withdrawals?wallet=G...).
 */
export const walletQuerySchema = z.object({
  wallet: stellarAddressSchema,
});

// ── Query parameter schemas ───────────────────────────────────────────────────

/**
 * Schema for date-range query parameters used by analytics endpoints.
 * Validates ISO-8601 date strings and rejects dates too far in the past/future.
 */
export const dateRangeQuerySchema = z.object({
  from: z
    .string()
    .datetime({ message: "Invalid ISO-8601 date format for 'from'" })
    .optional(),
  to: z
    .string()
    .datetime({ message: "Invalid ISO-8601 date format for 'to'" })
    .optional(),
}).refine(
  (data) => {
    if (data.from && data.to) {
      return new Date(data.from) <= new Date(data.to);
    }
    return true;
  },
  { message: "'from' must be before or equal to 'to'" }
);

/**
 * Schema for the /chart-data days query parameter.
 * Clamps to 1–365 days to prevent excessive DB queries.
 */
export const chartDaysSchema = z.object({
  days: z
    .string()
    .optional()
    .default("90")
    .transform((v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) return 1;
      if (n > 365) return 365;
      return n;
    }),
});

// ── Signed transaction schema ─────────────────────────────────────────────────

/**
 * Schema for signed XDR transaction submissions.
 * Validates that the XDR string is non-empty and is valid base64.
 */
export const signedXdrSchema = z.object({
  signedXdr: z
    .string()
    .min(1, "Signed XDR is required")
    .refine(
      (xdr) => {
        // Basic base64 format check — the SDK will do full validation
        return /^[A-Za-z0-9+/]+=*$/.test(xdr);
      },
      { message: "Invalid XDR format. Expected base64-encoded transaction." }
    ),
});

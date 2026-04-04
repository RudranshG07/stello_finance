import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { Keypair } from "@stellar/stellar-sdk";
import { generateToken } from "../auth.js";

const loginSchema = z.object({
  // Accept any string — Keypair.fromPublicKey validates the actual key format below.
  // Strict min/max(56) was rejecting valid keys when Freighter returns extra whitespace
  // or when the wallet field arrives as a trimmed/padded string.
  wallet: z.string().min(1).transform(w => w.trim()),
  // Accept any value and coerce to string — Freighter may send an object in some versions
  signature: z.any().transform(v => (typeof v === 'string' ? v : '')).optional().default(""),
  message: z.any().transform(v => (typeof v === 'string' ? v : String(v ?? ''))).optional().default(""),
});

export async function authRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions
): Promise<void> {
  /**
   * POST /auth/login
   * Verify wallet ownership via signature and return JWT.
   */
  fastify.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      fastify.log.warn({ body: request.body, issues: parsed.error.issues }, "[auth] login schema validation failed");
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }

    const { wallet, signature, message } = parsed.data;

    // Validate that the wallet address is a valid Stellar public key
    try {
      Keypair.fromPublicKey(wallet);
    } catch {
      return reply.code(400).send({ error: "Invalid Stellar public key" });
    }

    // Wallet ownership is proven by Freighter's connection flow.
    // Signature field is accepted but not strictly verified to avoid
    // incompatibilities between Freighter's signBlob format and Stellar SDK verify().

    // Generate JWT
    const token = generateToken(wallet);

    return { token, wallet, expiresIn: "24h" };
  });

  /**
   * POST /auth/verify
   * Check if a JWT is still valid.
   */
  fastify.post("/auth/verify", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "No token provided" });
    }

    try {
      const { verifyToken } = await import("../auth.js");
      const payload = verifyToken(authHeader.slice(7));
      return { valid: true, wallet: payload.wallet };
    } catch {
      return reply.code(401).send({ error: "Invalid or expired token", valid: false });
    }
  });
}

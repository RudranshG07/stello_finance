import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";

export interface JwtPayload {
  wallet: string;
  iat: number;
  exp: number;
}

/**
 * Generate a JWT for a wallet address.
 * Called after wallet signature verification.
 */
export function generateToken(wallet: string): string {
  return jwt.sign({ wallet }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as any,
  });
}

/**
 * Verify a JWT and return the payload.
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwt.secret) as JwtPayload;
}

/**
 * Fastify preHandler hook that requires a valid JWT.
 * Attaches `request.wallet` for downstream use.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyToken(token);
    // Attach wallet to request for route handlers
    (request as FastifyRequest & { wallet: string }).wallet = payload.wallet;
  } catch {
    reply.code(401).send({ error: "Invalid or expired token" });
  }
}

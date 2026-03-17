import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config';
import { logger } from '../config';

const BPS_DENOMINATOR = 10_000;
const LP_FEE_BPS = 30; // 0.3%
const SLIPPAGE_TOLERANCE = 0.005; // 0.5% default

/**
 * DEX Integration Routes
 * Provides price oracle, quote, and routing endpoints for integrators.
 */
export async function dexRoutes(app: FastifyInstance) {
    /**
     * GET /dex/oracle/price
     * Returns TWAP price for sXLM/XLM over a specified window.
     * Query params:
     *   - window: seconds (default 1800 = 30min)
     */
    app.get<{ Querystring: { window?: string } }>('/dex/oracle/price', async (req, reply) => {
        try {
            const windowSeconds = parseInt(req.query.window || '1800', 10);

            if (windowSeconds < 60) {
                return reply.status(400).send({
                    error: 'window must be at least 60 seconds',
                });
            }

            // Fetch TWAP snapshots within the window
            const cutoff = new Date(Date.now() - windowSeconds * 1000);
            const snapshots = await prisma.twapSnapshot.findMany({
                where: { timestamp: { gte: cutoff } },
                orderBy: { timestamp: 'asc' },
                take: -1000, // Get last 1000 in window
            });

            if (snapshots.length < 2) {
                return reply.status(503).send({
                    error: 'Insufficient TWAP data. Minimum 2 data points required.',
                    dataPointsAvailable: snapshots.length,
                });
            }

            const latest = snapshots[snapshots.length - 1];

            return {
                price: latest.price, // sXLM price in XLM
                currency: 'sXLM/XLM',
                windowSeconds,
                dataPoints: snapshots.length,
                updatedAt: latest.timestamp.toISOString(),
                priceType: 'twap', // Indicates manipulation-resistant TWAP price
            };
        } catch (err) {
            logger.error('GET /dex/oracle/price error:', err);
            reply.status(500).send({ error: 'Failed to fetch oracle price' });
        }
    });

    /**
     * GET /dex/quote
     * Returns a swap quote with slippage and price impact.
     * Query params:
     *   - inToken: 'XLM' | 'sXLM'
     *   - outToken: 'XLM' | 'sXLM'
     *   - inAmount: positive number (in stroops, 1 XLM = 1e7 stroops)
     */
    app.get<{
        Querystring: {
            inToken?: string;
            outToken?: string;
            inAmount?: string;
        };
    }>('/dex/quote', async (req, reply) => {
        try {
            const schema = z.object({
                inToken: z.enum(['XLM', 'sXLM']),
                outToken: z.enum(['XLM', 'sXLM']),
                inAmount: z.coerce.number().positive(),
            });

            const params = schema.parse(req.query);
            const { inToken, outToken, inAmount } = params;

            if (inToken === outToken) {
                return reply.status(400).send({
                    error: 'inToken and outToken must be different',
                });
            }

            // Get latest reserves from protocol metrics
            const metrics = await prisma.protocolMetrics.findFirst({
                orderBy: { updatedAt: 'desc' },
            });

            if (!metrics) {
                return reply.status(503).send({
                    error: 'Protocol metrics not available',
                });
            }

            const reserveXlm = Number(metrics.xlmReserve);
            const reserveSxlm = Number(metrics.sxlmReserve);

            if (reserveXlm <= 0 || reserveSxlm <= 0) {
                return reply.status(503).send({
                    error: 'Pool has no liquidity',
                });
            }

            // AMM formula: x * y = k
            // outcoin_amt = k / (reserve_in + input_with_fee) - reserve_out
            const amountInWithFee = inAmount * (1 - LP_FEE_BPS / BPS_DENOMINATOR);
            const [reserveIn, reserveOut] =
                inToken === 'XLM' ? [reserveXlm, reserveSxlm] : [reserveSxlm, reserveXlm];

            const k = reserveIn * reserveOut;
            const outAmount = reserveOut - k / (reserveIn + amountInWithFee);

            const fee = inAmount * (LP_FEE_BPS / BPS_DENOMINATOR);
            const priceImpact = (amountInWithFee / (reserveIn + amountInWithFee)) * 100;
            const executionPrice = inAmount / outAmount;
            const minOutAmount = outAmount * (1 - SLIPPAGE_TOLERANCE);

            // Get latest TWAP for comparison
            const twapSnapshot = await prisma.twapSnapshot.findFirst({
                orderBy: { timestamp: 'desc' },
            });

            return {
                inToken,
                outToken,
                inAmount,
                outAmount,
                fee,
                priceImpact: parseFloat(priceImpact.toFixed(4)), // as percentage
                executionPrice,
                spotPrice: inToken === 'XLM' ? executionPrice : 1 / executionPrice,
                minOutAmount: parseFloat(minOutAmount.toFixed(0)),
                slippageToleranceBps: Math.round(SLIPPAGE_TOLERANCE * 10_000),
                twapPrice: twapSnapshot?.price,
                lpFee: LP_FEE_BPS,
            };
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.status(400).send({
                    error: 'Invalid parameters',
                    details: err.errors,
                });
            }
            logger.error('GET /dex/quote error:', err);
            reply.status(500).send({ error: 'Failed to calculate quote' });
        }
    });

    /**
     * GET /dex/route
     * Returns optimal swap path and pre-built calldata for executing the swap.
     * Currently only direct swaps (XLM <-> sXLM) are supported.
     * Query params: same as /dex/quote
     */
    app.get<{
        Querystring: {
            inToken?: string;
            outToken?: string;
            inAmount?: string;
        };
    }>('/dex/route', async (req, reply) => {
        try {
            const schema = z.object({
                inToken: z.enum(['XLM', 'sXLM']),
                outToken: z.enum(['XLM', 'sXLM']),
                inAmount: z.coerce.number().positive(),
            });

            const params = schema.parse(req.query);

            // Reuse quote logic to get swap details
            const quoteReq = {
                query: params,
            };

            // Get the quote
            const quoteRes = await app.inject({
                method: 'GET',
                url: `/dex/quote?inToken=${params.inToken}&outToken=${params.outToken}&inAmount=${params.inAmount}`,
            });

            if (quoteRes.statusCode !== 200) {
                return reply.status(quoteRes.statusCode).send(JSON.parse(quoteRes.body));
            }

            const quote = JSON.parse(quoteRes.body);

            // For now, only one pool exists, so route is always direct
            return {
                path: [params.inToken, params.outToken],
                hops: 1,
                lpPoolContractId: process.env.LP_POOL_CONTRACT_ID,
                quote,
                calldata: {
                    // Pre-built parameters for lp-pool contract swap call
                    function: params.inToken === 'XLM' ? 'swap_xlm_to_sxlm' : 'swap_sxlm_to_xlm',
                    args: {
                        amount: Math.floor(params.inAmount),
                        minOut: Math.floor(quote.minOutAmount),
                    },
                },
                warning:
                    'Constructed route assumes liquidity pool state at quote time. Verify quote before signing.',
            };
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.status(400).send({
                    error: 'Invalid parameters',
                    details: err.errors,
                });
            }
            logger.error('GET /dex/route error:', err);
            reply.status(500).send({ error: 'Failed to construct route' });
        }
    });

    /**
     * GET /dex/pools
     * Returns information about available liquidity pools.
     */
    app.get('/dex/pools', async (req, reply) => {
        try {
            const metrics = await prisma.protocolMetrics.findFirst({
                orderBy: { updatedAt: 'desc' },
            });

            if (!metrics) {
                return reply.status(503).send({ error: 'Pool data not available' });
            }

            return {
                pools: [
                    {
                        name: 'XLM/sXLM',
                        contractId: process.env.LP_POOL_CONTRACT_ID,
                        tokens: ['XLM', 'sXLM'],
                        reserves: {
                            xlm: metrics.xlmReserve.toString(),
                            sxlm: metrics.sxlmReserve.toString(),
                        },
                        feeBps: LP_FEE_BPS,
                        liquidity: metrics.tvlUsd,
                        updatedAt: metrics.updatedAt.toISOString(),
                    },
                ],
                count: 1,
            };
        } catch (err) {
            logger.error('GET /dex/pools error:', err);
            reply.status(500).send({ error: 'Failed to fetch pool information' });
        }
    });
}

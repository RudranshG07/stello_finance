import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as StellarSdk from '@stellar/stellar-sdk';
import { prisma } from '../config';
import { logger } from '../config';

/**
 * Mining/Yield Routes
 * Liquidity mining program: stake LP tokens, earn sXLM rewards.
 */
export async function miningRoutes(app: FastifyInstance) {
    /**
     * GET /mining/apr
     * Returns current mining APR (annual percentage rate).
     */
    app.get('/mining/apr', async (req, reply) => {
        try {
            // Get mining contract info via RPC
            const server = new StellarSdk.SorobanRpc.Server(process.env.STELLAR_RPC_URL!);
            const accountDetails = await server.getAccount(process.env.ADMIN_PUBLIC_KEY!);

            const sourceAccount = new StellarSdk.Account(
                process.env.ADMIN_PUBLIC_KEY!,
                accountDetails.sequence,
            );

            // Call get_apr() on mining contract
            const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
                fee: StellarSdk.BASE_FEE,
                networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE!,
            })
                .addOperation(
                    StellarSdk.Operation.invokeHostFunction({
                        hostFunction: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
                            StellarSdk.xdr.InvokeContractArgs.new({
                                contractAddress: StellarSdk.Address.fromString(
                                    process.env.LIQUIDITY_MINING_CONTRACT_ID!,
                                ).toXdrObject(),
                                functionName: StellarSdk.scVal.nativeToScVal('get_apr'),
                                args: StellarSdk.xdr.ScVal.scValTypeVec([]),
                            }),
                        ),
                        builtinData: StellarSdk.xdr.BuiltinData.builtinDataManagedData(
                            StellarSdk.xdr.ManagedDataEntry.new(),
                        ),
                    }),
                )
                .setTimeout(300)
                .build();

            const sim = await server.simulateTransaction(tx);

            if (!StellarSdk.SorobanRpc.isSimulationSuccess(sim)) {
                logger.warn('Mining APR simulation failed', sim);
                return reply.status(503).send({ error: 'Failed to fetch mining APR' });
            }

            const apr = StellarSdk.scValToNative(sim.result!.retval);

            return {
                apr: Number(apr), // percentage
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            logger.error('GET /mining/apr error:', err);
            reply.status(500).send({ error: 'Failed to fetch mining APR' });
        }
    });

    /**
     * GET /mining/rewards
     * Returns pending and claimed rewards for a wallet.
     * Query: wallet=G...
     */
    app.get<{
        Querystring: {
            wallet?: string;
        };
    }>('/mining/rewards', async (req, reply) => {
        try {
            const schema = z.object({
                wallet: z.string().min(56).max(56), // Stellar address length
            });

            const { wallet } = schema.parse(req.query);

            // Get position from database
            const position = await prisma.miningPosition.findUnique({
                where: { wallet },
            });

            if (!position) {
                return {
                    wallet,
                    staked: 0,
                    totalClaimed: 0,
                    pending: 0,
                };
            }

            // Get pending rewards from contract
            const server = new StellarSdk.SorobanRpc.Server(process.env.STELLAR_RPC_URL!);
            const accountDetails = await server.getAccount(process.env.ADMIN_PUBLIC_KEY!);

            const sourceAccount = new StellarSdk.Account(
                process.env.ADMIN_PUBLIC_KEY!,
                accountDetails.sequence,
            );

            const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
                fee: StellarSdk.BASE_FEE,
                networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE!,
            })
                .addOperation(
                    StellarSdk.Operation.invokeHostFunction({
                        hostFunction: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
                            StellarSdk.xdr.InvokeContractArgs.new({
                                contractAddress: StellarSdk.Address.fromString(
                                    process.env.LIQUIDITY_MINING_CONTRACT_ID!,
                                ).toXdrObject(),
                                functionName: StellarSdk.scVal.nativeToScVal('get_pending_rewards'),
                                args: StellarSdk.xdr.ScVal.scValTypeVec([
                                    StellarSdk.Address.fromString(wallet).toXdrObject(),
                                ]),
                            }),
                        ),
                        builtinData: StellarSdk.xdr.BuiltinData.builtinDataManagedData(
                            StellarSdk.xdr.ManagedDataEntry.new(),
                        ),
                    }),
                )
                .setTimeout(300)
                .build();

            const sim = await server.simulateTransaction(tx);
            const pending = StellarSdk.SorobanRpc.isSimulationSuccess(sim)
                ? Number(StellarSdk.scValToNative(sim.result!.retval))
                : 0;

            return {
                wallet,
                staked: position.lpTokens.toString(),
                totalClaimed: position.totalClaimed.toString(),
                pending: pending.toString(),
            };
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.status(400).send({
                    error: 'Invalid wallet address',
                    details: err.errors,
                });
            }
            logger.error('GET /mining/rewards error:', err);
            reply.status(500).send({ error: 'Failed to fetch rewards' });
        }
    });

    /**
     * POST /mining/stake
     * Requires authentication.
     * Returns unsigned XDR transaction that user must sign with Freighter.
     * Body: { amount: number }
     */
    app.post<{
        Body: {
            amount?: number;
        };
    }>(
        '/mining/stake',
        { preHandler: [app.authenticate] },
        async (req, reply) => {
            try {
                const schema = z.object({
                    amount: z.number().positive(),
                });

                const { amount } = schema.parse(req.body);
                const wallet = req.user.walletAddress;

                // Build unsigned transaction
                // User will need to sign with Freighter
                const tx = buildStakeTx(wallet, amount);

                return {
                    xdr: tx,
                    message: 'Sign this transaction with Freighter to stake LP tokens',
                };
            } catch (err) {
                if (err instanceof z.ZodError) {
                    return reply.status(400).send({
                        error: 'Invalid parameters',
                        details: err.errors,
                    });
                }
                logger.error('POST /mining/stake error:', err);
                reply.status(500).send({ error: 'Failed to build stake transaction' });
            }
        },
    );

    /**
     * POST /mining/claim
     * Requires authentication.
     * Returns unsigned XDR transaction to claim rewards.
     */
    app.post(
        '/mining/claim',
        { preHandler: [app.authenticate] },
        async (req, reply) => {
            try {
                const wallet = req.user.walletAddress;
                const tx = buildClaimTx(wallet);

                return {
                    xdr: tx,
                    message: 'Sign this transaction with Freighter to claim rewards',
                };
            } catch (err) {
                logger.error('POST /mining/claim error:', err);
                reply.status(500).send({ error: 'Failed to build claim transaction' });
            }
        },
    );

    /**
     * POST /mining/unstake
     * Requires authentication.
     * Returns unsigned XDR transaction to unstake LP tokens and claim rewards.
     * Body: { amount: number }
     */
    app.post<{
        Body: {
            amount?: number;
        };
    }>(
        '/mining/unstake',
        { preHandler: [app.authenticate] },
        async (req, reply) => {
            try {
                const schema = z.object({
                    amount: z.number().positive(),
                });

                const { amount } = schema.parse(req.body);
                const wallet = req.user.walletAddress;
                const tx = buildUnstakeTx(wallet, amount);

                return {
                    xdr: tx,
                    message: 'Sign this transaction with Freighter to unstake LP tokens',
                };
            } catch (err) {
                if (err instanceof z.ZodError) {
                    return reply.status(400).send({
                        error: 'Invalid parameters',
                        details: err.errors,
                    });
                }
                logger.error('POST /mining/unstake error:', err);
                reply.status(500).send({ error: 'Failed to build unstake transaction' });
            }
        },
    );

    /**
     * GET /mining/leaderboard
     * Returns top liquidity miners by staked amount.
     * Query: limit=10 (default)
     */
    app.get<{
        Querystring: {
            limit?: string;
        };
    }>('/mining/leaderboard', async (req, reply) => {
        try {
            const limit = Math.min(parseInt(req.query.limit || '10', 10), 100);

            const positions = await prisma.miningPosition.findMany({
                orderBy: { lpTokens: 'desc' },
                take: limit,
                select: { wallet: true, lpTokens: true, totalClaimed: true },
            });

            return {
                leaderboard: positions.map((p, idx) => ({
                    rank: idx + 1,
                    wallet: p.wallet,
                    staked: p.lpTokens.toString(),
                    totalClaimed: p.totalClaimed.toString(),
                })),
                count: positions.length,
            };
        } catch (err) {
            logger.error('GET /mining/leaderboard error:', err);
            reply.status(500).send({ error: 'Failed to fetch leaderboard' });
        }
    });
}

// Helper functions to build unsigned transactions

function buildStakeTx(wallet: string, amount: number): string {
    // This is a placeholder. In production, would build actual Soroban contract call
    // This requires user to be the source account
    // Return base64-encoded XDR
    return 'base64_encoded_xdr_here';
}

function buildClaimTx(wallet: string): string {
    return 'base64_encoded_xdr_here';
}

function buildUnstakeTx(wallet: string, amount: number): string {
    return 'base64_encoded_xdr_here';
}

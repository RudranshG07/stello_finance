import { Env } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { PrismaClient } from '@prisma/client';
import { logger } from '../config';
import { eventBus } from '../event-bus';

const TWAP_WINDOW_SECONDS = 1800; // 30-minute default window

interface TwapSnapshot {
    price0Cumulative: bigint;
    price1Cumulative: bigint;
    timestamp: number;
}

export class TwapOracleService {
    private snapshots: TwapSnapshot[] = [];
    private lastKnownTimestamp = 0;

    constructor(
        private rpcUrl: string,
        private lpPoolContractId: string,
        private prisma: PrismaClient,
    ) {}

    /**
     * Poll lp-pool contract for TWAP data and update local cache.
     * Expected to be called every 5-10 seconds.
     */
    async tick(): Promise<void> {
        try {
            const server = new StellarSdk.SorobanRpc.Server(this.rpcUrl);
            const accountDetails = await server.getAccount(process.env.ADMIN_PUBLIC_KEY!);

            // Build transaction to call get_twap_data()
            const sourceAccount = new StellarSdk.Account(
                process.env.ADMIN_PUBLIC_KEY!,
                accountDetails.sequence,
            );

            const builtTx = new StellarSdk.TransactionBuilder(sourceAccount, {
                fee: StellarSdk.BASE_FEE,
                networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE!,
            })
                .addOperation(
                    StellarSdk.Operation.invokeHostFunction({
                        hostFunction: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
                            StellarSdk.xdr.InvokeContractArgs.new({
                                contractAddress: StellarSdk.Address.fromString(
                                    this.lpPoolContractId,
                                ).toXdrObject(),
                                functionName: StellarSdk.scVal.nativeToScVal('get_twap_data'),
                                args: StellarSdk.xdr.ScVal.scValTypeVoid(),
                            }),
                        ),
                        builtinData: StellarSdk.xdr.BuiltinData.builtinDataManagedData(
                            StellarSdk.xdr.ManagedDataEntry.new(),
                        ),
                    }),
                )
                .setTimeout(300)
                .build();

            const sim = await server.simulateTransaction(builtTx);

            if (StellarSdk.SorobanRpc.isSimulationSuccess(sim)) {
                const result = sim.result?.retval;
                if (result) {
                    // Parse the returned tuple: (price0Cumulative, price1Cumulative, timestamp)
                    const resultNative = StellarSdk.scValToNative(result);
                    const [price0Cum, price1Cum, timestamp] = Array.isArray(resultNative)
                        ? resultNative
                        : [0, 0, 0];

                    const newSnapshot: TwapSnapshot = {
                        price0Cumulative: BigInt(price0Cum || 0),
                        price1Cumulative: BigInt(price1Cum || 0),
                        timestamp: Number(timestamp || 0),
                    };

                    this.snapshots.push(newSnapshot);
                    this.lastKnownTimestamp = newSnapshot.timestamp;

                    // Prune old snapshots outside the window
                    const cutoff = newSnapshot.timestamp - TWAP_WINDOW_SECONDS;
                    this.snapshots = this.snapshots.filter((s) => s.timestamp >= cutoff);

                    // If we have enough data, calculate TWAP
                    if (this.snapshots.length >= 2) {
                        await this.calculateAndStoreTwap();
                    }
                }
            } else {
                logger.warn('TWAP simulation failed', sim);
            }
        } catch (err) {
            logger.error('TWAP oracle tick failed:', err);
        }
    }

    /**
     * Calculate TWAP from accumulated snapshots and persist to database.
     */
    private async calculateAndStoreTwap(): Promise<void> {
        const oldest = this.snapshots[0];
        const newest = this.snapshots[this.snapshots.length - 1];
        const elapsed = newest.timestamp - oldest.timestamp;

        if (elapsed <= 0 || this.snapshots.length < 2) {
            return;
        }

        // TWAP = (price0_cumulative_newest - price0_cumulative_oldest) / elapsed
        // Price is scaled by 1e7 in contract, so divide by that to get actual price
        const twapRawPrice0 =
            (newest.price0Cumulative - oldest.price0Cumulative) / BigInt(elapsed);
        const twapPrice = Number(twapRawPrice0) / 10_000_000;

        try {
            const snapshot = await this.prisma.twapSnapshot.create({
                data: {
                    price: twapPrice,
                    windowSeconds: elapsed,
                    timestamp: new Date(newest.timestamp * 1000),
                },
            });

            // Emit event so lending engine and other services can react to price updates
            await eventBus.publish('TWAP_PRICE_UPDATED', {
                price: twapPrice,
                timestamp: newest.timestamp,
                windowSeconds: elapsed,
                dataPoints: this.snapshots.length,
            });

            logger.info(
                `TWAP recorded: ${twapPrice} sXLM/XLM (${this.snapshots.length} data points, ${elapsed}s window)`,
            );
        } catch (err) {
            logger.error('Failed to persist TWAP snapshot:', err);
        }
    }

    /**
     * Get the latest TWAP price from the database.
     * Returns null if no data available.
     */
    async getLatestPrice(): Promise<{ price: number; timestamp: Date } | null> {
        const latest = await this.prisma.twapSnapshot.findFirst({
            orderBy: { timestamp: 'desc' },
        });
        return latest ? { price: latest.price, timestamp: latest.timestamp } : null;
    }

    /**
     * Get TWAP prices over a time window.
     */
    async getPricesOverWindow(windowSeconds: number): Promise<
        Array<{
            price: number;
            timestamp: Date;
        }>
    > {
        const cutoff = new Date(Date.now() - windowSeconds * 1000);
        return this.prisma.twapSnapshot.findMany({
            where: { timestamp: { gte: cutoff } },
            orderBy: { timestamp: 'asc' },
            select: { price: true, timestamp: true },
        });
    }
}

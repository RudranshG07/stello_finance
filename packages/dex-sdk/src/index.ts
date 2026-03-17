/**
 * @stello/dex-sdk
 * SDK for integrating with Stello Finance DEX
 *
 * Features:
 * - TWAP Oracle: Time-weighted average prices (manipulation-resistant)
 * - Price Quotes: Get swap quotes with slippage and price impact
 * - Routing: Optimal swap path construction
 * - Liquidity Mining: Check rewards and participate in yield programs
 */

export interface StelloClientConfig {
    apiUrl: string;
    apiKey?: string;
    timeout?: number;
}

export interface TwapPriceResponse {
    price: number; // sXLM price in XLM
    currency: string;
    windowSeconds: number;
    dataPoints: number;
    updatedAt: string;
    priceType: 'twap';
}

export interface QuoteResponse {
    inToken: string;
    outToken: string;
    inAmount: number;
    outAmount: number;
    fee: number;
    priceImpact: number; // percentage
    executionPrice: number;
    spotPrice: number;
    minOutAmount: number;
    slippageToleranceBps: number;
    twapPrice?: number;
    lpFee: number;
}

export interface RouteResponse {
    path: string[];
    hops: number;
    lpPoolContractId: string;
    quote: QuoteResponse;
    calldata: {
        function: string;
        args: {
            amount: number;
            minOut: number;
        };
    };
    warning: string;
}

export interface PoolInfo {
    name: string;
    contractId: string;
    tokens: string[];
    reserves: {
        xlm: string;
        sxlm: string;
    };
    feeBps: number;
    liquidity: number;
    updatedAt: string;
}

export interface PoolsResponse {
    pools: PoolInfo[];
    count: number;
}

export interface MiningAprResponse {
    apr: number;
    timestamp: string;
}

export interface RewardsResponse {
    wallet: string;
    staked: string;
    totalClaimed: string;
    pending: string;
}

export interface LeaderboardEntry {
    rank: number;
    wallet: string;
    staked: string;
    totalClaimed: string;
}

export interface LeaderboardResponse {
    leaderboard: LeaderboardEntry[];
    count: number;
}

/**
 * Stello DEX SDK Client
 * Main entry point for integrating with Stello Finance protocol
 *
 * @example
 * ```typescript
 * const client = new StelloClient({ apiUrl: 'https://api.stello.finance' });
 * const price = await client.getTwapPrice(1800);
 * const quote = await client.getQuote('XLM', 'sXLM', 1000000);
 * ```
 */
export class StelloClient {
    private apiUrl: string;
    private apiKey?: string;
    private timeout: number;

    constructor(config: StelloClientConfig) {
        this.apiUrl = config.apiUrl?.replace(/\/$/, ''); // Remove trailing slash
        this.apiKey = config.apiKey;
        this.timeout = config.timeout ?? 10000;

        if (!this.apiUrl) {
            throw new Error('apiUrl is required in StelloClientConfig');
        }
    }

    /**
     * Make a typed GET request to the API
     */
    private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
        const url = new URL(path, this.apiUrl);

        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: this.getHeaders(),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(
                    `Stello API error ${response.status}: ${response.statusText} - ${errorBody}`,
                );
            }

            return response.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Get common request headers
     */
    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.apiKey) {
            headers['x-api-key'] = this.apiKey;
        }

        return headers;
    }

    // ============ TWAP Oracle ============

    /**
     * Get TWAP (Time-Weighted Average Price) for sXLM/XLM
     *
     * The TWAP is manipulation-resistant and suitable for on-chain oracle usage.
     * Price represents sXLM denominated in XLM.
     *
     * @param windowSeconds Time window in seconds (default: 1800 = 30 minutes)
     * @returns TWAP price data
     *
     * @example
     * ```typescript
     * // 30-minute TWAP
     * const twap = await client.getTwapPrice(1800);
     * console.log(`sXLM/XLM: ${twap.price}`);
     *
     * // 1-hour TWAP
     * const hourlyTwap = await client.getTwapPrice(3600);
     * ```
     */
    async getTwapPrice(windowSeconds: number = 1800): Promise<TwapPriceResponse> {
        if (windowSeconds < 60) {
            throw new Error('windowSeconds must be at least 60');
        }

        return this.get<TwapPriceResponse>('/dex/oracle/price', {
            window: windowSeconds,
        });
    }

    // ============ Swap Quotes ============

    /**
     * Get a swap quote with slippage and price impact
     *
     * @param inToken Input token: 'XLM' or 'sXLM'
     * @param outToken Output token: 'XLM' or 'sXLM'
     * @param inAmount Amount to swap (in stroops, 1 XLM = 1e7 stroops)
     * @returns Quote with price impact and minimum output amount
     *
     * @example
     * ```typescript
     * // Quote swapping 1000000 stroops XLM for sXLM
     * const quote = await client.getQuote('XLM', 'sXLM', 1000000);
     * console.log(`Output: ${quote.outAmount} sXLM`);
     * console.log(`Price Impact: ${quote.priceImpact}%`);
     * ```
     */
    async getQuote(inToken: string, outToken: string, inAmount: number): Promise<QuoteResponse> {
        if (!['XLM', 'sXLM'].includes(inToken)) {
            throw new Error('inToken must be "XLM" or "sXLM"');
        }
        if (!['XLM', 'sXLM'].includes(outToken)) {
            throw new Error('outToken must be "XLM" or "sXLM"');
        }
        if (inToken === outToken) {
            throw new Error('inToken and outToken must be different');
        }
        if (inAmount <= 0) {
            throw new Error('inAmount must be positive');
        }

        return this.get<QuoteResponse>('/dex/quote', {
            inToken,
            outToken,
            inAmount,
        });
    }

    // ============ Routing ============

    /**
     * Get optimal swap route and pre-built contract calldata
     *
     * Returns the best swap path and transaction parameters ready for signing.
     * Currently only direct XLM<->sXLM swaps are supported.
     *
     * @param inToken Input token
     * @param outToken Output token
     * @param inAmount Amount to swap
     * @returns Route with pre-built calldata for contract invocation
     *
     * @example
     * ```typescript
     * const route = await client.getRoute('XLM', 'sXLM', 1000000);
     * // Use route.calldata to build Soroban transaction
     * ```
     */
    async getRoute(inToken: string, outToken: string, inAmount: number): Promise<RouteResponse> {
        // Validate same as quote
        if (!['XLM', 'sXLM'].includes(inToken)) {
            throw new Error('inToken must be "XLM" or "sXLM"');
        }
        if (!['XLM', 'sXLM'].includes(outToken)) {
            throw new Error('outToken must be "XLM" or "sXLM"');
        }
        if (inToken === outToken) {
            throw new Error('inToken and outToken must be different');
        }

        return this.get<RouteResponse>('/dex/route', {
            inToken,
            outToken,
            inAmount,
        });
    }

    /**
     * Get information about available liquidity pools
     *
     * @returns List of available pools and their reserve information
     *
     * @example
     * ```typescript
     * const pools = await client.getPools();
     * ```
     */
    async getPools(): Promise<PoolsResponse> {
        return this.get<PoolsResponse>('/dex/pools');
    }

    // ============ Liquidity Mining ============

    /**
     * Get current liquidity mining APR (Annual Percentage Rate)
     *
     * @returns Current mining APR as percentage
     *
     * @example
     * ```typescript
     * const mining = await client.getMiningApr();
     * console.log(`Earn ${mining.apr}% APR on LP tokens`);
     * ```
     */
    async getMiningApr(): Promise<MiningAprResponse> {
        return this.get<MiningAprResponse>('/mining/apr');
    }

    /**
     * Get rewards for a wallet address
     *
     * Returns staked amount, claimed rewards, and pending rewards.
     *
     * @param walletAddress Stellar wallet address
     * @returns Rewards data for the wallet
     *
     * @example
     * ```typescript
     * const rewards = await client.getRewards('GXXX...');
     * console.log(`Staked: ${rewards.staked} LP tokens`);
     * console.log(`Pending: ${rewards.pending} sXLM`);
     * ```
     */
    async getRewards(walletAddress: string): Promise<RewardsResponse> {
        if (!walletAddress || walletAddress.length !== 56) {
            throw new Error('Invalid Stellar wallet address');
        }

        return this.get<RewardsResponse>('/mining/rewards', {
            wallet: walletAddress,
        });
    }

    /**
     * Get liquidity mining leaderboard
     *
     * Returns top liquidity miners by staked amount.
     *
     * @param limit Number of entries (default: 10, max: 100)
     * @returns Leaderboard with ranked positions
     *
     * @example
     * ```typescript
     * const lb = await client.getLeaderboard(10);
     * lb.leaderboard.forEach(entry => {
     *   console.log(`#${entry.rank}: ${entry.wallet} - ${entry.staked} LP tokens`);
     * });
     * ```
     */
    async getLeaderboard(limit: number = 10): Promise<LeaderboardResponse> {
        if (limit < 1 || limit > 100) {
            throw new Error('limit must be between 1 and 100');
        }

        return this.get<LeaderboardResponse>('/mining/leaderboard', {
            limit,
        });
    }
}

export default StelloClient;

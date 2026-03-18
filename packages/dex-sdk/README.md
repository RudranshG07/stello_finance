# @stello/dex-sdk

Official TypeScript SDK for integrating with the Stello Finance DEX

## Installation

```bash
npm install @stello/dex-sdk @stellar/stellar-sdk
# or
yarn add @stello/dex-sdk @stellar/stellar-sdk
# or
pnpm add @stello/dex-sdk @stellar/stellar-sdk
```

## Quick Start

```typescript
import { StelloClient } from '@stello/dex-sdk';

const client = new StelloClient({
    apiUrl: 'https://api.stello.finance',
});

// Get TWAP price
const twapPrice = await client.getTwapPrice(1800); // 30-minute TWAP
console.log(`sXLM/XLM: ${twapPrice.price}`);

// Get a swap quote
const quote = await client.getQuote('XLM', 'sXLM', 1_000_000);
console.log(`Output: ${quote.outAmount} sXLM`);
console.log(`Price Impact: ${quote.priceImpact}%`);

// Get optimal route with pre-built calldata
const route = await client.getRoute('XLM', 'sXLM', 1_000_000);
console.log(`Contract: ${route.lpPoolContractId}`);
```

## Features

### 🔮 TWAP Oracle

Time-weighted average prices for sXLM/XLM pair. The TWAP is manipulation-resistant and suitable for on-chain oracle usage.

```typescript
// 30-minute TWAP
const twap = await client.getTwapPrice(1800);

// Custom window
const hourlyTwap = await client.getTwapPrice(3600);
```

### 💱 Swap Quotes

Get accurate swap quotes including slippage and price impact.

```typescript
const quote = await client.getQuote('XLM', 'sXLM', 1_000_000);
// {
//   outAmount: 950_000,
//   priceImpact: 0.5284,
//   minOutAmount: 944_750,
//   executionPrice: 1.0526,
//   ...
// }
```

### 🛣️ Routing

Get optimal swap paths with pre-built transaction calldata.

```typescript
const route = await client.getRoute('XLM', 'sXLM', 1_000_000);
const calldata = route.calldata; // Ready for contract invocation
```

### 💎 Liquidity Mining

Earn rewards by staking LP tokens.

```typescript
// Check mining APR
const mining = await client.getMiningApr();
console.log(`Current APR: ${mining.apr}%`);

// Check your rewards
const rewards = await client.getRewards('G...');
console.log(`Pending: ${rewards.pending} sXLM`);

// Leaderboard
const lb = await client.getLeaderboard(10);
```

## Configuration

### Constructor Options

```typescript
interface StelloClientConfig {
    apiUrl: string;        // Required: API endpoint
    apiKey?: string;       // Optional: API key for rate limiting
    timeout?: number;      // Optional: Request timeout in ms (default: 10000)
}

const client = new StelloClient({
    apiUrl: 'https://api.stello.finance',
    apiKey: 'sk_live_xxx',
    timeout: 15000,
});
```

## Error Handling

All methods throw errors on failure. Always wrap in try-catch:

```typescript
try {
    const quote = await client.getQuote('XLM', 'sXLM', 1_000_000);
} catch (error) {
    console.error('Quote failed:', error.message);
}
```

## Common Use Cases

### Building a Swap UI

```typescript
async function executeSwap(walletAddress, inToken, outToken, inAmount) {
    // 1. Get quote
    const quote = await client.getQuote(inToken, outToken, inAmount);
    
    // 2. Display to user
    console.log(`You will receive: ${quote.outAmount}`);
    console.log(`Price Impact: ${quote.priceImpact}%`);
    
    // 3. User approves, get route
    const route = await client.getRoute(inToken, outToken, inAmount);
    
    // 4. Sign and submit transaction using Freighter
    // (See examples for Soroban transaction building)
}
```

### Displaying Pool Data

```typescript
async function displayPoolInfo() {
    const pools = await client.getPools();
    
    pools.pools.forEach(pool => {
        console.log(`Pool: ${pool.name}`);
        console.log(`  Type: XLM/sXLM`);
        console.log(`  Reserve XLM: ${pool.reserves.xlm}`);
        console.log(`  Reserve sXLM: ${pool.reserves.sxlm}`);
        console.log(`  Fee: ${pool.feeBps} bps`);
    });
}
```

### On-Chain Oracle Integration

```typescript
async function getOraclePrice() {
    // Get manipulation-resistant TWAP
    const twap = await client.getTwapPrice(1800);
    
    // Verify data is fresh
    const updatedAt = new Date(twap.updatedAt);
    const staleness = (Date.now() - updatedAt.getTime()) / 1000;
    
    if (staleness > 300) {
        throw new Error('TWAP price is stale');
    }
    
    return twap.price;
}
```

## API Reference

### getTwapPrice(windowSeconds?)

Get TWAP price for sXLM/XLM over a time window.

- **Parameters:**
  - `windowSeconds` (number, optional, default: 1800): Time window in seconds
- **Returns:** `Promise<TwapPriceResponse>`
- **Throws:** Error if window < 60 seconds or insufficient data

### getQuote(inToken, outToken, inAmount)

Get a swap quote.

- **Parameters:**
  - `inToken` (string): 'XLM' or 'sXLM'
  - `outToken` (string): 'XLM' or 'sXLM'
  - `inAmount` (number): Amount in stroops (1 XLM = 1e7 stroops)
- **Returns:** `Promise<QuoteResponse>`
- **Throws:** Error if invalid parameters

### getRoute(inToken, outToken, inAmount)

Get optimal swap route with calldata.

- **Parameters:** Same as `getQuote`
- **Returns:** `Promise<RouteResponse>`
- **Throws:** Error if no route available

### getPools()

Get available liquidity pools.

- **Returns:** `Promise<PoolsResponse>`

### getMiningApr()

Get current mining APR.

- **Returns:** `Promise<MiningAprResponse>`

### getRewards(walletAddress)

Get rewards for a wallet.

- **Parameters:**
  - `walletAddress` (string): Stellar wallet address (starting with 'G')
- **Returns:** `Promise<RewardsResponse>`

### getLeaderboard(limit?)

Get mining leaderboard.

- **Parameters:**
  - `limit` (number, optional, default: 10, max: 100): Number of entries
- **Returns:** `Promise<LeaderboardResponse>`

## Types

All response types are exported:

```typescript
import {
    TwapPriceResponse,
    QuoteResponse,
    RouteResponse,
    PoolInfo,
    RewardsResponse,
    MiningAprResponse,
} from '@stello/dex-sdk';
```

## Examples

See the [examples](./examples) directory for complete working examples:

- `swap-ui.ts` - Building a swap UI
- `oracle-integration.ts` - On-chain oracle usage
- `liquidity-mining.ts` - Accessing mining rewards
- `portfolio-tracker.ts` - Tracking LP positions

## Rate Limiting

The API has rate limits. Use the `apiKey` parameter to get higher limits:

```typescript
const client = new StelloClient({
    apiUrl: 'https://api.stello.finance',
    apiKey: 'sk_live_xxx', // Get from https://stello.finance/developers
});
```

## Support

- 📚 [Full Documentation](https://docs.stello.finance)
- 💬 [Discord](https://discord.gg/stello)
- 🐛 [Issue Tracker](https://github.com/stello-finance/stello/issues)
- 📧 [Email Support](mailto:support@stello.finance)

## License

MIT

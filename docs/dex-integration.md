# Stello Finance DEX Integration Guide

**Last Updated:** March 17, 2026

Welcome! This guide helps developers integrate the Stello Finance DEX into their applications. We provide a TWAP oracle, swap functionality, and liquidity mining rewards.

---

## 📚 Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [TWAP Oracle](#twap-oracle)
4. [Swap Integration](#swap-integration)
5. [Liquidity Mining](#liquidity-mining-program)
6. [Error Handling](#error-handling)
7. [Best Practices](#best-practices)
8. [Examples](#examples)
9. [Support](#support)

---

## Overview

Stello Finance provides:

- **TWAP Oracle**: Manipulation-resistant sXLM/XLM price feed
- **DEX Integration**: Direct XLM ↔ sXLM swaps with 0.3% fees
- **Liquidity Mining**: Stake LP tokens to earn sXLM rewards

### Architecture

```
┌─────────────────────────────────────────┐
│   Your Application / Smart Contract      │
├─────────────────────────────────────────┤
│  @stello/dex-sdk (npm package)          │
│  or REST API (https://api.stello.finance)
├─────────────────────────────────────────┤
│  Stello Backend Services                 │
│  - TWAP Oracle                          │
│  - DEX Routes / Quote Engine            │
│  - Mining Program                       │
├─────────────────────────────────────────┤
│  Soroban Smart Contracts                 │
│  - lp-pool (swap, liquidity)            │
│  - liquidity-mining (rewards)           │
└─────────────────────────────────────────┘
```

---

## Getting Started

### Setup

**Option 1: Using the SDK (Recommended)**

```bash
npm install @stello/dex-sdk @stellar/stellar-sdk
```

```typescript
import { StelloClient } from '@stello/dex-sdk';

const client = new StelloClient({
    apiUrl: 'https://api.stello.finance', // Production
    // apiUrl: 'https://testnet-api.stello.finance', // Testnet
});
```

**Option 2: Direct REST API**

```bash
curl https://api.stello.finance/dex/oracle/price?window=1800
```

### Environment

**Mainnet:**
- API: `https://api.stello.finance`
- Network: Public Global Stellar Network ; September 2015
- RPC: `https://mainnet.sorobanrpc.com`

**Testnet:**
- API: `https://testnet-api.stello.finance`
- Network: Test SDF Network ; September 2015
- RPC: `https://soroban-testnet.stellar.org`

---

## TWAP Oracle

### What is TWAP?

TWAP (Time-Weighted Average Price) is a manipulation-resistant price floor. It calculates the average sXLM/XLM price over a time window, preventing flash loan attacks and price manipulation.

**Formula:**
```
TWAP = (price0_cumulative_new - price0_cumulative_old) / elapsed_seconds
```

The contract accumulates prices every block and tracks timestamps. Be the oracle read the cumulative price and elapsed time, it can calculate any historical TWAP.

### Usage

```typescript
// Get 30-minute TWAP (default)
const twap = await client.getTwapPrice();

// Get 1-hour TWAP
const hourlyTwap = await client.getTwapPrice(3600);

// Custom window
const customTwap = await client.getTwapPrice(7200);

// Response:
// {
//   price: 1.0456,  // 1 sXLM = 1.0456 XLM
//   currency: 'sXLM/XLM',
//   windowSeconds: 1800,
//   dataPoints: 42,  // samples in window
//   updatedAt: '2026-03-17T12:34:56Z',
//   priceType: 'twap'
// }
```

### Use Cases

#### Lending Protocol Collateral Valuation

```typescript
async function getLoanCollateralValue(sxlmAmount) {
    const twap = await client.getTwapPrice(3600); // 1-hour TWAP
    
    // Value = sXLM amount × price (in XLM)
    const xlmValue = sxlmAmount * twap.price;
    
    // Apply haircut (e.g., 10%) for safety
    const collateralValue = xlmValue * 0.9;
    
    return { xlmValue, collateralValue };
}
```

#### Liquidation Threshold

```typescript
async function shouldLiquidate(position) {
    const twap = await client.getTwapPrice(1800);
    
    const collateralValue = position.sxlmAmount * twap.price;
    const debtValue = position.xlmBorrowed;
    
    // Liquidate if health factor < 1.0
    const healthFactor = collateralValue / debtValue;
    
    return healthFactor < 1.0;
}
```

#### Price Feed for Smart Contracts

```typescript
// On-chain: Use TWAP as price oracle
// Off-chain: Verify freshness and use for calculations

async function verifyTwapFreshness(maxStalenessSeconds = 300) {
    const twap = await client.getTwapPrice();
    const updatedAt = new Date(twap.updatedAt);
    const staleness = (Date.now() - updatedAt.getTime()) / 1000;
    
    if (staleness > maxStalenessSeconds) {
        throw new Error(`TWAP is stale: ${staleness}s old`);
    }
    
    return twap.price;
}
```

### Error Handling

```typescript
try {
    const twap = await client.getTwapPrice(1800);
} catch (error) {
    if (error.message.includes('Insufficient TWAP data')) {
        console.warn('Not enough price history; try shorter window');
    } else if (error.message.includes('503')) {
        console.error('Oracle service temporarily unavailable');
    } else {
        console.error('Unexpected error:', error);
    }
}
```

---

## Swap Integration

### How TWAP Protection Works

Every swap updates the price accumulators in the lp-pool contract:

1. **Before swap:** Contract reads current cumulative price
2. **Execute swap:** AMM formula calculates output
3. **After swap:** Contract updates cumulative price + timestamp
4. **Off-chain:** TWAP service polls and saves snapshots

This means **sandwiching attacks cannot move the TWAP**.

### Getting Quotes

```typescript
// Quote 1 XLM (1e7 stroops) for sXLM
const quote = await client.getQuote('XLM', 'sXLM', 10_000_000);

// Response:
// {
//   inToken: 'XLM',
//   outToken: 'sXLM',
//   inAmount: 10_000_000,
//   outAmount: 9_530_000,              // After 0.3% fee
//   fee: 30_000,
//   priceImpact: 0.5284,              // % impact on pool prices
//   executionPrice: 1.0492,           // Price if execute now
//   spotPrice: 1.0492,
//   minOutAmount: 9_482_250,          // With 0.5% slippage
//   slippageToleranceBps: 50,         // 0.5%
//   twapPrice: 1.0456,                // Reference TWAP
//   lpFee: 30,                        // 30 bps
// }
```

### Swap Routing

```typescript
// Get optimal path + pre-built calldata
const route = await client.getRoute('XLM', 'sXLM', 10_000_000);

// Response includes:
// {
//   path: ['XLM', 'sXLM'],
//   hops: 1,                          // Direct swap
//   lpPoolContractId: 'CAW2...',
//   quote: { ... },                   // Same as quote API
//   calldata: {
//     function: 'swap_xlm_to_sxlm',
//     args: { amount: 10_000_000, minOut: 9_482_250 }
//   }
// }
```

### Building a Swap Transaction

```typescript
import * as StellarSdk from '@stellar/stellar-sdk';

async function buildSwapTx(sourceWallet, amountIn) {
    // 1. Connect to Freighter
    const publicKey = await window.freighter.signTransaction(sourceWallet);
    const server = new StellarSdk.SorobanRpc.Server(
        'https://mainnet.sorobanrpc.com'
    );
    
    // 2. Get route/calldata
    const route = await client.getRoute('XLM', 'sXLM', amountIn);
    
    // 3. Build swap operation
    const sourceAccount = await server.getAccount(sourceWallet);
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.PUBLIC_NETWORK_PASSPHRASE,
    })
        .addOperation(
            StellarSdk.Operation.invokeHostFunction({
                hostFunction: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
                    StellarSdk.xdr.InvokeContractArgs.new({
                        contractAddress: StellarSdk.Address.fromString(
                            route.lpPoolContractId
                        ).toXdrObject(),
                        functionName: StellarSdk.scVal.nativeToScVal(route.calldata.function),
                        args: StellarSdk.xdr.ScVal.scValTypeVec([
                            // user address
                            // amount
                            // minOut
                        ]),
                    })
                ),
                builtinData: StellarSdk.xdr.BuiltinData.builtinDataManagedData(
                    new StellarSdk.xdr.ManagedDataEntry()
                ),
            })
        )
        .setTimeout(300)
        .build();
    
    // 4. Sign with Freighter and submit
    return await window.freighter.signTransaction(tx);
}
```

### Slippage Protection

Always use `minOutAmount` from quote:

```typescript
async function executeSwap(amountIn) {
    const quote = await client.getQuote('XLM', 'sXLM', amountIn);
    
    // minOutAmount = expected output - slippage tolerance
    // If actual output < minOutAmount, transaction reverts
    
    const minOut = quote.minOutAmount; // Safe protection
    
    // OR: Custom slippage
    const customSlippage = quote.outAmount * 0.98; // 2% custom
    
    return { minOut, customSlippage };
}
```

---

## Liquidity Mining Program

### How It Works

1. **Stake LP tokens** → Earn sXLM rewards
2. **Rewards accrue** every block based on `reward_rate` (governance-controlled)
3. **Claim anytime** without unstaking
4. **Unstake** to remove position and claim all pending rewards

### APR Calculation

```
APR = (reward_rate_per_second × 31,536,000 seconds/year) / total_staked_lp_tokens × 100%
```

Example:
- reward_rate = 1,000 sXLM/second
- total_staked = 10,000,000 LP tokens
- APR = (1,000 × 31,536,000) / 10,000,000 = ~315%

### APIs

```typescript
// Get current mining APR
const apr = await client.getMiningApr();
// => { apr: 315.36, timestamp: '2026-03-17T12:34:56Z' }

// Get wallet rewards
const rewards = await client.getRewards('GXXX...');
// => {
//   wallet: 'GXXX...',
//   staked: '1000000',        // LP tokens
//   totalClaimed: '500000',   // sXLM
//   pending: '125000'         // Unclaimed sXLM
// }

// Get leaderboard
const lb = await client.getLeaderboard(10);
// => [
//   { rank: 1, wallet: 'GABC...', staked: '50000000', totalClaimed: '2500000' },
//   ...
// ]
```

### User Journey

```typescript
async function stakeLPTokens() {
    // 1. User approves LP token transfer
    // 2. Backend builds stake transaction (unsigned)
    const tx = await fetch('/mining/stake', {
        method: 'POST',
        body: JSON.stringify({ amount: 1_000_000 })
    }).then(r => r.json());
    
    // 3. User signs with Freighter
    const signed = await window.freighter.signTransaction(tx.xdr);
    
    // 4. Submit transaction
    const result = await submitToSoroban(signed);
    
    if (result.success) {
        // 5. Rewards start accruing immediately
        const rewards = await client.getRewards(wallet);
        console.log(`Earning ${rewards.pending} sXLM!`);
    }
}
```

---

## Error Handling

### HTTP Status Codes

```
200 OK              - Successful request
400 Bad Request     - Invalid parameters
401 Unauthorized    - Missing API key
429 Too Many Req    - Rate limited (use API key)
503 Service Unavail - Insufficient data or maintenance
```

### Handling Errors

```typescript
async function safeQuote(inToken, outToken, amount) {
    try {
        const quote = await client.getQuote(inToken, outToken, amount);
        return quote;
    } catch (error) {
        if (error.message.includes('400')) {
            console.error('Invalid parameters:', error);
        } else if (error.message.includes('503')) {
            console.error('Pool has insufficient liquidity');
        } else if (error.message.includes('Timeout')) {
            console.error('Request timeout - try again');
        }
    }
}
```

### Rate Limiting

Default: 100 requests/minute per IP  
With API key: 10,000 requests/minute

```typescript
const client = new StelloClient({
    apiUrl: 'https://api.stello.finance',
    apiKey: process.env.STELLO_API_KEY,
});
```

---

## Best Practices

### 1. Verify TWAP Freshness

```typescript
async function getVerifiedPrice() {
    const twap = await client.getTwapPrice(1800);
    
    const updatedAt = new Date(twap.updatedAt);
    const staleness = (Date.now() - updatedAt.getTime()) / 1000;
    
    if (staleness > 5 * 60) { // 5 minutes
        throw new Error('Price data is stale');
    }
    
    return twap.price;
}
```

### 2. Always Use Min Output

```typescript
// ❌ WRONG: Unsafe
await executeSwap(amount);

// ✓ CORRECT: Protected
const quote = await client.getQuote(inToken, outToken, amount);
await executeSwap(amount, quote.minOutAmount);
```

### 3. Cache Quotes Briefly

```typescript
const cache = new Map();

async function getCachedQuote(inToken, outToken, amount, maxAge = 5000) {
    const key = `${inToken}/${outToken}/${amount}`;
    const cached = cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < maxAge) {
        return cached.quote;
    }
    
    const quote = await client.getQuote(inToken, outToken, amount);
    cache.set(key, { quote, timestamp: Date.now() });
    
    return quote;
}
```

### 4. Handle Ledger Costs

Each Soroban transaction costs:
- Base: 100 stroops
- ResourceFee: varies (usually 100-1000 stroops)

```typescript
const ESTIMATED_FEE = 5000; // stroops

async function balanceCheck(wallet, swapAmount) {
    const balance = await getXLMBalance(wallet);
    
    const minRequired = swapAmount + ESTIMATED_FEE;
    
    if (balance < minRequired) {
        throw new Error(
            `Insufficient balance. Need: ${minRequired}, Have: ${balance}`
        );
    }
}
```

### 5. Batch Requests

```typescript
// ❌ Slow: Sequential
const quote1 = await client.getQuote('XLM', 'sXLM', 100);
const quote2 = await client.getQuote('sXLM', 'XLM', 100);

// ✓ Fast: Parallel
const [quote1, quote2] = await Promise.all([
    client.getQuote('XLM', 'sXLM', 100),
    client.getQuote('sXLM', 'XLM', 100),
]);
```

---

## Examples

### Example 1: On-Chain Oracle Integration

```typescript
// Use TWAP as price feed for smart contracts

async function getPriceFeedForContract() {
    const twap = await client.getTwapPrice(3600); // 1-hour window
    
    // Verify freshness
    const maxAge = 600; // 10 minutes
    const age = (Date.now() - new Date(twap.updatedAt).getTime()) / 1000;
    
    if (age > maxAge) {
        throw new Error('Oracle data is stale');
    }
    
    // Return scaled price for contract (e.g., 1e8 = 1)
    const scaledPrice = Math.floor(twap.price * 1e8);
    
    return {
        price: scaledPrice,
        timestamp: Date.now(),
        window: twap.windowSeconds,
    };
}
```

### Example 2: Swap UI

```typescript
import React, { useState } from 'react';
import { StelloClient } from '@stello/dex-sdk';

export function SwapWidget() {
    const [inAmount, setInAmount] = useState('');
    const [outAmount, setOutAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const client = new StelloClient({ apiUrl: 'https://api.stello.finance' });

    async function handleQuote() {
        setLoading(true);
        try {
            const quote = await client.getQuote('XLM', 'sXLM', parseFloat(inAmount) * 1e7);
            setOutAmount((quote.outAmount / 1e7).toFixed(7));
        } finally {
            setLoading(false);
        }
    }

    return (
        <div>
            <input value={inAmount} onChange={(e) => setInAmount(e.target.value)} />
            <button onClick={handleQuote}>Get Quote</button>
            <span>{loading ? 'Loading...' : outAmount}</span>
        </div>
    );
}
```

### Example 3: Lending Protocol Liquidation

```typescript
async function checkLiquidationCondition(position) {
    // Get TWAP price with safety margin
    const twap = await client.getTwapPrice(1800);
    
    // Calculate health factor
    const collateralValue = position.sxlmAmount * twap.price;
    const debtValue = position.xlmBorrowed;
    const healthFactor = collateralValue / debtValue;
    
    // Liquidate if health factor below threshold
    const LIQUIDATION_THRESHOLD = 1.1;
    
    if (healthFactor < LIQUIDATION_THRESHOLD) {
        return {
            shouldLiquidate: true,
            reason: `Health factor ${healthFactor.toFixed(2)} < ${LIQUIDATION_THRESHOLD}`,
            collateral: position.sxlmAmount,
            debt: position.xlmBorrowed,
        };
    }
    
    return { shouldLiquidate: false };
}
```

---

## Support

### Resources

- 📖 [Full Documentation](https://docs.stello.finance)
- 💬 [Discord Community](https://discord.gg/stello)
- 🐛 [GitHub Issues](https://github.com/stello-finance/stello/issues)
- 📧 [Developers Email](mailto:developers@stello.finance)

### Rate Limits

- Standard: 100 req/min per IP
- With API Key: 10,000 req/min
- Get API key: https://stello.finance/developers

### Testnet

Deploy to testnet first for testing:

```typescript
const testClient = new StelloClient({
    apiUrl: 'https://testnet-api.stello.finance',
});

const testTwap = await testClient.getTwapPrice(1800);
```

---

**Last Updated:** March 17, 2026  
**SDK Version:** 0.1.0+  
**Contract Versions:** All current

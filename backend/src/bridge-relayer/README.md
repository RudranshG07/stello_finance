# Bridge Relayer Retry Queue

This directory contains the bridge relayer system with enhanced retry capabilities for handling failed cross-chain operations.

## Overview

The bridge relayer handles cross-chain operations between Stellar and EVM chains (Ethereum, Arbitrum, Sepolia). When operations fail due to network issues, temporary outages, or other transient problems, they are automatically retried with exponential backoff.

## Components

### Core Files

- **`index.ts`** - Main relayer implementation with retry queue integration
- **`retry-queue.ts`** - Redis-based retry queue with exponential backoff
- **`wsxlm-abi.ts`** - EVM contract ABI for wsXLM token
- **`README.md`** - This documentation

### Key Features

#### Retry Queue System
- **Exponential Backoff**: Failed operations are retried with increasing delays
- **Dead Letter Queue**: Operations that exceed max attempts are moved to DLQ for manual inspection
- **Configurable Settings**: Max attempts, backoff multiplier, delays are all configurable
- **Statistics**: Real-time monitoring of queue status and processing metrics

#### Error Handling
- Automatic retry for both EVM→Stellar and Stellar→EVM operations
- Detailed error logging with context
- Graceful degradation during network issues

## Configuration

### Environment Variables

```bash
# Core bridge configuration
BRIDGE_CONTRACT_ID=your_bridge_contract_id
RELAYER_STELLAR_SECRET=your_stellar_secret_key
RELAYER_EVM_PRIVATE_KEY=your_evm_private_key

# EVM chain configurations
ETH_RPC_URL=https://mainnet.infura.io/v3/your-key
ETH_WSXLM_ADDRESS=0x...
ARB_RPC_URL=https://arbitrum.infura.io/v3/your-key
ARB_WSXLM_ADDRESS=0x...
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/your-key
SEPOLIA_WSXLM_ADDRESS=0x...

# Retry queue configuration
REDIS_URL=redis://localhost:6379
POLL_INTERVAL_MS=5000
RETRY_PROCESS_INTERVAL_MS=10000

# Stellar configuration
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK=mainnet|testnet
```

### Retry Queue Settings

The retry queue can be configured with these parameters:

```typescript
{
  maxAttempts: 5,           // Maximum retry attempts before DLQ
  backoffMultiplier: 2,     // Exponential backoff multiplier
  initialDelayMs: 2000,    // Initial retry delay
  maxDelayMs: 300000,      // Maximum delay (5 minutes)
}
```

## Usage

### Running the Relayer

```bash
# Install dependencies
npm install

# Start the relayer
npm run dev
```

### Monitoring

The relayer provides real-time statistics:

```bash
# Example output
[retry-queue] stats: { pending: 2, deadLetter: 0, processing: false }
```

### Manual Recovery

Failed operations can be manually recovered from the dead letter queue:

```typescript
// Get failed items
const failedItems = await retryQueue.getDeadLetterItems();

// Requeue specific items
const requeued = await retryQueue.requeueFromDeadLetter([
  'item_id_1',
  'item_id_2'
]);
```

## Architecture

### Flow Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   EVM Chain     │    │   Stellar       │    │   Retry Queue   │
│                 │    │                 │    │                 │
│ Bridge Events   │───▶│   Relayer       │───▶│   Processing    │
│   Mint/Burn     │    │                 │    │                 │
│                 │    │                 │    │   Exponential   │
│                 │    │                 │    │   Backoff       │
│                 │    │                 │    │                 │
│                 │    │                 │    │   DLQ for       │
│                 │    │                 │    │   Failed Ops    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### Retry Logic

1. **Operation Fails** → Added to retry queue with initial delay
2. **Retry Attempt** → Processed when delay expires
3. **Success** → Removed from queue
4. **Failure** → Increment attempts, increase delay, reschedule
5. **Max Attempts** → Move to dead letter queue

## Testing

### Unit Tests

```bash
# Run retry queue tests
npm test -- bridge-retry-queue.test.ts

# Run all tests
npm test
```

### Test Coverage

- ✅ Queue operations (add, process, stats)
- ✅ Exponential backoff behavior
- ✅ Dead letter queue handling
- ✅ Manual recovery operations
- ✅ Error scenarios and edge cases

## Development

### Adding New Chains

To support additional EVM chains:

1. Add chain configuration to `EVM_CHAINS` object
2. Update `validate_chain_id()` function
3. Deploy wsXLM token contract on new chain
4. Add environment variables for RPC URL and token address

### Monitoring Integration

The retry queue can be integrated with monitoring systems:

```typescript
// Custom monitoring
retryQueue.on('itemProcessed', (item) => {
  // Send to metrics system
});

retryQueue.on('itemFailed', (item, error) => {
  // Alert on critical failures
});
```

## Security Considerations

- Private keys are stored in environment variables only
- Redis connection should use authentication in production
- All operations are logged for audit trails
- Rate limiting prevents abuse
- Input validation on all external data

## Troubleshooting

### Common Issues

1. **Redis Connection Failed**
   - Check REDIS_URL configuration
   - Verify Redis server is running
   - Check network connectivity

2. **High Retry Queue Size**
   - Check network connectivity to EVM/Stellar nodes
   - Verify contract addresses are correct
   - Check relayer key permissions

3. **Frequent Timeouts**
   - Increase timeout values
   - Check RPC endpoint performance
   - Consider using faster RPC providers

### Debug Mode

Enable debug logging:

```bash
DEBUG=bridge:* npm run dev
```

## Contributing

When contributing to the retry queue system:

1. Add comprehensive tests for new features
2. Update documentation for configuration changes
3. Ensure backward compatibility
4. Test with both mainnet and testnet configurations

## License

This code is part of the Stello Finance protocol and follows the project's license terms.

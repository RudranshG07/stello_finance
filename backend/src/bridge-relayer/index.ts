import {
  Contract,
  Keypair,
  Networks,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
  StrKey,
} from "@stellar/stellar-sdk";
import { ethers } from "ethers";
import { Redis } from "ioredis";
import { WSXLM_ABI } from "./wsxlm-abi.js";
import { RetryQueue } from "./retry-queue.js";

// ---------- Config ----------

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const STELLAR_NETWORK =
  process.env.STELLAR_NETWORK === "mainnet"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const BRIDGE_CONTRACT_ID = process.env.BRIDGE_CONTRACT_ID!;
const RELAYER_STELLAR_SECRET = process.env.RELAYER_STELLAR_SECRET!;

// EVM config per chain
const EVM_CHAINS: Record<
  number,
  { rpcUrl: string; wsxlmAddress: string }
> = {
  1: {
    rpcUrl: process.env.ETH_RPC_URL ?? "",
    wsxlmAddress: process.env.ETH_WSXLM_ADDRESS ?? "",
  },
  42161: {
    rpcUrl: process.env.ARB_RPC_URL ?? "",
    wsxlmAddress: process.env.ARB_WSXLM_ADDRESS ?? "",
  },
  11155111: {
    rpcUrl: process.env.SEPOLIA_RPC_URL ?? "",
    wsxlmAddress: process.env.SEPOLIA_WSXLM_ADDRESS ?? "",
  },
};

const RELAYER_EVM_PRIVATE_KEY = process.env.RELAYER_EVM_PRIVATE_KEY!;

// Redis connection for retry queue
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(REDIS_URL);

// Polling interval in ms
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "5000");
const RETRY_PROCESS_INTERVAL_MS = parseInt(process.env.RETRY_PROCESS_INTERVAL_MS ?? "10000");

// ---------- Types ----------

interface BridgeInitiatedEvent {
  sender: string;       // Stellar address (G...)
  evmRecipient: string; // hex EVM address (0x...)
  amount: bigint;       // in stroops (7 decimals)
  nonce: bigint;
  targetChainId: number;
  ledger: number;
  txHash: string;       // Stellar transaction hash
}

interface BridgeBackEvent {
  stellarRecipient: string; // Stellar address (G...)
  amount: bigint;
  evmTxHash: string;        // 0x-prefixed EVM tx hash
  sourceChainId: number;
}

// ---------- Soroban event listener ----------

class SorobanListener {
  private server: SorobanRpc.Server;
  private lastLedger: number = 0;

  constructor() {
    this.server = new SorobanRpc.Server(SOROBAN_RPC_URL, {
      allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
    });
  }

  async getLatestLedger(): Promise<number> {
    const info = await this.server.getLatestLedger();
    return info.sequence;
  }

  /**
   * Poll Soroban for bridge_to_evm events emitted by the bridge contract.
   * Returns all new BridgeInitiated events since last poll.
   */
  async pollBridgeEvents(): Promise<BridgeInitiatedEvent[]> {
    const latestLedger = await this.getLatestLedger();
    if (this.lastLedger === 0) {
      // First run — start from current ledger, don't replay old events
      this.lastLedger = latestLedger;
      return [];
    }
    if (latestLedger <= this.lastLedger) {
      return [];
    }

    const events: BridgeInitiatedEvent[] = [];

    try {
      const response = await this.server.getEvents({
        startLedger: this.lastLedger + 1,
        filters: [
          {
            type: "contract",
            contractIds: [BRIDGE_CONTRACT_ID],
            topics: [
              // topic1 = "bridge", topic2 = "evm"
              [
                xdr.ScVal.scvSymbol("bridge").toXDR("base64"),
                xdr.ScVal.scvSymbol("evm").toXDR("base64"),
              ],
            ],
          },
        ],
      });

      for (const event of response.events) {
        try {
          const parsed = this.parseBridgeEvent(event);
          if (parsed) events.push(parsed);
        } catch (err) {
          console.error("[soroban] failed to parse event:", err);
        }
      }
    } catch (err) {
      console.error("[soroban] getEvents error:", err);
    }

    this.lastLedger = latestLedger;
    return events;
  }

  private parseBridgeEvent(event: any): BridgeInitiatedEvent | null {
    // Event value is the BridgeInitiatedEvent struct serialized as ScVal map
    const val = xdr.ScVal.fromXDR(event.value, "base64");
    if (val.switch() !== xdr.ScValType.scvMap()) return null;

    const map = val.map()!;
    const get = (key: string) =>
      map.find((e) => e.key().sym().toString() === key)?.val();

    const sender = get("sender")?.address()?.accountId()?.ed25519()
      ? /* decode to G... */ ""
      : "";
    const evmRecipientBytes = get("evm_recipient")?.bytes();
    const amount = get("amount")?.i128();
    const nonce = get("nonce")?.u64();
    const targetChainId = get("target_chain_id")?.u32();

    if (!evmRecipientBytes || amount == null || nonce == null || targetChainId == null) {
      return null;
    }

    const evmRecipient =
      "0x" + Buffer.from(evmRecipientBytes).toString("hex");
    const amountBigInt = BigInt(amount.hi().toString()) * BigInt(2 ** 64) + BigInt(amount.lo().toString());
    const nonceBigInt = BigInt(nonce.toString());

    return {
      sender,
      evmRecipient,
      amount: amountBigInt,
      nonce: nonceBigInt,
      targetChainId,
      ledger: event.ledger,
      txHash: event.txHash,
    };
  }
}

// ---------- EVM minter ----------

class EvmMinter {
  private providers: Map<number, ethers.JsonRpcProvider> = new Map();
  private wallets: Map<number, ethers.Wallet> = new Map();
  private contracts: Map<number, ethers.Contract> = new Map();

  constructor() {
    for (const [chainId, cfg] of Object.entries(EVM_CHAINS)) {
      if (!cfg.rpcUrl || !cfg.wsxlmAddress) continue;
      const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
      const wallet = new ethers.Wallet(RELAYER_EVM_PRIVATE_KEY, provider);
      const contract = new ethers.Contract(cfg.wsxlmAddress, WSXLM_ABI, wallet);
      const id = parseInt(chainId);
      this.providers.set(id, provider);
      this.wallets.set(id, wallet);
      this.contracts.set(id, contract);
    }
  }

  /**
   * Mint wsXLM on the target EVM chain.
   * amount is in sXLM units (7 decimals on Stellar side).
   * wsXLM uses 18 decimals on EVM — we scale here.
   */
  async mint(
    chainId: number,
    recipient: string,
    stellarAmount: bigint,
    stellarTxHash: string
  ): Promise<string> {
    const contract = this.contracts.get(chainId);
    if (!contract) throw new Error(`no EVM config for chain ${chainId}`);

    // Scale from 7 decimals (Stellar) to 18 decimals (EVM)
    const evmAmount = stellarAmount * BigInt(10 ** 11);

    // stellarTxHash as bytes32 for replay protection on EVM side
    const txHashBytes = ethers.zeroPadValue("0x" + stellarTxHash, 32);

    console.log(
      `[evm] minting ${evmAmount.toString()} wsXLM to ${recipient} on chain ${chainId}`
    );

    const tx = await contract.mintFromStellar(recipient, evmAmount, txHashBytes);
    const receipt = await tx.wait();

    console.log(`[evm] mint confirmed: ${receipt.hash}`);
    return receipt.hash;
  }

  /**
   * Subscribe to BridgeBackInitiated events on all configured EVM chains.
   * Calls `onEvent` for each new event.
   */
  subscribeToEVMEvents(onEvent: (event: BridgeBackEvent) => Promise<void>) {
    for (const [chainId, contract] of this.contracts.entries()) {
      console.log(`[evm] subscribing to BridgeBackInitiated on chain ${chainId}`);
      contract.on(
        "BridgeBackInitiated",
        async (stellarAddress: string, amount: bigint, evmTxHash: string) => {
          const event: BridgeBackEvent = {
            stellarRecipient: stellarAddress,
            amount,
            evmTxHash,
            sourceChainId: chainId,
          };
          console.log("[evm] BridgeBackInitiated event:", event);
          try {
            await onEvent(event);
          } catch (err) {
            console.error("[evm] failed to process BridgeBackInitiated:", err);
          }
        }
      );
    }
  }
}

// ---------- Soroban release caller ----------

class SorobanReleaser {
  private server: SorobanRpc.Server;
  private keypair: Keypair;

  constructor() {
    this.server = new SorobanRpc.Server(SOROBAN_RPC_URL, {
      allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
    });
    this.keypair = Keypair.fromSecret(RELAYER_STELLAR_SECRET);
  }

  /**
   * Call bridge_adapter.release_from_evm on Soroban.
   * This mints sXLM to the Stellar recipient.
   */
  async releaseFromEvm(event: BridgeBackEvent): Promise<void> {
    const account = await this.server.getAccount(this.keypair.publicKey());

    const contract = new Contract(BRIDGE_CONTRACT_ID);

    // Scale from 18 decimals (EVM) to 7 decimals (Stellar)
    const stellarAmount = event.amount / BigInt(10 ** 11);

    const evmTxHashBytes = Buffer.from(
      event.evmTxHash.replace("0x", ""),
      "hex"
    );

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: STELLAR_NETWORK,
    })
      .addOperation(
        contract.call(
          "release_from_evm",
          xdr.ScVal.scvAddress(
            xdr.ScAddress.scAddressTypeAccount(
              xdr.PublicKey.publicKeyTypeEd25519(
                StrKey.decodeEd25519PublicKey(event.stellarRecipient)
              )
            )
          ),
          xdr.ScVal.scvI128(
            new xdr.Int128Parts({
              hi: xdr.Int64.fromString("0"),
              lo: xdr.Uint64.fromString(stellarAmount.toString()),
            })
          ),
          xdr.ScVal.scvBytes(evmTxHashBytes),
          xdr.ScVal.scvU32(event.sourceChainId)
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(this.keypair);

    const result = await this.server.sendTransaction(prepared);
    console.log(`[soroban] release_from_evm submitted: ${result.hash}`);

    // Poll for confirmation
    await this.waitForConfirmation(result.hash);
  }

  private async waitForConfirmation(hash: string, maxRetries = 20): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      await sleep(3000);
      const status = await this.server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        console.log(`[soroban] tx confirmed: ${hash}`);
        return;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`[soroban] tx failed: ${hash}`);
      }
    }
    throw new Error(`[soroban] tx confirmation timeout: ${hash}`);
  }
}

// ---------- Main relayer loop ----------

async function main() {
  console.log("[relayer] starting stello_finance bridge relayer");

  const sorobanListener = new SorobanListener();
  const evmMinter = new EvmMinter();
  const sorobanReleaser = new SorobanReleaser();
  const retryQueue = new RetryQueue(redis, {
    maxAttempts: 5,
    backoffMultiplier: 2,
    initialDelayMs: 2000,
    maxDelayMs: 300000, // 5 minutes
  });

  // Start retry queue processor
  const startRetryProcessor = async () => {
    while (true) {
      try {
        await retryQueue.process({
          evmToStellar: async (data) => {
            await sorobanReleaser.releaseFromEvm(data);
          },
          stellarToEvm: async (data) => {
            await evmMinter.mint(
              data.targetChainId,
              data.evmRecipient,
              data.amount,
              data.txHash
            );
          },
        });
      } catch (err) {
        console.error("[retry-processor] error:", err);
      }
      await sleep(RETRY_PROCESS_INTERVAL_MS);
    }
  };

  // Log retry queue stats periodically
  const logStats = async () => {
    const stats = await retryQueue.getStats();
    console.log(`[retry-queue] stats:`, stats);
  };

  // Start background processes
  startRetryProcessor();
  setInterval(logStats, 60000); // Log stats every minute

  // Subscribe to EVM → Stellar direction
  evmMinter.subscribeToEVMEvents(async (event) => {
    console.log("[relayer] processing EVM→Stellar bridge:", event);
    try {
      await sorobanReleaser.releaseFromEvm(event);
    } catch (err) {
      console.error("[relayer] failed to release on Soroban:", err);
      await retryQueue.add({
        type: "evm_to_stellar",
        data: event,
        maxAttempts: 5,
      });
    }
  });

  // Poll Soroban → EVM direction
  console.log("[relayer] polling Soroban events every", POLL_INTERVAL_MS, "ms");
  while (true) {
    try {
      const events = await sorobanListener.pollBridgeEvents();

      for (const event of events) {
        console.log("[relayer] processing Stellar→EVM bridge:", event);
        try {
          await evmMinter.mint(
            event.targetChainId,
            event.evmRecipient,
            event.amount,
            event.txHash
          );
        } catch (err) {
          console.error("[relayer] failed to mint on EVM:", err);
          await retryQueue.add({
            type: "stellar_to_evm",
            data: event,
            maxAttempts: 5,
          });
        }
      }
    } catch (err) {
      console.error("[relayer] poll error:", err);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[relayer] fatal error:", err);
  process.exit(1);
});
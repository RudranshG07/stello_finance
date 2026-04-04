import { PrismaClient } from "@prisma/client";
import { config } from "../config/index.js";
import { getEventBus, EventType } from "../event-bus/index.js";
import { xdr, scValToNative } from "@stellar/stellar-sdk";

import * as fs from "fs";
import * as path from "path";

let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastLedger = 0;

const LEDGER_STATE_FILE = path.join(process.cwd(), ".last_ledger");

interface RawSorobanEvent {
  type: string;
  ledger: number;
  contractId: string;
  topic: string[];
  value: string;
}

export class EventListenerService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    console.log("[EventListener] Initializing...");

    // Restore lastLedger from disk
    try {
      if (fs.existsSync(LEDGER_STATE_FILE)) {
        lastLedger = parseInt(fs.readFileSync(LEDGER_STATE_FILE, "utf-8").trim(), 10) || 0;
        console.log(`[EventListener] Restored lastLedger=${lastLedger} from disk`);
      }
    } catch {
      // Ignore read errors
    }

    pollInterval = setInterval(async () => {
      try {
        await this.pollContractEvents();
      } catch (err) {
        console.error("[EventListener] Poll error:", err);
      }
    }, 5_000);

    console.log("[EventListener] Initialized, polling every 5s");
  }

  async shutdown(): Promise<void> {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    console.log("[EventListener] Shut down");
  }

  private async pollContractEvents(): Promise<void> {
    try {
      const response = await fetch(config.stellar.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getEvents",
          params: {
            startLedger: lastLedger || undefined,
            filters: [
              {
                type: "contract",
                contractIds: [
                  config.contracts.stakingContractId,
                  config.contracts.sxlmTokenContractId,
                  config.contracts.lendingContractId,
                  config.contracts.lpPoolContractId,
                  config.contracts.governanceContractId,
                ].filter(Boolean),
              },
            ],
            pagination: { limit: 100 },
          },
        }),
      });

      if (!response.ok) return;

      const data = (await response.json()) as {
        result?: {
          events: RawSorobanEvent[];
          latestLedger: number;
        };
      };

      if (!data.result?.events) return;

      for (const event of data.result.events) {
        await this.processEvent(event);
        if (event.ledger > lastLedger) {
          lastLedger = event.ledger;
        }
      }

      if (data.result.latestLedger > lastLedger) {
        lastLedger = data.result.latestLedger;
      }

      // Persist lastLedger to disk for restart recovery
      try {
        fs.writeFileSync(LEDGER_STATE_FILE, String(lastLedger), "utf-8");
      } catch {
        // Ignore write errors
      }
    } catch {
      // Silently fail — will retry next poll
    }
  }

  /**
   * Decode a base64-encoded XDR ScVal string into a native JS value.
   */
  private decodeXdrValue(raw: string): unknown {
    try {
      const scVal = xdr.ScVal.fromXDR(raw, "base64");
      return scValToNative(scVal);
    } catch {
      // If decoding fails, return raw string
      return raw;
    }
  }

  /**
   * Decode a topic entry (base64 XDR ScSymbol → string).
   */
  private decodeTopicEntry(raw: string): string {
    try {
      const scVal = xdr.ScVal.fromXDR(raw, "base64");
      const native = scValToNative(scVal);
      return String(native);
    } catch {
      return raw;
    }
  }

  private async processEvent(event: RawSorobanEvent): Promise<void> {
    const eventBus = getEventBus();

    // Decode topic entries from XDR
    const topics = event.topic.map((t) => this.decodeTopicEntry(t));
    const topicName = topics[0] || "";
    const decoded = this.decodeXdrValue(event.value);

    if (topicName === "deposit" && event.contractId === config.contracts.stakingContractId) {
      const values = decoded as [string, bigint, bigint] | unknown;
      let wallet = "";
      let xlmAmount = BigInt(0);
      let sxlmMinted = BigInt(0);

      if (Array.isArray(values) && values.length >= 3) {
        wallet = String(values[0]);
        xlmAmount = BigInt(values[1]);
        sxlmMinted = BigInt(values[2]);
      }

      console.log(
        `[EventListener] Deposit: wallet=${wallet} xlm=${xlmAmount} sxlm=${sxlmMinted} ledger=${event.ledger}`
      );

      await eventBus.publish(EventType.STAKE_EXECUTED, {
        wallet,
        xlmAmount,
        sxlmMinted,
        txHash: `ledger:${event.ledger}`,
        timestamp: Date.now(),
      });

    } else if (topicName === "instant") {
      const values = decoded as [string, bigint] | unknown;
      let wallet = "";
      let xlmAmount = BigInt(0);

      if (Array.isArray(values) && values.length >= 2) {
        wallet = String(values[0]);
        xlmAmount = BigInt(values[1]);
      }

      console.log(
        `[EventListener] Instant withdrawal: wallet=${wallet} xlm=${xlmAmount} ledger=${event.ledger}`
      );

      // Update DB: mark withdrawal as completed
      if (wallet) {
        await this.prisma.withdrawal.updateMany({
          where: { wallet, status: "pending" },
          data: { status: "completed" },
        });
      }

      // Emit unstake event for delegation manager
      await eventBus.publish(EventType.UNSTAKE_EXECUTED, {
        wallet,
        xlmAmount,
        sxlmBurned: BigInt(0),
        txHash: `ledger:${event.ledger}`,
        timestamp: Date.now(),
      });

      await eventBus.publish(EventType.WITHDRAWAL_READY, {
        withdrawalId: 0,
        wallet,
        amount: xlmAmount,
        claimTxHash: `ledger:${event.ledger}`,
      });

    } else if (topicName === "delayed") {
      const values = decoded as [string, bigint, bigint, number] | unknown;
      let wallet = "";
      let xlmAmount = BigInt(0);
      let withdrawalId = 0;
      let unlockLedger = 0;

      if (Array.isArray(values) && values.length >= 4) {
        wallet = String(values[0]);
        xlmAmount = BigInt(values[1]);
        withdrawalId = Number(values[2]);
        unlockLedger = Number(values[3]);
      }

      console.log(
        `[EventListener] Delayed withdrawal: wallet=${wallet} xlm=${xlmAmount} id=${withdrawalId} unlock=${unlockLedger}`
      );

      // Record in DB if not already tracked
      const existing = await this.prisma.withdrawal.findFirst({
        where: { wallet, amount: xlmAmount, status: "pending" },
      });

      if (!existing && wallet) {
        // Estimate unlock time: ~5s per ledger
        const estimatedUnlockMs = unlockLedger * 5000;
        await this.prisma.withdrawal.create({
          data: {
            wallet,
            amount: xlmAmount,
            status: "pending",
            unlockTime: new Date(Date.now() + estimatedUnlockMs),
          },
        });
      }

      // Emit unstake event for delegation manager
      if (xlmAmount > BigInt(0)) {
        await eventBus.publish(EventType.UNSTAKE_EXECUTED, {
          wallet,
          xlmAmount,
          sxlmBurned: BigInt(0),
          txHash: `ledger:${event.ledger}`,
          timestamp: Date.now(),
        });
      }

    } else if (topicName === "claimed") {
      const values = decoded as [string, bigint, bigint] | unknown;
      let wallet = "";
      let xlmAmount = BigInt(0);

      if (Array.isArray(values) && values.length >= 2) {
        wallet = String(values[0]);
        xlmAmount = BigInt(values[1]);
      }

      console.log(
        `[EventListener] Claim: wallet=${wallet} xlm=${xlmAmount} ledger=${event.ledger}`
      );

      // Mark withdrawal as claimed in DB
      if (wallet) {
        await this.prisma.withdrawal.updateMany({
          where: { wallet, status: "pending" },
          data: { status: "claimed" },
        });
      }

    } else if (topicName === "rewards") {
      const amount = typeof decoded === "bigint" ? decoded : BigInt(String(decoded));

      console.log(
        `[EventListener] Rewards added: ${amount} stroops at ledger ${event.ledger}`
      );

      await eventBus.publish(EventType.REWARD_UPDATED, {
        exchangeRate: 0, // Will be recalculated by RewardEngine
        apy: 0,
        totalStaked: BigInt(0),
        totalSupply: BigInt(0),
        timestamp: Date.now(),
      });

    // --- M5 Lending events ---
    } else if (topicName === "deposit" && event.contractId === config.contracts.lendingContractId) {
      console.log(`[EventListener] Lending deposit at ledger ${event.ledger}`);

    } else if (topicName === "withdraw" && event.contractId === config.contracts.lendingContractId) {
      console.log(`[EventListener] Lending withdrawal at ledger ${event.ledger}`);

    } else if (topicName === "borrow") {
      console.log(`[EventListener] Borrow at ledger ${event.ledger}`);

    } else if (topicName === "repay") {
      console.log(`[EventListener] Repay at ledger ${event.ledger}`);

    } else if (topicName === "liq") {
      const values = decoded as unknown[];
      console.log(`[EventListener] Liquidation at ledger ${event.ledger}`, values);

      // Record liquidation event in DB
      if (Array.isArray(values) && values.length >= 4) {
        try {
          await this.prisma.liquidationEvent.create({
            data: {
              liquidator: String(values[0]),
              borrower: String(values[1]),
              debtRepaid: BigInt(values[2] as any),
              collateralSeized: BigInt(values[3] as any),
              ledger: event.ledger,
            },
          });
        } catch {
          // Ignore DB errors for liquidation logging
        }
      }

    // --- M5 LP Pool events ---
    } else if (topicName === "add_liq") {
      console.log(`[EventListener] LP add liquidity at ledger ${event.ledger}`);

    } else if (topicName === "rm_liq") {
      console.log(`[EventListener] LP remove liquidity at ledger ${event.ledger}`);

    } else if (topicName === "swap") {
      console.log(`[EventListener] Swap at ledger ${event.ledger}`);

    // --- M5 Governance events ---
    } else if (topicName === "propose") {
      console.log(`[EventListener] New proposal at ledger ${event.ledger}`);

    } else if (topicName === "voted") {
      console.log(`[EventListener] Vote cast at ledger ${event.ledger}`);

    } else if (topicName === "executed") {
      console.log(`[EventListener] Proposal executed at ledger ${event.ledger}`);
    }
  }
}

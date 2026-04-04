import { Redis } from "ioredis";
import { config } from "../config/index.js";

export enum EventType {
  STAKE_EXECUTED = "stake:executed",
  UNSTAKE_EXECUTED = "unstake:executed",
  VALIDATOR_DOWN = "validator:down",
  REWARD_UPDATED = "reward:updated",
  WITHDRAWAL_READY = "withdrawal:ready",
  REBALANCE_REQUIRED = "rebalance:required",
  SLASHING_APPLIED = "slashing:applied",
}

export interface StakeExecutedPayload {
  wallet: string;
  xlmAmount: bigint;
  sxlmMinted: bigint;
  txHash: string;
  timestamp: number;
}

export interface ValidatorDownPayload {
  pubkey: string;
  uptime: number;
  lastChecked: string;
}

export interface RewardUpdatedPayload {
  exchangeRate: number;
  apy: number;
  totalStaked: bigint;
  totalSupply: bigint;
  timestamp: number;
}

export interface WithdrawalReadyPayload {
  withdrawalId: number;
  wallet: string;
  amount: bigint;
  claimTxHash: string;
}

export interface UnstakeExecutedPayload {
  wallet: string;
  xlmAmount: bigint;
  sxlmBurned: bigint;
  txHash: string;
  timestamp: number;
}

export interface RebalanceRequiredPayload {
  reason: string;
  validators: Array<{ pubkey: string; currentAllocation: bigint; targetAllocation: bigint }>;
  timestamp: number;
}

export interface SlashingAppliedPayload {
  amount: bigint;
  reason: string;
  timestamp: number;
}

type EventPayloadMap = {
  [EventType.STAKE_EXECUTED]: StakeExecutedPayload;
  [EventType.UNSTAKE_EXECUTED]: UnstakeExecutedPayload;
  [EventType.VALIDATOR_DOWN]: ValidatorDownPayload;
  [EventType.REWARD_UPDATED]: RewardUpdatedPayload;
  [EventType.WITHDRAWAL_READY]: WithdrawalReadyPayload;
  [EventType.REBALANCE_REQUIRED]: RebalanceRequiredPayload;
  [EventType.SLASHING_APPLIED]: SlashingAppliedPayload;
};

function serializePayload(data: object): string {
  return JSON.stringify(data, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

function deserializePayload(raw: string): unknown {
  return JSON.parse(raw);
}

export class EventBus {
  private publisher: Redis;
  private subscriber: Redis;
  private handlers: Map<string, Array<(data: unknown) => void | Promise<void>>>;
  private isConnected: boolean;

  constructor() {
    this.publisher = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 5000);
        return delay;
      },
      lazyConnect: true,
    });
    this.subscriber = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 5000);
        return delay;
      },
      lazyConnect: true,
    });
    this.handlers = new Map();
    this.isConnected = false;
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);

    this.subscriber.on("message", (channel: string, message: string) => {
      const channelHandlers = this.handlers.get(channel);
      if (!channelHandlers) return;

      const data = deserializePayload(message);
      for (const handler of channelHandlers) {
        try {
          const result = handler(data);
          if (result instanceof Promise) {
            result.catch((err) =>
              console.error(`[EventBus] Handler error on ${channel}:`, err)
            );
          }
        } catch (err) {
          console.error(`[EventBus] Sync handler error on ${channel}:`, err);
        }
      }
    });

    this.isConnected = true;
    console.log("[EventBus] Connected to Redis pub/sub");
  }

  async publish<T extends EventType>(
    channel: T,
    data: EventPayloadMap[T]
  ): Promise<number> {
    if (!this.isConnected) {
      throw new Error("[EventBus] Not connected. Call connect() first.");
    }
    const serialized = serializePayload(data);
    const receivers = await this.publisher.publish(channel, serialized);
    console.log(
      `[EventBus] Published to ${channel} (${receivers} receivers)`
    );
    return receivers;
  }

  async subscribe<T extends EventType>(
    channel: T,
    callback: (data: EventPayloadMap[T]) => void | Promise<void>
  ): Promise<void> {
    if (!this.isConnected) {
      throw new Error("[EventBus] Not connected. Call connect() first.");
    }

    const existing = this.handlers.get(channel);
    if (existing) {
      existing.push(callback as (data: unknown) => void | Promise<void>);
    } else {
      this.handlers.set(channel, [callback as (data: unknown) => void | Promise<void>]);
      await this.subscriber.subscribe(channel);
    }

    console.log(`[EventBus] Subscribed to ${channel}`);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel);
    await this.subscriber.unsubscribe(channel);
    console.log(`[EventBus] Unsubscribed from ${channel}`);
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;
    this.handlers.clear();
    await this.subscriber.quit();
    await this.publisher.quit();
    this.isConnected = false;
    console.log("[EventBus] Disconnected");
  }
}

let eventBusInstance: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!eventBusInstance) {
    eventBusInstance = new EventBus();
  }
  return eventBusInstance;
}

export async function initEventBus(): Promise<void> {
  const bus = getEventBus();
  await bus.connect();
}

export async function shutdownEventBus(): Promise<void> {
  if (eventBusInstance) {
    await eventBusInstance.disconnect();
    eventBusInstance = null;
  }
}

import { Redis } from "ioredis";

// ---------- Types ----------

interface RetryItem {
  id: string;
  type: "evm_to_stellar" | "stellar_to_evm";
  data: any;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
}

interface RetryConfig {
  maxAttempts: number;
  backoffMultiplier: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

// ---------- Retry Queue Implementation ----------

export class RetryQueue {
  private redis: Redis;
  private config: RetryConfig;
  private processing = false;

  constructor(redis: Redis, config: Partial<RetryConfig> = {}) {
    this.redis = redis;
    this.config = {
      maxAttempts: 5,
      backoffMultiplier: 2,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      ...config,
    };
  }

  /**
   * Add a failed operation to the retry queue
   */
  async add(item: Omit<RetryItem, "id" | "attempts" | "nextRetryAt" | "createdAt">): Promise<void> {
    const retryItem: RetryItem = {
      ...item,
      id: `${item.type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      attempts: 0,
      nextRetryAt: Date.now() + this.config.initialDelayMs,
      createdAt: Date.now(),
    };

    await this.redis.zadd(
      "bridge_retry_queue",
      retryItem.nextRetryAt,
      JSON.stringify(retryItem)
    );

    console.log(`[retry-queue] added item ${retryItem.id} for retry`);
  }

  /**
   * Process items that are ready for retry
   */
  async process(processors: {
    evmToStellar: (data: any) => Promise<void>;
    stellarToEvm: (data: any) => Promise<void>;
  }): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const now = Date.now();
      const readyItems = await this.redis.zrangebyscore(
        "bridge_retry_queue",
        0,
        now,
        "LIMIT",
        0,
        10 // Process max 10 items at a time
      );

      for (const itemStr of readyItems) {
        const item: RetryItem = JSON.parse(itemStr);
        
        try {
          // Process the item based on its type
          if (item.type === "evm_to_stellar") {
            await processors.evmToStellar(item.data);
          } else if (item.type === "stellar_to_evm") {
            await processors.stellarToEvm(item.data);
          }

          // Success - remove from queue
          await this.redis.zrem("bridge_retry_queue", itemStr);
          console.log(`[retry-queue] successfully processed item ${item.id}`);

        } catch (error) {
          // Failure - increment attempts and reschedule or remove
          item.attempts++;
          item.lastError = error instanceof Error ? error.message : String(error);

          if (item.attempts >= item.maxAttempts) {
            // Max attempts reached - move to dead letter queue
            await this.redis.zadd(
              "bridge_dead_letter_queue",
              Date.now(),
              JSON.stringify(item)
            );
            await this.redis.zrem("bridge_retry_queue", itemStr);
            console.error(`[retry-queue] item ${item.id} max attempts reached, moved to DLQ`);
          } else {
            // Reschedule with exponential backoff
            const delay = Math.min(
              this.config.initialDelayMs * Math.pow(this.config.backoffMultiplier, item.attempts - 1),
              this.config.maxDelayMs
            );
            item.nextRetryAt = Date.now() + delay;

            await this.redis.zrem("bridge_retry_queue", itemStr);
            await this.redis.zadd(
              "bridge_retry_queue",
              item.nextRetryAt,
              JSON.stringify(item)
            );
            console.warn(`[retry-queue] item ${item.id} failed, retry ${item.attempts}/${item.maxAttempts} in ${delay}ms`);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Get statistics about the retry queue
   */
  async getStats(): Promise<{
    pending: number;
    deadLetter: number;
    processing: boolean;
  }> {
    const pending = await this.redis.zcard("bridge_retry_queue");
    const deadLetter = await this.redis.zcard("bridge_dead_letter_queue");

    return {
      pending,
      deadLetter,
      processing: this.processing,
    };
  }

  /**
   * Clear all items from the retry queue (for testing/maintenance)
   */
  async clear(): Promise<void> {
    await this.redis.del("bridge_retry_queue");
    await this.redis.del("bridge_dead_letter_queue");
  }

  /**
   * Get items from dead letter queue for inspection
   */
  async getDeadLetterItems(limit: number = 50): Promise<RetryItem[]> {
    const items = await this.redis.zrange("bridge_dead_letter_queue", 0, limit - 1);
    return items.map(itemStr => JSON.parse(itemStr));
  }

  /**
   * Requeue items from dead letter queue (for manual recovery)
   */
  async requeueFromDeadLetter(itemIds: string[]): Promise<number> {
    let requeued = 0;
    
    for (const id of itemIds) {
      const items = await this.redis.zrange("bridge_dead_letter_queue", 0, -1);
      
      for (const itemStr of items) {
        const item: RetryItem = JSON.parse(itemStr);
        if (item.id === id) {
          // Reset attempts and schedule for immediate retry
          item.attempts = 0;
          item.nextRetryAt = Date.now();
          item.lastError = undefined;
          
          await this.redis.zadd("bridge_retry_queue", item.nextRetryAt, JSON.stringify(item));
          await this.redis.zrem("bridge_dead_letter_queue", itemStr);
          requeued++;
          break;
        }
      }
    }
    
    return requeued;
  }
}

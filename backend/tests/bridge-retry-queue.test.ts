import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RetryQueue } from "../src/bridge-relayer/retry-queue.js";
import Redis from "ioredis-mock";

describe("RetryQueue", () => {
  let redis: Redis;
  let retryQueue: RetryQueue;

  beforeEach(() => {
    redis = new Redis();
    retryQueue = new RetryQueue(redis, {
      maxAttempts: 3,
      backoffMultiplier: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });
  });

  afterEach(async () => {
    await retryQueue.clear();
  });

  describe("add", () => {
    it("should add an item to the retry queue", async () => {
      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123", amount: "1000" },
        maxAttempts: 5,
      });

      const stats = await retryQueue.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.deadLetter).toBe(0);
    });

    it("should generate unique IDs for each item", async () => {
      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 5,
      });

      await retryQueue.add({
        type: "stellar_to_evm",
        data: { txHash: "0x456" },
        maxAttempts: 5,
      });

      const items = await redis.zrange("bridge_retry_queue", 0, -1);
      const parsedItems = items.map(item => JSON.parse(item));
      
      expect(parsedItems[0].id).toMatch(/^evm_to_stellar_\d+_[a-z0-9]+$/);
      expect(parsedItems[1].id).toMatch(/^stellar_to_evm_\d+_[a-z0-9]+$/);
      expect(parsedItems[0].id).not.toBe(parsedItems[1].id);
    });
  });

  describe("process", () => {
    it("should process ready items successfully", async () => {
      const evmToStellarProcessor = vi.fn().mockResolvedValue(undefined);
      const stellarToEvmProcessor = vi.fn().mockResolvedValue(undefined);

      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 5,
      });

      await retryQueue.add({
        type: "stellar_to_evm",
        data: { txHash: "0x456" },
        maxAttempts: 5,
      });

      // Set items to be immediately ready for processing
      await redis.del("bridge_retry_queue");
      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 5,
      });
      await retryQueue.add({
        type: "stellar_to_evm",
        data: { txHash: "0x456" },
        maxAttempts: 5,
      });

      await retryQueue.process({
        evmToStellar: evmToStellarProcessor,
        stellarToEvm: stellarToEvmProcessor,
      });

      expect(evmToStellarProcessor).toHaveBeenCalledWith({ txHash: "0x123" });
      expect(stellarToEvmProcessor).toHaveBeenCalledWith({ txHash: "0x456" });

      const stats = await retryQueue.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.deadLetter).toBe(0);
    });

    it("should retry failed items with exponential backoff", async () => {
      const evmToStellarProcessor = vi.fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce(undefined);

      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 3,
      });

      // First attempt - should fail
      await retryQueue.process({
        evmToStellar: evmToStellarProcessor,
        stellarToEvm: vi.fn(),
      });

      expect(evmToStellarProcessor).toHaveBeenCalledTimes(1);

      const stats1 = await retryQueue.getStats();
      expect(stats1.pending).toBe(1); // Still in queue for retry
      expect(stats1.deadLetter).toBe(0);

      // Wait for retry delay and process again
      await new Promise(resolve => setTimeout(resolve, 150));
      await retryQueue.process({
        evmToStellar: evmToStellarProcessor,
        stellarToEvm: vi.fn(),
      });

      expect(evmToStellarProcessor).toHaveBeenCalledTimes(2);

      const stats2 = await retryQueue.getStats();
      expect(stats2.pending).toBe(0); // Successfully processed
      expect(stats2.deadLetter).toBe(0);
    });

    it("should move items to dead letter queue after max attempts", async () => {
      const evmToStellarProcessor = vi.fn().mockRejectedValue(new Error("Permanent error"));

      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 2,
      });

      // First attempt
      await retryQueue.process({
        evmToStellar: evmToStellarProcessor,
        stellarToEvm: vi.fn(),
      });

      // Second attempt
      await new Promise(resolve => setTimeout(resolve, 150));
      await retryQueue.process({
        evmToStellar: evmToStellarProcessor,
        stellarToEvm: vi.fn(),
      });

      // Third attempt - should move to DLQ
      await new Promise(resolve => setTimeout(resolve, 200));
      await retryQueue.process({
        evmToStellar: evmToStellarProcessor,
        stellarToEvm: vi.fn(),
      });

      expect(evmToStellarProcessor).toHaveBeenCalledTimes(3);

      const stats = await retryQueue.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.deadLetter).toBe(1);

      const dlqItems = await retryQueue.getDeadLetterItems();
      expect(dlqItems).toHaveLength(1);
      expect(dlqItems[0].attempts).toBe(3);
      expect(dlqItems[0].lastError).toBe("Permanent error");
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", async () => {
      const stats = await retryQueue.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.deadLetter).toBe(0);
      expect(stats.processing).toBe(false);

      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 5,
      });

      const stats2 = await retryQueue.getStats();
      expect(stats2.pending).toBe(1);
      expect(stats2.deadLetter).toBe(0);
      expect(stats2.processing).toBe(false);
    });
  });

  describe("requeueFromDeadLetter", () => {
    it("should requeue items from dead letter queue", async () => {
      // Add an item and fail it max times to move to DLQ
      const evmToStellarProcessor = vi.fn().mockRejectedValue(new Error("Permanent error"));

      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 2,
      });

      // Fail all attempts
      for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        await retryQueue.process({
          evmToStellar: evmToStellarProcessor,
          stellarToEvm: vi.fn(),
        });
      }

      const dlqItems = await retryQueue.getDeadLetterItems();
      expect(dlqItems).toHaveLength(1);

      const itemId = dlqItems[0].id;
      const requeued = await retryQueue.requeueFromDeadLetter([itemId]);

      expect(requeued).toBe(1);

      const stats = await retryQueue.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.deadLetter).toBe(0);
    });
  });

  describe("clear", () => {
    it("should clear all queues", async () => {
      await retryQueue.add({
        type: "evm_to_stellar",
        data: { txHash: "0x123" },
        maxAttempts: 5,
      });

      let stats = await retryQueue.getStats();
      expect(stats.pending).toBe(1);

      await retryQueue.clear();

      stats = await retryQueue.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.deadLetter).toBe(0);
    });
  });
});

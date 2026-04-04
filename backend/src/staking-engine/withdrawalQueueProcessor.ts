import { PrismaClient } from "@prisma/client";
import { callClaimWithdrawal } from "./contractClient.js";
import { getEventBus, EventType } from "../event-bus/index.js";
import { config } from "../config/index.js";

let pollInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

export function startWithdrawalQueueProcessor(prisma: PrismaClient): void {
  if (pollInterval) {
    console.warn("[WithdrawalQueue] Processor already running");
    return;
  }

  // Run immediately on start
  processQueue(prisma).catch((err) =>
    console.error("[WithdrawalQueue] Initial processing failed:", err)
  );

  pollInterval = setInterval(async () => {
    if (isProcessing) {
      console.log("[WithdrawalQueue] Previous processing still running, skipping");
      return;
    }
    try {
      await processQueue(prisma);
    } catch (err) {
      console.error("[WithdrawalQueue] Processing error:", err);
    }
  }, config.protocol.withdrawalPollIntervalMs);

  console.log(
    `[WithdrawalQueue] Started polling every ${config.protocol.withdrawalPollIntervalMs / 1000}s`
  );
}

export function stopWithdrawalQueueProcessor(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("[WithdrawalQueue] Processor stopped");
  }
}

async function processQueue(prisma: PrismaClient): Promise<void> {
  isProcessing = true;

  try {
    const now = new Date();

    // Find all pending withdrawals where unlock time has passed
    const readyWithdrawals = await prisma.withdrawal.findMany({
      where: {
        status: "pending",
        unlockTime: {
          lte: now,
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      take: 50, // Process in batches of 50
    });

    if (readyWithdrawals.length === 0) {
      return;
    }

    console.log(
      `[WithdrawalQueue] Processing ${readyWithdrawals.length} ready withdrawals`
    );

    const eventBus = getEventBus();

    for (const withdrawal of readyWithdrawals) {
      try {
        // Mark as processing to prevent double-processing
        await prisma.withdrawal.update({
          where: { id: withdrawal.id },
          data: { status: "processing" },
        });

        // Execute the claim on-chain
        const claimResult = await callClaimWithdrawal(
          withdrawal.wallet,
          withdrawal.id
        );

        // Mark as completed
        await prisma.withdrawal.update({
          where: { id: withdrawal.id },
          data: { status: "completed" },
        });

        // Emit event
        await eventBus.publish(EventType.WITHDRAWAL_READY, {
          withdrawalId: withdrawal.id,
          wallet: withdrawal.wallet,
          amount: withdrawal.amount,
          claimTxHash: claimResult.txHash,
        });

        console.log(
          `[WithdrawalQueue] Processed withdrawal #${withdrawal.id} for ${withdrawal.wallet}, tx: ${claimResult.txHash}`
        );
      } catch (err) {
        console.error(
          `[WithdrawalQueue] Failed to process withdrawal #${withdrawal.id}:`,
          err
        );

        // Revert to pending so it gets retried, but track failures
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        // If the error is a permanent failure (e.g. already claimed), mark as failed
        const isPermanentFailure =
          errorMessage.includes("already claimed") ||
          errorMessage.includes("not found") ||
          errorMessage.includes("insufficient");

        await prisma.withdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: isPermanentFailure ? "failed" : "pending",
          },
        });
      }
    }
  } finally {
    isProcessing = false;
  }
}

export async function getQueueStats(
  prisma: PrismaClient
): Promise<{
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  totalPendingAmount: bigint;
}> {
  const [pending, processing, completed, failed] = await Promise.all([
    prisma.withdrawal.count({ where: { status: "pending" } }),
    prisma.withdrawal.count({ where: { status: "processing" } }),
    prisma.withdrawal.count({ where: { status: "completed" } }),
    prisma.withdrawal.count({ where: { status: "failed" } }),
  ]);

  const pendingAgg = await prisma.withdrawal.aggregate({
    where: { status: "pending" },
    _sum: { amount: true },
  });

  return {
    pending,
    processing,
    completed,
    failed,
    totalPendingAmount: pendingAgg._sum.amount ?? BigInt(0),
  };
}

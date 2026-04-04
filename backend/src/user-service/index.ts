import { PrismaClient } from "@prisma/client";

export class UserService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    console.log("[UserService] Initialized");
  }

  async shutdown(): Promise<void> {
    console.log("[UserService] Shut down");
  }

  async getWithdrawalsByWallet(wallet: string) {
    return this.prisma.withdrawal.findMany({
      where: { wallet, status: { not: "claimed" } },
      orderBy: { createdAt: "desc" },
    });
  }

  async markWithdrawalClaimed(wallet: string, withdrawalId: number) {
    await this.prisma.withdrawal.updateMany({
      where: { id: withdrawalId, wallet },
      data: { status: "claimed" },
    });
  }

  async getStakingHistory(wallet: string) {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where: { wallet },
      orderBy: { createdAt: "desc" },
    });

    return {
      wallet,
      withdrawals,
      totalWithdrawals: withdrawals.length,
      pendingWithdrawals: withdrawals.filter((w) => w.status === "pending").length,
    };
  }
}

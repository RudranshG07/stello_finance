/**
 * Restaking Engine — Automated restaking loop simulation and position tracking.
 *
 * Flow: stake → deposit as collateral → borrow → restake (repeat N times)
 *
 * Uses on-chain data from lending and staking contracts for real position tracking.
 */

import { PrismaClient } from "@prisma/client";
import {
  rpc,
  Contract,
  Address,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "../config/index.js";

export interface RestakingLoopStep {
  step: number;
  action: string;
  amount: number;
  totalStaked: number;
  totalBorrowed: number;
  healthFactor: number;
}

export interface RestakingSimulationResult {
  initialDeposit: number;
  loops: number;
  totalStaked: number;
  totalBorrowed: number;
  effectiveLeverage: number;
  estimatedNetAPR: number;
  healthFactor: number;
  steps: RestakingLoopStep[];
}

export interface RestakingPosition {
  wallet: string;
  totalStaked: number;
  totalBorrowed: number;
  effectiveLeverage: number;
  healthFactor: number;
  netAPR: number;
  loops: number;
}

export class RestakingEngine {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Simulate N restaking loops with real math.
   */
  simulate(
    principal: number,
    loops: number,
    collateralFactor: number = 0.7,
    stakingAPR: number = 0,
    borrowAPR: number = 0.04
  ): RestakingSimulationResult {
    const steps: RestakingLoopStep[] = [];
    let totalStaked = 0;
    let totalBorrowed = 0;
    let currentAmount = principal;

    for (let i = 0; i < loops; i++) {
      // Step 1: Stake XLM -> get sXLM
      totalStaked += currentAmount;
      steps.push({
        step: i * 3 + 1,
        action: "stake",
        amount: currentAmount,
        totalStaked,
        totalBorrowed,
        healthFactor:
          totalBorrowed > 0
            ? (totalStaked * collateralFactor) / totalBorrowed
            : Infinity,
      });

      // Step 2: Deposit sXLM as collateral
      steps.push({
        step: i * 3 + 2,
        action: "deposit_collateral",
        amount: currentAmount,
        totalStaked,
        totalBorrowed,
        healthFactor:
          totalBorrowed > 0
            ? (totalStaked * collateralFactor) / totalBorrowed
            : Infinity,
      });

      // Step 3: Borrow XLM against collateral
      const borrowAmount = currentAmount * collateralFactor;
      totalBorrowed += borrowAmount;
      const hf = (totalStaked * collateralFactor) / totalBorrowed;

      steps.push({
        step: i * 3 + 3,
        action: "borrow",
        amount: borrowAmount,
        totalStaked,
        totalBorrowed,
        healthFactor: hf,
      });

      currentAmount = borrowAmount;
    }

    const effectiveLeverage = totalStaked / principal;
    const grossYield = totalStaked * stakingAPR;
    const borrowCost = totalBorrowed * borrowAPR;
    const netAPR = ((grossYield - borrowCost) / principal) * 100;
    const finalHF =
      totalBorrowed > 0
        ? (totalStaked * collateralFactor) / totalBorrowed
        : Infinity;

    return {
      initialDeposit: principal,
      loops,
      totalStaked,
      totalBorrowed,
      effectiveLeverage,
      estimatedNetAPR: netAPR,
      healthFactor: finalHF,
      steps,
    };
  }

  /**
   * Get a user's restaking position by combining staking + lending data.
   */
  async getPosition(wallet: string): Promise<RestakingPosition> {
    // Try to get on-chain data via contract queries
    try {
      const server = new rpc.Server(config.stellar.rpcUrl);
      const lendingContractId = config.contracts.lendingContractId;

      if (!lendingContractId) {
        return this.getPositionFromDB(wallet);
      }

      const contract = new Contract(lendingContractId);
      const op = contract.call(
        "get_position",
        new Address(wallet).toScVal()
      );

      const account = await server.getAccount(config.admin.publicKey);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: config.stellar.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(tx);

      if (rpc.Api.isSimulationSuccess(simResult) && simResult.result) {
        const position = scValToNative(simResult.result.retval);
        const collateral = Number(position[0] ?? 0) / 1e7;
        const borrowed = Number(position[1] ?? 0) / 1e7;

        const effectiveLeverage =
          collateral > 0 && borrowed > 0
            ? collateral / (collateral - borrowed)
            : 1;
        const hf =
          borrowed > 0 ? (collateral * 0.7) / borrowed : Infinity;
        const loops = effectiveLeverage > 1 ? Math.round(Math.log(effectiveLeverage) / Math.log(1 / 0.3)) : 0;
        const netAPR =
          effectiveLeverage * 6 - (effectiveLeverage - 1) * 4; // Using default rates

        return {
          wallet,
          totalStaked: collateral,
          totalBorrowed: borrowed,
          effectiveLeverage,
          healthFactor: hf,
          netAPR,
          loops,
        };
      }
    } catch {
      // Fall through to DB
    }

    return this.getPositionFromDB(wallet);
  }

  private async getPositionFromDB(wallet: string): Promise<RestakingPosition> {
    const [position, deposits] = await Promise.all([
      this.prisma.collateralPosition.findUnique({ where: { wallet } }),
      this.prisma.collateralDeposit.aggregate({
        where: { wallet },
        _sum: { amount: true },
      }),
    ]);

    if (!position) {
      return {
        wallet,
        totalStaked: 0,
        totalBorrowed: 0,
        effectiveLeverage: 1,
        healthFactor: 0,
        netAPR: 0,
        loops: 0,
      };
    }

    const collateral = Number(deposits._sum.amount ?? BigInt(0)) / 1e7;
    const borrowed = Number(position.xlmBorrowed) / 1e7;
    const effectiveLeverage =
      collateral > 0 && borrowed > 0
        ? collateral / (collateral - borrowed)
        : 1;

    return {
      wallet,
      totalStaked: collateral,
      totalBorrowed: borrowed,
      effectiveLeverage,
      healthFactor: position.healthFactor,
      netAPR: effectiveLeverage * 6 - (effectiveLeverage - 1) * 4,
      loops: effectiveLeverage > 1 ? Math.round(Math.log(effectiveLeverage) / Math.log(1 / 0.3)) : 0,
    };
  }
}

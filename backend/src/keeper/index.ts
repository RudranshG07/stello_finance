/**
 * Keeper Bot
 *
 * Runs on a schedule to keep the protocol healthy:
 *
 * Every 6 hours:
 *   1. Harvest accrued lending interest from the lending contract → admin wallet
 *   2. Pipe harvested interest to staking.add_rewards() → raises sXLM exchange rate
 *   3. Bump TTL on all 5 contracts so they never expire
 *
 * Every 24 hours:
 *   4. Recalibrate the staking exchange rate (sanity check)
 *
 * The reward engine (reward-engine/index.ts) handles simulated APR-based distributions
 * independently. This keeper handles REAL yield from lending fees.
 */

import {
  rpc,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "../config/index.js";
import {
  callAddRewards,
  callWithdrawFees,
  callCollectProtocolFees,
  getLpAccruedProtocolFees,
  getTreasuryBalance,
} from "../staking-engine/contractClient.js";

const KEEPER_INTERVAL_MS = 6 * 60 * 60 * 1000;      // 6 hours
const TTL_BUMP_INTERVAL_MS = 24 * 60 * 60 * 1000;    // 24 hours
const RECALIBRATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const TREASURY_RECYCLE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TREASURY_RECYCLE_THRESHOLD = BigInt(100_0000000);   // 100 XLM in stroops

let keeperInterval: ReturnType<typeof setInterval> | null = null;
let ttlInterval: ReturnType<typeof setInterval> | null = null;
let recalibrateInterval: ReturnType<typeof setInterval> | null = null;
let treasuryRecycleInterval: ReturnType<typeof setInterval> | null = null;

export class KeeperBot {
  private server: rpc.Server;

  constructor() {
    this.server = new rpc.Server(config.stellar.rpcUrl);
  }

  async initialize(): Promise<void> {
    console.log("[KeeperBot] Initializing...");

    // Run immediately on startup
    await this.runHarvestCycle().catch((err) =>
      console.error("[KeeperBot] Initial harvest cycle failed:", err)
    );
    await this.bumpAllContractTTLs().catch((err) =>
      console.error("[KeeperBot] Initial TTL bump failed:", err)
    );

    // Schedule harvest cycle every 6h
    keeperInterval = setInterval(async () => {
      try {
        await this.runHarvestCycle();
      } catch (err) {
        console.error("[KeeperBot] Harvest cycle error:", err);
      }
    }, KEEPER_INTERVAL_MS);

    // Schedule TTL bumps every 24h
    ttlInterval = setInterval(async () => {
      try {
        await this.bumpAllContractTTLs();
      } catch (err) {
        console.error("[KeeperBot] TTL bump error:", err);
      }
    }, TTL_BUMP_INTERVAL_MS);

    // Schedule recalibration every 24h
    recalibrateInterval = setInterval(async () => {
      try {
        await this.recalibrateStakingRate();
      } catch (err) {
        console.error("[KeeperBot] Recalibrate error:", err);
      }
    }, RECALIBRATE_INTERVAL_MS);

    // Schedule treasury recycling every 24h
    treasuryRecycleInterval = setInterval(async () => {
      try {
        await this.recycleTreasury();
      } catch (err) {
        console.error("[KeeperBot] Treasury recycle error:", err);
      }
    }, TREASURY_RECYCLE_INTERVAL_MS);

    console.log(
      `[KeeperBot] Running — harvest every ${KEEPER_INTERVAL_MS / 3_600_000}h, TTL bump every ${TTL_BUMP_INTERVAL_MS / 3_600_000}h`
    );
  }

  async shutdown(): Promise<void> {
    if (keeperInterval) { clearInterval(keeperInterval); keeperInterval = null; }
    if (ttlInterval) { clearInterval(ttlInterval); ttlInterval = null; }
    if (recalibrateInterval) { clearInterval(recalibrateInterval); recalibrateInterval = null; }
    if (treasuryRecycleInterval) { clearInterval(treasuryRecycleInterval); treasuryRecycleInterval = null; }
    console.log("[KeeperBot] Shut down");
  }

  // ============================================================
  // Core: harvest lending interest and pipe to staking rewards
  // ============================================================

  async runHarvestCycle(): Promise<void> {
    console.log("[KeeperBot] Starting harvest cycle...");

    // Step 1: Check how much interest has accrued on the lending contract
    const pendingInterest = await this.queryLendingAccruedInterest();

    // Log LP pool stats for transparency
    await this.logLpPoolStats();

    // Step 2: Collect LP protocol fees
    let lpProtocolFees = BigInt(0);
    try {
      const accrued = await getLpAccruedProtocolFees();
      if (accrued > BigInt(0)) {
        await callCollectProtocolFees();
        lpProtocolFees = accrued;
        console.log(`[KeeperBot] Collected ${Number(lpProtocolFees) / 1e7} XLM in LP protocol fees`);
      }
    } catch (err) {
      console.warn("[KeeperBot] LP protocol fee collection failed:", err);
    }

    // Step 3: Harvest lending interest
    let harvested = BigInt(0);
    if (pendingInterest > BigInt(0)) {
      console.log(
        `[KeeperBot] Pending interest: ${Number(pendingInterest) / 1e7} XLM`
      );
      harvested = await this.harvestLendingInterest(pendingInterest);
      if (harvested > BigInt(0)) {
        console.log(`[KeeperBot] Harvested ${Number(harvested) / 1e7} XLM from lending`);
      }
    }

    // Step 4: Pipe total yield to add_rewards
    const totalYield = harvested + lpProtocolFees;
    if (totalYield <= BigInt(0)) {
      console.log("[KeeperBot] No yield to distribute");
      return;
    }

    try {
      await callAddRewards(totalYield);
      console.log(
        `[KeeperBot] add_rewards called with ${Number(totalYield) / 1e7} XLM (lending: ${Number(harvested) / 1e7}, LP fees: ${Number(lpProtocolFees) / 1e7}) — sXLM rate will increase`
      );
    } catch (err) {
      console.error("[KeeperBot] add_rewards failed:", err);
      console.error(
        `[KeeperBot] MANUAL ACTION REQUIRED: call add_rewards with ${totalYield} stroops`
      );
    }
  }

  // ============================================================
  // Query accrued interest from lending contract
  // ============================================================

  private async queryLendingAccruedInterest(): Promise<bigint> {
    try {
      const result = await this.simulateView(
        config.contracts.lendingContractId,
        "total_accrued_interest",
        []
      );
      return result != null ? BigInt(result as string | number | bigint) : BigInt(0);
    } catch (err) {
      console.warn("[KeeperBot] Could not query accrued interest:", err);
      return BigInt(0);
    }
  }

  // ============================================================
  // Call harvest_interest() on lending contract
  // ============================================================

  private async harvestLendingInterest(pendingBefore: bigint): Promise<bigint> {
    try {
      const hash = await this.executeAdminCall(
        config.contracts.lendingContractId,
        "harvest_interest",
        []
      );
      console.log(`[KeeperBot] harvest_interest tx: ${hash}`);

      // The contract harvests min(pending, pool_balance).
      // Re-query after harvest to see how much is left; the difference is what was harvested.
      const pendingAfter = await this.queryLendingAccruedInterest();
      const harvested = pendingBefore > pendingAfter
        ? pendingBefore - pendingAfter
        : pendingBefore; // fallback if query fails

      return harvested;
    } catch (err) {
      console.error("[KeeperBot] harvest_interest failed:", err);
      return BigInt(0);
    }
  }

  // ============================================================
  // Bump TTL on all 5 contracts
  // ============================================================

  async bumpAllContractTTLs(): Promise<void> {
    const contracts = [
      { name: "sXLM Token",  id: config.contracts.sxlmTokenContractId },
      { name: "Staking",     id: config.contracts.stakingContractId },
      { name: "Lending",     id: config.contracts.lendingContractId },
      { name: "LP Pool",     id: config.contracts.lpPoolContractId },
      { name: "Governance",  id: config.contracts.governanceContractId },
    ];

    for (const c of contracts) {
      try {
        await this.executeAdminCall(c.id, "bump_instance", []);
        console.log(`[KeeperBot] TTL bumped: ${c.name}`);
      } catch (err) {
        console.error(`[KeeperBot] TTL bump failed for ${c.name}:`, err);
        // Non-fatal: log and continue
      }
    }
  }

  // ============================================================
  // Recalibrate staking exchange rate (sanity check)
  // ============================================================

  async recalibrateStakingRate(): Promise<void> {
    try {
      await this.executeAdminCall(
        config.contracts.stakingContractId,
        "recalibrate_rate",
        []
      );
      console.log("[KeeperBot] Staking rate recalibrated");
    } catch (err) {
      console.error("[KeeperBot] Recalibrate failed:", err);
    }
  }

  // ============================================================
  // LP Pool stats logging (fees go to LPs via constant product k growth)
  // ============================================================

  private async logLpPoolStats(): Promise<void> {
    try {
      const reserves = await this.simulateView(
        config.contracts.lpPoolContractId,
        "get_reserves",
        []
      );

      const arr = reserves as [string | number | bigint, string | number | bigint] | null;
      const xlm = Number(arr?.[0] ?? 0) / 1e7;
      const sxlm = Number(arr?.[1] ?? 0) / 1e7;
      const k = xlm * sxlm;

      const accruedFees = await getLpAccruedProtocolFees().catch(() => BigInt(0));

      console.log(
        `[KeeperBot] LP Pool: reserve_xlm=${xlm.toFixed(2)}, reserve_sxlm=${sxlm.toFixed(2)}, k=${k.toFixed(2)}, accrued_protocol_fees=${Number(accruedFees) / 1e7} XLM`
      );
    } catch (err) {
      console.warn("[KeeperBot] Could not query LP pool stats:", err);
    }
  }

  // ============================================================
  // Treasury recycling: withdraw protocol fees and pipe back as rewards
  // ============================================================

  async recycleTreasury(): Promise<void> {
    try {
      const treasuryBal = await getTreasuryBalance();

      if (treasuryBal < TREASURY_RECYCLE_THRESHOLD) {
        console.log(
          `[KeeperBot] Treasury balance ${Number(treasuryBal) / 1e7} XLM below threshold (${Number(TREASURY_RECYCLE_THRESHOLD) / 1e7} XLM) — skipping recycle`
        );
        return;
      }

      console.log(`[KeeperBot] Recycling treasury: ${Number(treasuryBal) / 1e7} XLM`);

      await callWithdrawFees(treasuryBal);
      console.log(`[KeeperBot] Withdrew ${Number(treasuryBal) / 1e7} XLM from treasury`);

      await callAddRewards(treasuryBal);
      console.log(
        `[KeeperBot] Recycled ${Number(treasuryBal) / 1e7} XLM treasury → add_rewards — stakers get ~100% of yield`
      );
    } catch (err) {
      console.error("[KeeperBot] Treasury recycle failed:", err);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private async simulateView(
    contractId: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[]
  ): Promise<unknown> {
    const contract = new Contract(contractId);
    const op = contract.call(method, ...args);

    const keypair = Keypair.fromSecret(config.admin.secretKey);
    const account = await this.server.getAccount(keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.stellar.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationSuccess(simResult) && simResult.result) {
      return scValToNative(simResult.result.retval);
    }
    return null;
  }

  private async executeAdminCall(
    contractId: string,
    method: string,
    args: ReturnType<typeof nativeToScVal>[]
  ): Promise<string> {
    const keypair = Keypair.fromSecret(config.admin.secretKey);
    const account = await this.server.getAccount(keypair.publicKey());

    const contract = new Contract(contractId);
    const op = contract.call(method, ...args);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.stellar.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(300)
      .build();

    const preparedTx = await this.server.prepareTransaction(tx);
    preparedTx.sign(keypair);

    const result = await this.server.sendTransaction(preparedTx);
    if (result.status === "ERROR") {
      throw new Error(`${contractId}::${method} failed: ${JSON.stringify(result.errorResult)}`);
    }

    await this.pollTransaction(result.hash);
    return result.hash;
  }

  private async pollTransaction(
    hash: string,
    maxAttempts = 30,
    intervalMs = 2000
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const txResponse = await this.server.getTransaction(hash);

      if (txResponse.status === "SUCCESS") {
        return;
      }

      if (txResponse.status === "FAILED") {
        throw new Error(`Transaction ${hash} failed`);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Transaction ${hash} not confirmed after ${maxAttempts} attempts`);
  }
}

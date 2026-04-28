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
import { getLogger, ServiceContext } from "../utils/logger.js";

const KEEPER_INTERVAL_MS = 6 * 60 * 60 * 1000;      // 6 hours
const TTL_BUMP_INTERVAL_MS = 24 * 60 * 60 * 1000;    // 24 hours
const RECALIBRATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TIMELOCK_POLL_INTERVAL_MS = 30 * 60 * 1000;    // 30 minutes

const TREASURY_RECYCLE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TREASURY_RECYCLE_THRESHOLD = BigInt(100_0000000);

const logger = getLogger(ServiceContext.KEEPER);

let keeperInterval: ReturnType<typeof setInterval> | null = null;
let ttlInterval: ReturnType<typeof setInterval> | null = null;
let recalibrateInterval: ReturnType<typeof setInterval> | null = null;
let treasuryRecycleInterval: ReturnType<typeof setInterval> | null = null;
let timelockPollInterval: ReturnType<typeof setInterval> | null = null;

export class KeeperBot {
  private server: rpc.Server;

  constructor() {
    this.server = new rpc.Server(config.stellar.rpcUrl);
  }

  async initialize(): Promise<void> {
    logger.info("Initializing Keeper Bot", "initialize");

    // Run immediately on startup
    await this.runHarvestCycle().catch((err) =>
      logger.error("Initial harvest cycle failed", "initialize", {}, err)
    );
    await this.bumpAllContractTTLs().catch((err) =>
      logger.error("Initial TTL bump failed", "initialize", {}, err)
    );

    // Schedule harvest cycle every 6h
    keeperInterval = setInterval(async () => {
      try {
        await this.runHarvestCycle();
      } catch (err) {
        logger.error("Harvest cycle error", "harvest-cycle", {}, err);
      }
    }, KEEPER_INTERVAL_MS);

    // Schedule TTL bumps every 24h
    ttlInterval = setInterval(async () => {
      try {
        await this.bumpAllContractTTLs();
      } catch (err) {
        logger.error("TTL bump error", "ttl-bump", {}, err);
      }
    }, TTL_BUMP_INTERVAL_MS);

    // Schedule recalibration every 24h
    recalibrateInterval = setInterval(async () => {
      try {
        await this.recalibrateStakingRate();
      } catch (err) {
        logger.error("Recalibrate error", "recalibrate", {}, err);
      }
    }, RECALIBRATE_INTERVAL_MS);

    // Schedule treasury recycling every 24h
    treasuryRecycleInterval = setInterval(async () => {
      try {
        await this.recycleTreasury();
      } catch (err) {
        logger.error("Treasury recycle error", "treasury-recycle", {}, err);
      }
    }, TREASURY_RECYCLE_INTERVAL_MS);

    // Schedule timelock execution polling every 30 minutes
    timelockPollInterval = setInterval(async () => {
      try {
        await this.executeMaturedTimelocks();
      } catch (err) {
        logger.error("Timelock poll error", "timelock-poll", {}, err);
      }
    }, TIMELOCK_POLL_INTERVAL_MS);

    logger.info(
      `Keeper Bot running — harvest every ${KEEPER_INTERVAL_MS / 3_600_000}h, TTL bump every ${TTL_BUMP_INTERVAL_MS / 3_600_000}h`,
      "initialize",
      {
        harvestIntervalHours: KEEPER_INTERVAL_MS / 3_600_000,
        ttlBumpIntervalHours: TTL_BUMP_INTERVAL_MS / 3_600_000,
        recalibrateIntervalHours: RECALIBRATE_INTERVAL_MS / 3_600_000,
        treasuryRecycleIntervalHours: TREASURY_RECYCLE_INTERVAL_MS / 3_600_000,
        timelockPollIntervalMinutes: TIMELOCK_POLL_INTERVAL_MS / 60_000
      }
    );
  }

  async shutdown(): Promise<void> {
    if (keeperInterval) { clearInterval(keeperInterval); keeperInterval = null; }
    if (ttlInterval) { clearInterval(ttlInterval); ttlInterval = null; }
    if (recalibrateInterval) { clearInterval(recalibrateInterval); recalibrateInterval = null; }
    if (treasuryRecycleInterval) { clearInterval(treasuryRecycleInterval); treasuryRecycleInterval = null; }
    if (timelockPollInterval) { clearInterval(timelockPollInterval); timelockPollInterval = null; }
    logger.info("Keeper Bot shut down", "shutdown");
  }

  // ============================================================
  // Core: harvest lending interest and pipe to staking rewards
  // ============================================================

  async runHarvestCycle(): Promise<void> {
    logger.info("Starting harvest cycle", "harvest-cycle");

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
        logger.financial(
          `Collected LP protocol fees`,
          accrued,
          "XLM",
          "collect-fees",
          { source: "lp-pool" }
        );
      }
    } catch (err) {
      logger.warn("LP protocol fee collection failed", "collect-fees", { error: err instanceof Error ? err.message : String(err) });
    }

    // Step 3: Harvest lending interest
    let harvested = BigInt(0);
    if (pendingInterest > BigInt(0)) {
      logger.financial(
        "Pending lending interest available",
        pendingInterest,
        "XLM",
        "check-interest",
        { pendingInterest: pendingInterest.toString() }
      );
      harvested = await this.harvestLendingInterest(pendingInterest);
      if (harvested > BigInt(0)) {
        logger.financial(
          "Harvested lending interest",
          harvested,
          "XLM",
          "harvest-interest",
          { harvested: harvested.toString() }
        );
      }
    }

    // Step 4: Pipe total yield to add_rewards
    const totalYield = harvested + lpProtocolFees;
    if (totalYield <= BigInt(0)) {
      logger.info("No yield to distribute", "harvest-cycle", { totalYield: "0" });
      return;
    }

    try {
      await callAddRewards(totalYield);
      logger.financial(
        "Added rewards to staking contract",
        totalYield,
        "XLM",
        "add-rewards",
        {
          harvestedXLM: harvested.toString(),
          lpFeesXLM: lpProtocolFees.toString(),
          totalYieldXLM: totalYield.toString()
        }
      );
    } catch (err) {
      logger.error("add_rewards failed", "add-rewards", { totalYield: totalYield.toString() }, err instanceof Error ? err : new Error(String(err)));
      logger.error(
        "Manual action required: call add_rewards",
        "manual-action",
        { totalYieldStroops: totalYield.toString() }
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
      logger.warn("Could not query accrued interest", "query-interest", { error: err instanceof Error ? err.message : String(err) });
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
      logger.transaction("Harvest interest transaction submitted", hash, "harvest-interest");

      // The contract harvests min(pending, pool_balance).
      // Re-query after harvest to see how much is left; the difference is what was harvested.
      const pendingAfter = await this.queryLendingAccruedInterest();
      const harvested = pendingBefore > pendingAfter
        ? pendingBefore - pendingAfter
        : pendingBefore; // fallback if query fails

      return harvested;
    } catch (err) {
      logger.error("harvest_interest failed", "harvest-interest", {}, err instanceof Error ? err : new Error(String(err)));
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
        logger.info("TTL bumped successfully", "ttl-bump", { contractName: c.name, contractId: c.id });
      } catch (err) {
        logger.error(`TTL bump failed for ${c.name}`, "ttl-bump", { contractName: c.name, contractId: c.id }, err instanceof Error ? err : new Error(String(err)));
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
      logger.info("Staking rate recalibrated", "recalibrate");
    } catch (err) {
      logger.error("Recalibrate failed", "recalibrate", {}, err instanceof Error ? err : new Error(String(err)));
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

      logger.info(
        "LP Pool stats",
        "lp-stats",
        {
          reserveXLM: xlm.toFixed(2),
          reserveSxlm: sxlm.toFixed(2),
          constantK: k.toFixed(2),
          accruedProtocolFeesXLM: Number(accruedFees) / 1e7
        }
      );
    } catch (err) {
      logger.warn("Could not query LP pool stats", "lp-stats", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ============================================================
  // Treasury recycling: withdraw protocol fees and pipe back as rewards
  // ============================================================

  async recycleTreasury(): Promise<void> {
    try {
      const treasuryBal = await getTreasuryBalance();

      if (treasuryBal < TREASURY_RECYCLE_THRESHOLD) {
        logger.info(
          "Treasury balance below threshold, skipping recycle",
          "treasury-recycle",
          {
            treasuryBalanceXLM: Number(treasuryBal) / 1e7,
            thresholdXLM: Number(TREASURY_RECYCLE_THRESHOLD) / 1e7
          }
        );
        return;
      }

      logger.financial(
        "Recycling treasury",
        treasuryBal,
        "XLM",
        "treasury-recycle",
        { action: "withdraw-and-recycle" }
      );

      await callWithdrawFees(treasuryBal);
      logger.financial(
        "Withdrew fees from treasury",
        treasuryBal,
        "XLM",
        "withdraw-fees",
        { destination: "admin_wallet" }
      );

      await callAddRewards(treasuryBal);
      logger.financial(
        "Recycled treasury to staking rewards",
        treasuryBal,
        "XLM",
        "add-rewards",
        { source: "treasury", destination: "stakers" }
      );
    } catch (err) {
      logger.error("Treasury recycle failed", "treasury-recycle", {}, err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ============================================================
  // Timelock execution: auto-execute queued proposals whose delay has elapsed
  // ============================================================

  async executeMaturedTimelocks(): Promise<void> {
    const govContractId = config.contracts.governanceContractId;

    // Get total proposal count
    const countRaw = await this.simulateView(govContractId, "proposal_count", []);
    const count = Number(countRaw ?? 0);
    if (count === 0) return;

    // Get current ledger sequence
    const keypair = Keypair.fromSecret(config.admin.secretKey);
    const account = await this.server.getAccount(keypair.publicKey());
    const currentLedger = account.sequenceNumber
      ? Number(account.sequenceNumber)
      : 0;

    for (let i = 0; i < Math.min(count, 100); i++) {
      try {
        const proposal = await this.simulateView(govContractId, "get_proposal", [
          nativeToScVal(BigInt(i), { type: "u64" }),
        ]) as any;

        if (!proposal || proposal.executed || !proposal.queued) continue;

        const entry = await this.simulateView(govContractId, "get_timelock_entry", [
          nativeToScVal(BigInt(i), { type: "u64" }),
        ]) as any;

        if (!entry || entry.cancelled) continue;

        const eta = Number(entry.eta_ledger ?? 0);
        if (currentLedger < eta) continue;

        logger.info(
          "Executing matured timelock",
          "timelock-execute",
          {
            proposalId: i,
            etaLedger: eta,
            currentLedger: currentLedger
          }
        );

        await this.executeAdminCall(govContractId, "execute_queued", [
          nativeToScVal(BigInt(i), { type: "u64" }),
        ]);

        // Apply the parameter change
        const paramKey = String(entry.param_key ?? "");
        const newValue = String(entry.new_value ?? "");
        if (paramKey) {
          await this.applyGovernanceParam(paramKey, newValue);
        }

        logger.info(
          "Proposal executed successfully",
          "timelock-execute",
          {
            proposalId: i,
            paramKey,
            newValue
          }
        );
      } catch (err) {
        logger.warn(`Could not process timelock for proposal ${i}`, "timelock-execute", { proposalId: i, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async applyGovernanceParam(paramKey: string, newValue: string): Promise<void> {
    const value = parseInt(newValue, 10);
    if (isNaN(value)) return;

    const { callSetCooldownPeriod, callUpdateCollateralFactor, callUpdateBorrowRate, callUpdateLiquidationThreshold, callSetLpProtocolFeeBps } =
      await import("../staking-engine/contractClient.js");

    try {
      switch (paramKey) {
        case "cooldown_period":       await callSetCooldownPeriod(value); break;
        case "collateral_factor":     await callUpdateCollateralFactor(value); break;
        case "borrow_rate_bps":       await callUpdateBorrowRate(value); break;
        case "liquidation_threshold": await callUpdateLiquidationThreshold(value); break;
        case "lp_protocol_fee_bps":   await callSetLpProtocolFeeBps(value); break;
        default:
          logger.info(`Param "${paramKey}" is governance-only, no contract call needed`, "apply-param", { paramKey });
      }
    } catch (err) {
      logger.error(`Failed to apply param "${paramKey}"`, "apply-param", { paramKey, value }, err instanceof Error ? err : new Error(String(err)));
    }
  }

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

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  rpc,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { config } from "../../config/index.js";
import { PrismaClient } from "@prisma/client";

// ─── Schemas ───────────────────────────────────────────────────────────────

const amountSchema = z.object({
  userAddress: z.string().min(56).max(56),
  amount: z.number().positive(),
});

const amountWithAssetSchema = z.object({
  userAddress: z.string().min(56).max(56),
  amount: z.number().positive(),
  assetAddress: z.string().min(56).max(56),
});

const liquidateSchema = z.object({
  liquidatorAddress: z.string().min(56).max(56),
  borrowerAddress: z.string().min(56).max(56),
  collateralAssetAddress: z.string().min(56).max(56),
});

// ─── Asset metadata ─────────────────────────────────────────────────────────

// Maps contract ID → human-readable symbol for display in API responses.
function buildAssetMetadata(): Record<string, string> {
  return {
    [config.contracts.sxlmTokenContractId]: "sXLM",
    [config.contracts.usdcContractId]: "USDC",
    [config.contracts.eurcContractId]: "EURC",
    [config.contracts.yxlmContractId]: "yXLM",
  };
}

// ─── Transaction builder helpers ────────────────────────────────────────────

const SOROBAN_FEE = "2000000"; // 0.2 XLM — absorbs simulation underestimates

async function buildContractTx(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: any[],
  userAddress: string
) {
  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);

  const account = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(account, {
    fee: SOROBAN_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const errStr = String(simResult.error);
    if (errStr.includes("UnreachableCodeReached")) {
      if (method === "deposit_collateral") {
        throw new Error(
          "Insufficient balance for the selected collateral asset. Acquire the asset first, then deposit it."
        );
      }
      if (method === "withdraw_collateral") {
        throw new Error(
          "Withdrawal would make your position unhealthy, or you have no collateral deposited."
        );
      }
      if (method === "borrow") {
        throw new Error(
          "Borrow exceeds your combined collateral limit. Deposit more collateral or reduce the borrow amount."
        );
      }
      if (method === "repay") {
        throw new Error("Repay amount exceeds your outstanding debt.");
      }
      if (method === "liquidate") {
        throw new Error(
          "This position cannot be liquidated — it may already be healthy or have no debt."
        );
      }
    }
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, simResult).build();
  return {
    xdr: preparedTx.toXDR(),
    networkPassphrase: config.stellar.networkPassphrase,
  };
}

async function queryContractView(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: any[]
) {
  const contract = new Contract(contractId);
  const op = contract.call(method, ...args);

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
    return scValToNative(simResult.result.retval);
  }
  return null;
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export const lendingRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  fastify,
  opts
) => {
  const { prisma } = opts;
  const server = new rpc.Server(config.stellar.rpcUrl);
  const lendingContractId = config.contracts.lendingContractId;
  const assetMeta = buildAssetMetadata();

  function symbolFor(address: string): string {
    return assetMeta[address] ?? address.slice(0, 8) + "…";
  }

  function classifyRisk(healthFactor: number): {
    riskLevel: "safe" | "warning" | "critical";
    recommendation: string;
  } {
    if (healthFactor <= 0) {
      return {
        riskLevel: "safe",
        recommendation: "No active debt position detected.",
      };
    }
    if (healthFactor < 1.0) {
      return {
        riskLevel: "critical",
        recommendation:
          "Position is liquidatable. Repay debt or add collateral immediately.",
      };
    }
    if (healthFactor < 1.5) {
      return {
        riskLevel: "warning",
        recommendation:
          "Health factor is low. Consider adding collateral or repaying part of your debt.",
      };
    }
    return {
      riskLevel: "safe",
      recommendation: "Position health is stable.",
    };
  }

  // ─── GET /lending/assets ───────────────────────────────────────────────────
  /**
   * Returns the list of supported collateral assets with their on-chain configuration.
   */
  fastify.get("/lending/assets", async (_request, reply) => {
    try {
      const rawAssets = await queryContractView(
        server,
        lendingContractId,
        "get_supported_assets",
        []
      );
      if (!rawAssets) return reply.status(503).send({ error: "Contract unavailable" });

      const assetAddresses: string[] = Array.isArray(rawAssets) ? rawAssets : [];

      const configs = await Promise.all(
        assetAddresses.map((addr) =>
          queryContractView(server, lendingContractId, "get_asset_config", [
            new Address(addr).toScVal(),
          ])
        )
      );

      return assetAddresses.map((addr, i) => {
        const cfg = configs[i];
        return {
          assetAddress: addr,
          symbol: symbolFor(addr),
          collateralFactorBps: Number(cfg?.collateral_factor_bps ?? 7000),
          liquidationThresholdBps: Number(cfg?.liquidation_threshold_bps ?? 8000),
          priceInXlm: Number(cfg?.price_in_xlm ?? 10_000_000) / 1e7,
        };
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch assets";
      return reply.status(500).send({ error: message });
    }
  });

  // ─── POST /lending/deposit-collateral ──────────────────────────────────────
  fastify.post("/lending/deposit-collateral", async (request, reply) => {
    try {
      const body = amountWithAssetSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      // Pre-flight: verify the user has enough of the requested asset
      const balanceRaw = await queryContractView(
        server,
        body.assetAddress,
        "balance",
        [new Address(body.userAddress).toScVal()]
      );
      const balance = BigInt(balanceRaw ?? 0);
      if (balance < stroops) {
        const available = (Number(balance) / 1e7).toFixed(7);
        const symbol = symbolFor(body.assetAddress);
        return reply.status(400).send({
          error: `Insufficient ${symbol} balance. You have ${available} ${symbol} but tried to deposit ${body.amount}.`,
        });
      }

      const result = await buildContractTx(
        server,
        lendingContractId,
        "deposit_collateral",
        [
          new Address(body.userAddress).toScVal(),
          new Address(body.assetAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Deposit failed";
      return reply.status(400).send({ error: message });
    }
  });

  // ─── POST /lending/withdraw-collateral ─────────────────────────────────────
  fastify.post("/lending/withdraw-collateral", async (request, reply) => {
    try {
      const body = amountWithAssetSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const result = await buildContractTx(
        server,
        lendingContractId,
        "withdraw_collateral",
        [
          new Address(body.userAddress).toScVal(),
          new Address(body.assetAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Withdraw failed";
      return reply.status(400).send({ error: message });
    }
  });

  // ─── POST /lending/borrow ──────────────────────────────────────────────────
  fastify.post("/lending/borrow", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      // Pre-flight: verify pool has sufficient XLM
      const poolBalRaw = await queryContractView(
        server,
        lendingContractId,
        "get_pool_balance",
        []
      );
      const poolBalance = BigInt(poolBalRaw ?? 0);
      if (poolBalance < stroops) {
        const available = (Number(poolBalance) / 1e7).toFixed(7);
        return reply.status(400).send({
          error: `Insufficient pool liquidity. Pool has ${available} XLM available but you tried to borrow ${body.amount} XLM.`,
        });
      }

      const result = await buildContractTx(
        server,
        lendingContractId,
        "borrow",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Borrow failed";
      return reply.status(400).send({ error: message });
    }
  });

  // ─── POST /lending/repay ───────────────────────────────────────────────────
  fastify.post("/lending/repay", async (request, reply) => {
    try {
      const body = amountSchema.parse(request.body);
      const stroops = BigInt(Math.floor(body.amount * 1e7));

      const result = await buildContractTx(
        server,
        lendingContractId,
        "repay",
        [
          new Address(body.userAddress).toScVal(),
          nativeToScVal(stroops, { type: "i128" }),
        ],
        body.userAddress
      );
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Repay failed";
      return reply.status(400).send({ error: message });
    }
  });

  // ─── POST /lending/liquidate ───────────────────────────────────────────────
  fastify.post("/lending/liquidate", async (request, reply) => {
    try {
      const body = liquidateSchema.parse(request.body);

      const result = await buildContractTx(
        server,
        lendingContractId,
        "liquidate",
        [
          new Address(body.liquidatorAddress).toScVal(),
          new Address(body.borrowerAddress).toScVal(),
          new Address(body.collateralAssetAddress).toScVal(),
        ],
        body.liquidatorAddress
      );
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Liquidation failed";
      return reply.status(400).send({ error: message });
    }
  });

  // ─── GET /lending/position/:wallet ────────────────────────────────────────
  fastify.get("/lending/position/:wallet", async (request, reply) => {
    try {
      const { wallet } = request.params as { wallet: string };
      const walletScVal = new Address(wallet).toScVal();

      // Fetch supported assets, user's multi-position, HF, and borrowed amount in parallel
      const [rawAssets, rawMultiPosition, healthFactorRaw, positionRaw] = await Promise.all([
        queryContractView(server, lendingContractId, "get_supported_assets", []),
        queryContractView(server, lendingContractId, "get_multi_position", [walletScVal]),
        queryContractView(server, lendingContractId, "health_factor", [walletScVal]),
        // get_position returns (total_collateral_value_xlm, borrowed) — use index [1] for borrowed
        queryContractView(server, lendingContractId, "get_position", [walletScVal]),
      ]);

      const assetAddresses: string[] = Array.isArray(rawAssets) ? rawAssets : [];

      // Fetch per-asset configs in parallel
      const assetConfigs = await Promise.all(
        assetAddresses.map((addr) =>
          queryContractView(server, lendingContractId, "get_asset_config", [
            new Address(addr).toScVal(),
          ])
        )
      );

      // Build a map of address → config for quick lookup
      const configByAddr: Record<string, any> = {};
      assetAddresses.forEach((addr, i) => {
        configByAddr[addr] = assetConfigs[i];
      });

      // Build per-asset position from get_multi_position result
      // rawMultiPosition is an array of {asset: string, amount: bigint}
      const multiPos: Array<{ asset: string; amount: bigint }> = Array.isArray(rawMultiPosition)
        ? rawMultiPosition
        : [];

      let totalCollateralValueXlm = 0;
      let maxBorrow = 0;
      const collateralAssets = multiPos
        .filter((p) => BigInt(p.amount ?? 0) > 0n)
        .map((p) => {
          const amount = BigInt(p.amount ?? 0);
          const cfg = configByAddr[p.asset] ?? {};
          const cfBps = Number(cfg.collateral_factor_bps ?? 7000);
          const ltBps = Number(cfg.liquidation_threshold_bps ?? 8000);
          const priceInXlmRaw = Number(cfg.price_in_xlm ?? 10_000_000);
          const priceInXlm = priceInXlmRaw / 1e7;
          const amountHuman = Number(amount) / 1e7;

          const valueXlm = amountHuman * priceInXlm;
          totalCollateralValueXlm += valueXlm;
          maxBorrow += valueXlm * (cfBps / 10_000);

          return {
            assetAddress: p.asset,
            symbol: symbolFor(p.asset),
            amount: amountHuman,
            amountRaw: amount.toString(),
            collateralFactorBps: cfBps,
            liquidationThresholdBps: ltBps,
            priceInXlm,
          };
        });

      // positionRaw = (total_collateral_value_xlm, borrowed) — extract borrowed (index 1)
      const xlmBorrowed = positionRaw ? BigInt(positionRaw[1] ?? 0) : 0n;
      const hf = healthFactorRaw !== null ? Number(healthFactorRaw) / 1e7 : 0;

      // Sync to DB
      const hasPosition = collateralAssets.length > 0 || xlmBorrowed > 0n;
      if (hasPosition) {
        const existing = await prisma.collateralPosition.findFirst({
          where: { wallet },
        });

        let positionId: number;
        if (existing) {
          await prisma.collateralPosition.update({
            where: { id: existing.id },
            data: {
              sxlmDeposited: BigInt(Math.round(totalCollateralValueXlm * 1e7)),
              xlmBorrowed,
              healthFactor: hf,
              updatedAt: new Date(),
            },
          });
          positionId = existing.id;
        } else {
          const created = await prisma.collateralPosition.create({
            data: {
              wallet,
              sxlmDeposited: BigInt(Math.round(totalCollateralValueXlm * 1e7)),
              xlmBorrowed,
              healthFactor: hf,
            },
          });
          positionId = created.id;
        }

        // Upsert per-asset breakdown
        for (const asset of collateralAssets) {
          await prisma.collateralAsset.upsert({
            where: {
              positionId_assetAddress: {
                positionId,
                assetAddress: asset.assetAddress,
              },
            },
            update: {
              amount: BigInt(asset.amountRaw),
              assetSymbol: asset.symbol,
              updatedAt: new Date(),
            },
            create: {
              positionId,
              assetAddress: asset.assetAddress,
              assetSymbol: asset.symbol,
              amount: BigInt(asset.amountRaw),
            },
          });
        }
      }

      return {
        wallet,
        collateralAssets,
        xlmBorrowed: Number(xlmBorrowed) / 1e7,
        xlmBorrowedRaw: xlmBorrowed.toString(),
        totalCollateralValueXlm,
        healthFactor: hf,
        maxBorrow,
      };
    } catch (err: unknown) {
      // Fallback to DB
      const { wallet } = request.params as { wallet: string };
      const dbPosition = await prisma.collateralPosition.findFirst({
        where: { wallet },
        orderBy: { updatedAt: "desc" },
        include: { collateralAssets: true },
      });

      if (!dbPosition) {
        return {
          wallet,
          collateralAssets: [],
          xlmBorrowed: 0,
          xlmBorrowedRaw: "0",
          totalCollateralValueXlm: 0,
          healthFactor: 0,
          maxBorrow: 0,
        };
      }

      return {
        wallet,
        collateralAssets: dbPosition.collateralAssets.map((a) => ({
          assetAddress: a.assetAddress,
          symbol: a.assetSymbol,
          amount: Number(a.amount) / 1e7,
          amountRaw: a.amount.toString(),
          collateralFactorBps: 7000,
          liquidationThresholdBps: 8000,
          priceInXlm: 1,
        })),
        xlmBorrowed: Number(dbPosition.xlmBorrowed) / 1e7,
        xlmBorrowedRaw: dbPosition.xlmBorrowed.toString(),
        totalCollateralValueXlm: Number(dbPosition.sxlmDeposited) / 1e7,
        healthFactor: dbPosition.healthFactor,
        maxBorrow: 0,
      };
    }
  });

  // ─── GET /lending/stats ───────────────────────────────────────────────────
  fastify.get("/lending/stats", async () => {
    try {
      const [rawAssets, totalBorrowedRaw, borrowRateBpsRaw, poolBalanceRaw] =
        await Promise.all([
          queryContractView(server, lendingContractId, "get_supported_assets", []),
          queryContractView(server, lendingContractId, "total_borrowed", []),
          queryContractView(server, lendingContractId, "get_borrow_rate", []),
          queryContractView(server, lendingContractId, "get_pool_balance", []),
        ]);

      const assetAddresses: string[] = Array.isArray(rawAssets) ? rawAssets : [];

      // Fetch per-asset totals and configs in parallel
      const [assetTotals, assetConfigs] = await Promise.all([
        Promise.all(
          assetAddresses.map((addr) =>
            queryContractView(
              server,
              lendingContractId,
              "total_collateral_by_asset",
              [new Address(addr).toScVal()]
            )
          )
        ),
        Promise.all(
          assetAddresses.map((addr) =>
            queryContractView(server, lendingContractId, "get_asset_config", [
              new Address(addr).toScVal(),
            ])
          )
        ),
      ]);

      const assets = assetAddresses.map((addr, i) => {
        const total = Number(assetTotals[i] ?? 0);
        const cfg = assetConfigs[i] ?? {};
        const cfBps = Number(cfg.collateral_factor_bps ?? 7000);
        const ltBps = Number(cfg.liquidation_threshold_bps ?? 8000);
        const priceInXlm = Number(cfg.price_in_xlm ?? 10_000_000) / 1e7;
        return {
          assetAddress: addr,
          symbol: symbolFor(addr),
          totalCollateral: total / 1e7,
          totalCollateralRaw: assetTotals[i]?.toString() ?? "0",
          collateralFactorBps: cfBps,
          liquidationThresholdBps: ltBps,
          priceInXlm,
        };
      });

      const totalBorrowed = Number(totalBorrowedRaw ?? 0);
      const poolBalance = Number(poolBalanceRaw ?? 0);

      // Compute total collateral value in XLM for utilization rate
      const totalCollateralValueXlm = assets.reduce(
        (sum, a) => sum + a.totalCollateral * a.priceInXlm,
        0
      );

      return {
        assets,
        totalBorrowed: totalBorrowed / 1e7,
        totalBorrowedRaw: (totalBorrowedRaw ?? 0).toString(),
        totalCollateralValueXlm,
        poolBalance: poolBalance / 1e7,
        borrowRateBps: Number(borrowRateBpsRaw ?? 500),
        utilizationRate:
          totalCollateralValueXlm > 0
            ? totalBorrowed / 1e7 / totalCollateralValueXlm
            : 0,
      };
    } catch {
      return {
        assets: [],
        totalBorrowed: 0,
        totalBorrowedRaw: "0",
        totalCollateralValueXlm: 0,
        poolBalance: 0,
        borrowRateBps: 500,
        utilizationRate: 0,
      };
    }
  });

  // ─── GET /lending/alerts/:wallet ──────────────────────────────────────────
  fastify.get("/lending/alerts/:wallet", async (request) => {
    const { wallet } = request.params as { wallet: string };

    try {
      const healthFactorRaw = await queryContractView(
        server,
        lendingContractId,
        "health_factor",
        [new Address(wallet).toScVal()]
      );

      const healthFactor = Number(healthFactorRaw ?? 0) / 1e7;
      const classification = classifyRisk(healthFactor);

      return {
        wallet,
        healthFactor,
        ...classification,
        source: "chain",
        timestamp: new Date().toISOString(),
      };
    } catch {
      const dbPosition = await prisma.collateralPosition.findFirst({
        where: { wallet },
        orderBy: { updatedAt: "desc" },
      });

      const healthFactor = dbPosition?.healthFactor ?? 0;
      const classification = classifyRisk(healthFactor);

      return {
        wallet,
        healthFactor,
        ...classification,
        source: "db",
        timestamp: new Date().toISOString(),
      };
    }
  });
};

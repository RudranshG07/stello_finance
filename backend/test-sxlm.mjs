/**
 * sXLM Protocol — Full E2E Test
 *
 * Robustness fixes:
 *  1. Shared Account object: TransactionBuilder.build() auto-increments sequence,
 *     so no re-fetch needed between invocations (eliminates txBadSeq).
 *  2. TRY_AGAIN_LATER handling: if the network is busy, retry sendTransaction.
 *  3. Longer poll (150 × 2s = 300s, matching tx timeout) for confirmation.
 *  4. Stable-read poll: after each tx, poll until the contract state reflects
 *     the change (instead of fixed waits that can be too short on testnet).
 *  5. Skip unreliable token-balance reads post-stake; verify via contract view.
 */
import {
  rpc, Contract, Address, nativeToScVal, scValToNative,
  Keypair, TransactionBuilder, BASE_FEE
} from "@stellar/stellar-sdk";

const RPC_URL    = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const SECRET     = "SDEFNLVOI2ILNXJGHFNJ5ZYOLVBAC2VSHF5TXKCDJX2SXRB5L75OBUBU";

const C = {
  staking:   "CBTSQ6AVMK63LXF3BA7WREUGXX2QYYQXKIO7KPZXCEAEAKRVWJS7J7K3",
  lending:   "CBY22XHGAIXFK5RROK4UAFC3BQH5D3ZKA3F2SWURHISB44EXXOYDAHYO",
  lpPool:    "CDDYQEF74BJ2D4D4SC5ZVWWFTWRP7APFHSPOLPRT7QIU5H6SGYN6KBIA",
  sxlmToken: "CCSST2JJPO2XX7XKPIEZBVE3YVT3OKVZWVOOCUULQYM2YTXRQYS24DUA",
  native:    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
};

const server  = new rpc.Server(RPC_URL);
const keypair = Keypair.fromSecret(SECRET);
const USER    = keypair.publicKey();
const wait    = ms => new Promise(r => setTimeout(r, ms));

// ── Shared account (sequence auto-managed by TransactionBuilder.build()) ───────
let _account = null;
async function loadAccount() {
  _account = await server.getAccount(USER);
  return _account;
}
function account() {
  if (!_account) throw new Error("Call loadAccount() first");
  return _account;
}

// ── Simulate (always fresh account — never affects shared sequence) ────────────
async function sim(contractId, method, args = []) {
  const fresh = await server.getAccount(USER);
  const tx = new TransactionBuilder(fresh, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30).build();
  const res = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(res) && res.result) return scValToNative(res.result.retval);
  if (rpc.Api.isSimulationError(res)) throw new Error(res.error);
  return null;
}

// ── Invoke (shared account, handles simulation retries + TRY_AGAIN_LATER + txBadSeq) ──
async function invoke(contractId, method, args = []) {
  const POLL_ITERS = 30;   // 60 s per attempt — Soroban testnet should confirm in <10s
  const MAX_RETRIES = 8;   // retry up to 8 times (timeout → tx dropped → reload + retry)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Cap delay at 15s for txBadSeq/sim-failure retries; 0 for timeout retries
      // (timeout retries already did loadAccount at the bottom of the loop)
      const delay = Math.min(5000 * attempt, 15000);
      console.log(`    ↻ retry ${attempt} (${delay / 1000}s wait)...`);
      await wait(delay);
      await loadAccount();  // always reload on retry (fixes stale sequence after failed build)
    }

    // Build tx (TransactionBuilder.build() increments _account sequence internally)
    const tx = new TransactionBuilder(account(), {
      fee: "5000000",  // 0.5 XLM max fee — ensures priority on congested testnet
      networkPassphrase: PASSPHRASE,
    }).addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(300).build();

    // prepareTransaction simulates the tx to compute Soroban resource fees.
    // If the simulation sees stale contract state, it may throw a HostError.
    // In that case, retry after reloading account (which resets the sequence).
    let prepared;
    try {
      prepared = await server.prepareTransaction(tx);
    } catch (simErr) {
      const msg = String(simErr?.message ?? simErr).slice(0, 150);
      console.log(`    ↻ simulation failed (attempt ${attempt}): ${msg}`);
      if (attempt < MAX_RETRIES - 1) continue;  // reload account and retry
      throw simErr;  // exhausted retries
    }

    prepared.sign(keypair);

    // sendTransaction with retry for TRY_AGAIN_LATER (network busy)
    let sent;
    for (let s = 0; s < 5; s++) {
      sent = await server.sendTransaction(prepared);
      if (sent.status !== "TRY_AGAIN_LATER") break;
      console.log(`    ⏳ TRY_AGAIN_LATER (${s + 1}/5) — waiting 3s...`);
      await wait(3000);
    }

    if (sent.status === "ERROR") {
      const errStr = JSON.stringify(sent.errorResult ?? sent);
      if (errStr.includes("txBadSeq")) continue;  // reload account and retry
      throw new Error(`${method} ERROR: ${errStr}`);
    }

    if (sent.status === "TRY_AGAIN_LATER") {
      continue;  // reload and retry
    }

    // PENDING or DUPLICATE — poll for on-chain confirmation
    console.log(`    📡 ${method} submitted [${sent.status}] hash: ${sent.hash}`);
    for (let i = 0; i < POLL_ITERS; i++) {
      const resp = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTransaction", params: { hash: sent.hash },
        }),
      });
      const j = await resp.json();
      const status = j.result?.status;
      if (status === "SUCCESS") return sent.hash;
      if (status === "FAILED") {
        throw new Error(`tx FAILED: ${JSON.stringify(j.result).slice(0, 300)}`);
      }
      await wait(2000);
    }
    // tx dropped by testnet (expired after setTimeout) — reload account and retry
    console.log(`    ↻ tx dropped by testnet (${POLL_ITERS * 2}s timeout), reloading...`);
    await loadAccount();
    continue;
  }
  throw new Error(`${method} failed after ${MAX_RETRIES} retries`);
}

// ── Poll helpers: wait until on-chain state stabilises ─────────────────────────
async function pollUntil(label, fn, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await fn().catch(() => false);
    if (ok) return true;
    await wait(2000);
  }
  throw new Error(`Timeout (${timeoutMs / 1000}s): ${label}`);
}

async function pollDebt(expected, timeoutMs = 60_000) {
  return pollUntil(`debt == ${expected}`, async () => {
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    return BigInt(pos[1]) === BigInt(expected);
  }, timeoutMs);
}

async function pollCollateral(expected, timeoutMs = 60_000) {
  return pollUntil(`collateral == ${expected}`, async () => {
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    return BigInt(pos[0]) === BigInt(expected);
  }, timeoutMs);
}

async function pollCollateralGt(minVal, timeoutMs = 60_000) {
  return pollUntil(`collateral > ${minVal}`, async () => {
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    return BigInt(pos[0]) > BigInt(minVal);
  }, timeoutMs);
}

async function pollTotalStakedGt(before, timeoutMs = 60_000) {
  return pollUntil(`total_staked > ${before}`, async () => {
    const ts = await sim(C.staking, "total_xlm_staked");
    return BigInt(ts) > BigInt(before);
  }, timeoutMs);
}

// ── Auth-safe repay loop ────────────────────────────────────────────────────────
// Root cause of repay FAILED: using REPAY_MAX causes auth mismatch.
//
// repay(user, xlm_amount) on-chain:
//   1. accrue_interest_for_user() → borrowed_fresh = stored_borrowed + delta
//   2. repay_amount = min(xlm_amount, borrowed_fresh)
//   3. transfer(user, contract, repay_amount)  ← auth tree records EXACT amount
//
// If xlm_amount = REPAY_MAX >> borrowed:
//   repay_amount_sim = borrowed_at_ledger_L_sim
//   repay_amount_exec = borrowed_at_ledger_L_exec  (L_exec > L_sim, more interest)
//   → amounts differ → "Unauthorized function call for address"
//
// Fix: pass xlm_amount = pos[1] (stored debt, ≤ borrowed_fresh always).
//   repay_amount = min(pos[1], borrowed_fresh) = pos[1]  (same at sim and exec)
//   → auth matches every time.
//
// Caveat: tiny residual (delta_interest ≈ 1-3 stroops) may remain because pos[1]
// < borrowed_fresh.  A second iteration (which then repays the residual) clears it.
// For that residual, pos[1]=residual ≈ 1-3 stroops → interest rounds to 0 → fully cleared.
async function repayFull() {
  for (let iter = 0; iter < 3; iter++) {
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    const debt = BigInt(pos[1]);
    if (debt === 0n) return;  // already clear

    tick(`  Repay iter ${iter + 1}: repaying ${xlm(debt)} XLM (exact amount, auth-safe)...`);
    const h = await invoke(C.lending, "repay", [
      new Address(USER).toScVal(),
      nativeToScVal(debt, { type: "i128" }),
    ]);
    tick(`  Repay tx: ${h}`);

    // Poll up to 40s for debt to clear (handles RPC staleness)
    const deadline = Date.now() + 40_000;
    let cleared = false;
    while (Date.now() < deadline) {
      await wait(3000);
      const p = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
      if (BigInt(p[1]) === 0n) { cleared = true; break; }
    }
    if (cleared) { tick("Debt cleared ✓"); return; }
    // Residual interest left — loop for one more targeted repay
    console.log("    ↻ Tiny residual debt detected — doing follow-up repay...");
  }

  // Final verification
  const p = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
  if (BigInt(p[1]) > 0n) throw new Error(`Debt not cleared: ${xlm(p[1])} XLM remaining`);
  tick("Debt cleared ✓");
}

// ── Test harness ───────────────────────────────────────────────────────────────
const xlm     = n => (Number(n) / 1e7).toFixed(7);
const tick    = msg => console.log(`  ✅ ${msg}`);
const cross   = msg => console.log(`  ❌ ${msg}`);
const section = msg => console.log(`\n── ${msg}`);
let passed = 0, failed = 0;

async function check(label, fn) {
  try { await fn(); passed++; }
  catch (e) { cross(`${label}: ${e.message.slice(0, 160)}`); failed++; }
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${"=".repeat(64)}`);
  console.log("sXLM Protocol — Full E2E Test");
  console.log(`User: ${USER}`);
  console.log(`${"=".repeat(64)}\n`);

  await loadAccount();

  // ── 1. Read-only contract state ──────────────────────────────────────────
  section("1. Contract state (read-only)");
  await check("exchange rate", async () => {
    const r = await sim(C.staking, "get_exchange_rate");
    tick(`Exchange rate: ${xlm(r)} XLM/sXLM`);
  });
  await check("total staked", async () => {
    const r = await sim(C.staking, "total_xlm_staked");
    tick(`Total staked: ${xlm(r)} XLM`);
  });
  await check("total sXLM supply", async () => {
    const r = await sim(C.staking, "total_sxlm_supply");
    tick(`Total sXLM supply: ${xlm(r)} sXLM`);
  });
  await check("staking active", async () => {
    const r = await sim(C.staking, "is_paused");
    if (r) throw new Error("staking is paused!");
    tick("Staking active");
  });
  await check("lending active", async () => {
    const r = await sim(C.lending, "is_paused");
    if (r) throw new Error("lending is paused!");
    tick("Lending active");
  });
  await check("LP fee bps", async () => {
    const r = await sim(C.lpPool, "get_fee_bps");
    tick(`LP fee: ${r} bps = ${Number(r) / 100}%`);
  });
  await check("accrued interest", async () => {
    const r = await sim(C.lending, "total_accrued_interest");
    tick(`Accrued interest: ${xlm(r)} XLM`);
  });

  // ── 2. Starting balances ─────────────────────────────────────────────────
  section("2. Starting balances");
  let xlmStart, sxlmStart;
  await check("XLM balance", async () => {
    xlmStart = await sim(C.native, "balance", [new Address(USER).toScVal()]);
    tick(`XLM: ${xlm(xlmStart)}`);
  });
  await check("sXLM balance", async () => {
    sxlmStart = await sim(C.sxlmToken, "balance", [new Address(USER).toScVal()]);
    tick(`sXLM: ${xlm(sxlmStart)}`);
  });
  await check("existing position", async () => {
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    tick(`Position: col=${xlm(pos[0])} sXLM  debt=${xlm(pos[1])} XLM`);
  });

  // ── 3. Repay any leftover debt first ─────────────────────────────────────
  section("3. Clear existing debt (if any)");
  await check("repay leftover debt", async () => {
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    const debt = BigInt(pos[1]);
    if (debt === 0n) { tick("No debt — clean"); return; }
    tick(`Existing debt: ${xlm(debt)} XLM — repaying with auth-safe loop...`);
    await repayFull();
  });

  // ── 4. Withdraw any leftover collateral ──────────────────────────────────
  section("4. Clear existing collateral (if any)");
  await check("withdraw leftover collateral", async () => {
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    const col = BigInt(pos[0]);
    if (col === 0n) { tick("No collateral — clean"); return; }
    tick(`Existing collateral: ${xlm(col)} sXLM — withdrawing...`);
    const hash = await invoke(C.lending, "withdraw_collateral", [
      new Address(USER).toScVal(),
      nativeToScVal(col, { type: "i128" }),
    ]);
    tick(`Withdraw tx: ${hash}`);
    await pollCollateral(0n, 60_000);
    tick("Collateral cleared ✓");
  });

  // ── 5. Stake ─────────────────────────────────────────────────────────────
  section("5. Stake 10 XLM");
  await check("deposit 10 XLM into staking", async () => {
    // Use total_xlm_staked as a reliable proxy — it updates immediately on-chain
    const stakedBefore = await sim(C.staking, "total_xlm_staked");
    const STAKE = BigInt(10_0000000);
    const hash = await invoke(C.staking, "deposit", [
      new Address(USER).toScVal(),
      nativeToScVal(STAKE, { type: "i128" }),
    ]);
    tick(`Stake tx: ${hash}`);
    // Poll total_staked via the staking contract — more reliable than token balance
    await pollTotalStakedGt(stakedBefore, 60_000);
    const stakedAfter = await sim(C.staking, "total_xlm_staked");
    tick(`Total staked: ${xlm(stakedBefore)} → ${xlm(stakedAfter)} XLM`);
    const rate = await sim(C.staking, "get_exchange_rate");
    tick(`Exchange rate: ${xlm(rate)} XLM/sXLM`);
    // Read sXLM balance (may still be stale — just informational)
    const sxlmNow = await sim(C.sxlmToken, "balance", [new Address(USER).toScVal()]);
    tick(`sXLM balance (may be cached): ${xlm(sxlmNow)}`);
  });

  // ── 6. Deposit collateral ─────────────────────────────────────────────────
  section("6. Deposit 2 sXLM collateral");
  const COLLATERAL = BigInt(2_0000000);
  await check("deposit_collateral", async () => {
    // Verify we have enough sXLM (poll until balance reflects the stake)
    await pollUntil("sxlm balance >= 2", async () => {
      const b = await sim(C.sxlmToken, "balance", [new Address(USER).toScVal()]);
      return BigInt(b) >= COLLATERAL;
    }, 90_000);  // give up to 90s for RPC to reflect stake

    const hash = await invoke(C.lending, "deposit_collateral", [
      new Address(USER).toScVal(),
      nativeToScVal(COLLATERAL, { type: "i128" }),
    ]);
    tick(`Collateral tx: ${hash}`);
    // Poll until the lending contract reflects the collateral (authoritative check)
    await pollCollateralGt(0n, 60_000);
    tick("Collateral confirmed by contract ✓");
    // RPC reads can still be stale after poll — just display for info, don't assert
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    tick(`Position (may be stale): col=${xlm(pos[0])} sXLM  debt=${xlm(pos[1])} XLM`);
  });

  // ── 7. Health factor (pre-borrow) ─────────────────────────────────────────
  await check("health factor (no debt)", async () => {
    const hf = await sim(C.lending, "health_factor", [new Address(USER).toScVal()]);
    tick(`Health factor: ${(Number(hf) / 1e7).toFixed(4)} (no debt → very high)`);
  });

  // ── 8. Borrow ─────────────────────────────────────────────────────────────
  section("7. Borrow 1 XLM");
  const BORROW = BigInt(1_0000000);
  await check("borrow", async () => {
    // Ensure RPC simulation sees current collateral before building the borrow tx.
    // prepareTransaction simulates against the current ledger; stale state → InvalidAction.
    await pollCollateralGt(0n, 60_000);
    const hash = await invoke(C.lending, "borrow", [
      new Address(USER).toScVal(),
      nativeToScVal(BORROW, { type: "i128" }),
    ]);
    tick(`Borrow tx: ${hash}`);
    // Poll until debt is reflected
    await pollUntil("debt > 0", async () => {
      const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
      return BigInt(pos[1]) > 0n;
    }, 60_000);
    const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
    tick(`Position: col=${xlm(pos[0])} sXLM  debt=${xlm(pos[1])} XLM`);
    const hf  = await sim(C.lending, "health_factor", [new Address(USER).toScVal()]);
    tick(`Health factor: ${(Number(hf) / 1e7).toFixed(4)}`);
    const int = await sim(C.lending, "total_accrued_interest");
    tick(`Protocol accrued interest: ${xlm(int)} XLM`);
  });

  // ── 9. Repay ─────────────────────────────────────────────────────────────
  section("8. Repay borrow");
  await check("repay", async () => {
    // First ensure the borrow is visible in RPC state
    await pollUntil("debt > 0 after borrow", async () => {
      const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
      return BigInt(pos[1]) > 0n;
    }, 60_000);
    // repayFull uses exact stored debt each iteration — auth-safe, handles tiny residual
    await repayFull();
  });

  // ── 10. Withdraw collateral ──────────────────────────────────────────────
  section("9. Withdraw collateral");
  await check("withdraw_collateral", async () => {
    // Poll until collateral is visible after repay cleared the debt
    let colToWithdraw = 0n;
    await pollUntil("collateral > 0 visible", async () => {
      const pos = await sim(C.lending, "get_position", [new Address(USER).toScVal()]);
      const c = BigInt(pos[0]);
      if (c > 0n) { colToWithdraw = c; return true; }
      return false;
    }, 60_000);
    tick(`Withdrawing ${xlm(colToWithdraw)} sXLM...`);
    const hash = await invoke(C.lending, "withdraw_collateral", [
      new Address(USER).toScVal(),
      nativeToScVal(colToWithdraw, { type: "i128" }),
    ]);
    tick(`Withdraw collateral tx: ${hash}`);
    await pollCollateral(0n, 60_000);
    tick("Collateral returned ✓");
    // Give RPC extra time to propagate account sequence before next tx
    await wait(6000);
  });

  // ── 11. Request staking withdrawal ──────────────────────────────────────
  section("10. Request staking withdrawal (2 sXLM)");
  await check("request_withdrawal", async () => {
    const WDRAW = BigInt(2_0000000);
    // Poll until sXLM balance reflects the withdrawn collateral (RPC can lag)
    await pollUntil("sxlm >= 2", async () => {
      const b = await sim(C.sxlmToken, "balance", [new Address(USER).toScVal()]);
      return BigInt(b) >= WDRAW;
    }, 90_000);
    // Re-read account so sequence is fresh after the 6s wait + any poll time
    await loadAccount();
    const hash = await invoke(C.staking, "request_withdrawal", [
      new Address(USER).toScVal(),
      nativeToScVal(WDRAW, { type: "i128" }),
    ]);
    tick(`Withdrawal request tx: ${hash}`);
  });

  // ── 12. Final state ──────────────────────────────────────────────────────
  section("11. Final state");
  await check("final snapshot", async () => {
    await wait(3000);
    const rate     = await sim(C.staking, "get_exchange_rate");
    const staked   = await sim(C.staking, "total_xlm_staked");
    const treasury = await sim(C.staking, "treasury_balance");
    const interest = await sim(C.lending, "total_accrued_interest");
    const xlmFin   = await sim(C.native,  "balance", [new Address(USER).toScVal()]);
    const sxlmFin  = await sim(C.sxlmToken, "balance", [new Address(USER).toScVal()]);
    const posFin   = await sim(C.lending,   "get_position", [new Address(USER).toScVal()]);
    tick(`Exchange rate:    ${xlm(rate)} XLM/sXLM`);
    tick(`Total staked:     ${xlm(staked)} XLM`);
    tick(`Treasury:         ${xlm(treasury)} XLM`);
    tick(`Accrued interest: ${xlm(interest)} XLM`);
    tick(`User XLM:         ${xlm(xlmFin)}`);
    tick(`User sXLM:        ${xlm(sxlmFin)}`);
    tick(`User position:    col=${xlm(posFin[0])} sXLM  debt=${xlm(posFin[1])} XLM`);
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(64)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(64)}\n`);
  if (failed > 0) process.exit(1);
})();

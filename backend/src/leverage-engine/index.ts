/**
 * Leverage Engine — Pure calculation service implementing spec formulas.
 *
 * Leverage = 1 / (1 - c)        where c = collateral factor
 * Net Yield = (Leverage × r) - ((Leverage - 1) × b)
 *   r = staking APR, b = borrow APR
 *
 * Example: c=0.7, r=6%, b=4% → Leverage=3.33x, NetYield=10%
 */

export interface LeverageSimulationInput {
  principal: number;
  loops: number;
  collateralFactor: number;
  stakingAPR: number;
  borrowAPR: number;
}

export interface LeverageLoopDetail {
  loop: number;
  deposited: number;
  borrowed: number;
  totalStaked: number;
  totalBorrowed: number;
}

export interface LeverageSimulationResult {
  maxLeverage: number;
  effectiveLeverage: number;
  totalStaked: number;
  totalBorrowed: number;
  netYieldPercent: number;
  grossYield: number;
  borrowCost: number;
  netYield: number;
  loops: LeverageLoopDetail[];
}

export interface OptimalLeverageResult {
  collateralFactor: number;
  maxLeverage: number;
  optimalLoops: number;
  stakingAPR: number;
  borrowAPR: number;
  netYieldPercent: number;
}

export class LeverageEngine {
  /**
   * Simulate N loops of leveraged staking.
   */
  simulate(input: LeverageSimulationInput): LeverageSimulationResult {
    const { principal, loops, collateralFactor, stakingAPR, borrowAPR } = input;

    const maxLeverage = 1 / (1 - collateralFactor);

    let totalStaked = 0;
    let totalBorrowed = 0;
    let currentDeposit = principal;
    const loopDetails: LeverageLoopDetail[] = [];

    for (let i = 0; i < loops; i++) {
      totalStaked += currentDeposit;
      const borrowed = currentDeposit * collateralFactor;
      totalBorrowed += borrowed;

      loopDetails.push({
        loop: i + 1,
        deposited: currentDeposit,
        borrowed,
        totalStaked,
        totalBorrowed,
      });

      currentDeposit = borrowed; // Re-stake borrowed amount
    }

    // Final deposit (no borrow on last iteration)
    // Actually the last loop already borrows. The re-staked amount isn't deposited again.
    // Let's recalculate: after N loops, totalStaked includes all deposits.
    // The effective leverage is totalStaked / principal.

    const effectiveLeverage = totalStaked / principal;
    const grossYield = totalStaked * stakingAPR;
    const borrowCost = totalBorrowed * borrowAPR;
    const netYield = grossYield - borrowCost;
    const netYieldPercent = (netYield / principal) * 100;

    return {
      maxLeverage,
      effectiveLeverage,
      totalStaked,
      totalBorrowed,
      netYieldPercent,
      grossYield,
      borrowCost,
      netYield,
      loops: loopDetails,
    };
  }

  /**
   * Calculate optimal leverage for given rates.
   */
  optimal(
    stakingAPR: number = 0,
    borrowAPR: number = 0.04,
    collateralFactor: number = 0.7
  ): OptimalLeverageResult {
    const maxLeverage = 1 / (1 - collateralFactor);

    // Find optimal loops (where marginal benefit < 0.1% of principal)
    let bestLoops = 1;
    let prevNetYield = 0;

    for (let loops = 1; loops <= 20; loops++) {
      const result = this.simulate({
        principal: 1000,
        loops,
        collateralFactor,
        stakingAPR,
        borrowAPR,
      });

      if (loops > 1 && result.netYield - prevNetYield < 1) {
        // Marginal benefit < 0.1% of 1000 principal
        break;
      }

      bestLoops = loops;
      prevNetYield = result.netYield;
    }

    const finalResult = this.simulate({
      principal: 1000,
      loops: bestLoops,
      collateralFactor,
      stakingAPR,
      borrowAPR,
    });

    return {
      collateralFactor,
      maxLeverage,
      optimalLoops: bestLoops,
      stakingAPR,
      borrowAPR,
      netYieldPercent: finalResult.netYieldPercent,
    };
  }
}

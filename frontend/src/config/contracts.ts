export const NETWORK = {
  name: import.meta.env.VITE_NETWORK_NAME || 'MAINNET',
  networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE || 'Public Global Stellar Network ; September 2015',
  horizonUrl: import.meta.env.VITE_HORIZON_URL || 'https://horizon.stellar.org',
  sorobanRpcUrl: import.meta.env.VITE_SOROBAN_RPC_URL || 'https://mainnet.sorobanrpc.com',
  friendbotUrl: '',
} as const;

export const CONTRACTS = {
  // Deployed to mainnet ✅
  sxlmToken: import.meta.env.VITE_SXLM_TOKEN_CONTRACT_ID || 'CCGFHMW3NZD5Z7ATHYHZSEG6ABCJADUHP5HIAWFPR37CP4VGNEDQO7FJ',
  staking: import.meta.env.VITE_STAKING_CONTRACT_ID || 'CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS',
  lending: import.meta.env.VITE_LENDING_CONTRACT_ID || 'CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG',
  lpPool: import.meta.env.VITE_LP_POOL_CONTRACT_ID || 'CAW2DRMOI3CCJWKVMEUWYJUEQHXB4S4DR72HNL2DWQCMQQUH3LFFVLHV',
  governance: import.meta.env.VITE_GOVERNANCE_CONTRACT_ID || 'CB7LV3FBQ7US26GVC7SM7RMX22IEEHAEUL7V3TDDWM32DHA5TDFDDEP4',
} as const;

export interface CollateralAssetMeta {
  symbol: string;
  name: string;
  contractId: string;
  /** Default collateral factor BPS shown in the UI before on-chain data loads. */
  defaultCollateralFactorBps: number;
  /** Default liquidation threshold BPS shown in the UI before on-chain data loads. */
  defaultLiquidationThresholdBps: number;
  decimals: number;
  color: string;
}

/** Ordered list of collateral assets supported by the lending protocol. */
export const SUPPORTED_COLLATERAL_ASSETS: CollateralAssetMeta[] = [
  {
    symbol: 'sXLM',
    name: 'Staked XLM',
    contractId:
      import.meta.env.VITE_SXLM_TOKEN_CONTRACT_ID ||
      'CCGFHMW3NZD5Z7ATHYHZSEG6ABCJADUHP5HIAWFPR37CP4VGNEDQO7FJ',
    defaultCollateralFactorBps: 7500,
    defaultLiquidationThresholdBps: 8000,
    decimals: 7,
    color: '#F5CF00',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    contractId:
      import.meta.env.VITE_USDC_CONTRACT_ID ||
      'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7EJJUD',
    defaultCollateralFactorBps: 9000,
    defaultLiquidationThresholdBps: 9500,
    decimals: 7,
    color: '#2775CA',
  },
  {
    symbol: 'EURC',
    name: 'Euro Coin',
    contractId:
      import.meta.env.VITE_EURC_CONTRACT_ID ||
      'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP',
    defaultCollateralFactorBps: 8500,
    defaultLiquidationThresholdBps: 9000,
    decimals: 7,
    color: '#0050AA',
  },
  {
    symbol: 'yXLM',
    name: 'Yield XLM',
    contractId:
      import.meta.env.VITE_YXLM_CONTRACT_ID ||
      'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55',
    defaultCollateralFactorBps: 7000,
    defaultLiquidationThresholdBps: 7500,
    decimals: 7,
    color: '#00D4AA',
  },
];

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export const PROTOCOL_CONFIG = {
  minStakeAmount: 1,
  maxStakeAmount: 1_000_000,
  unbondingPeriodDays: 21,
  instantWithdrawFeePercent: 0.5,
  decimals: 7,
  xlmDecimals: 7,
  tokenSymbol: 'sXLM',
  nativeSymbol: 'XLM',
} as const;

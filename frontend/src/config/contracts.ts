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

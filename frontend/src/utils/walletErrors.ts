/**
 * Wallet error utilities for improved user experience
 * Provides categorization and user-friendly messages for wallet connection errors
 */

export type WalletErrorType = 
  | 'freighter_missing'
  | 'freighter_locked' 
  | 'user_rejected'
  | 'network_error'
  | 'auth_failed'
  | 'unknown';

export interface WalletErrorInfo {
  type: WalletErrorType;
  title: string;
  message: string;
  action: string;
  canRetry: boolean;
  autoRetry: boolean;
}

export const WALLET_ERROR_MESSAGES: Record<WalletErrorType, WalletErrorInfo> = {
  freighter_missing: {
    type: 'freighter_missing',
    title: 'Freighter Wallet Not Found',
    message: 'Please install the Freighter wallet extension from freighter.app',
    action: 'Install Freighter',
    canRetry: false,
    autoRetry: false,
  },
  freighter_locked: {
    type: 'freighter_locked',
    title: 'Wallet Locked',
    message: 'Please unlock your Freighter wallet and try again',
    action: 'Unlock Wallet',
    canRetry: true,
    autoRetry: false,
  },
  user_rejected: {
    type: 'user_rejected',
    title: 'Connection Rejected',
    message: 'You rejected the connection request. Please try again if you want to connect.',
    action: 'Try Again',
    canRetry: true,
    autoRetry: false,
  },
  network_error: {
    type: 'network_error',
    title: 'Network Error',
    message: 'Unable to connect to the network. Please check your internet connection.',
    action: 'Retry',
    canRetry: true,
    autoRetry: true,
  },
  auth_failed: {
    type: 'auth_failed',
    title: 'Authentication Failed',
    message: 'Unable to authenticate with the backend. Please try again.',
    action: 'Retry',
    canRetry: true,
    autoRetry: true,
  },
  unknown: {
    type: 'unknown',
    title: 'Connection Error',
    message: 'An unexpected error occurred. Please try again.',
    action: 'Retry',
    canRetry: true,
    autoRetry: false,
  }
} as const;

export function categorizeWalletError(error: Error | string): WalletErrorType {
  const message = typeof error === 'string' ? error : error.message;
  
  if (message.includes('not detected') || message.includes('freighter')) {
    return 'freighter_missing';
  }
  if (message.includes('unlock') || message.includes('locked')) {
    return 'freighter_locked';
  }
  if (message.includes('rejected') || message.includes('denied') || message.includes('user rejected')) {
    return 'user_rejected';
  }
  if (message.includes('network') || message.includes('fetch') || message.includes('timeout') || message.includes('ECONNRESET')) {
    return 'network_error';
  }
  if (message.includes('auth') || message.includes('login') || message.includes('token') || message.includes('unauthorized')) {
    return 'auth_failed';
  }
  return 'unknown';
}

export function getWalletErrorInfo(error: Error | string): WalletErrorInfo {
  const errorType = categorizeWalletError(error);
  return WALLET_ERROR_MESSAGES[errorType];
}

export function formatWalletErrorMessage(error: Error | string): string {
  const errorInfo = getWalletErrorInfo(error);
  return `${errorInfo.title}: ${errorInfo.message}`;
}

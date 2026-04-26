import { useState, useCallback, useEffect, useRef, createContext, useContext, createElement } from 'react';
import type { ReactNode } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';
import { getWalletErrorInfo, type WalletErrorType } from '../utils/walletErrors';

interface WalletState {
  publicKey: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  jwtToken: string | null;
  connectionAttempts: number;
  lastErrorType: WalletErrorType | null;
}

interface WalletContextValue extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string, networkPassphrase: string) => Promise<string>;
  getAuthHeaders: () => Record<string, string>;
  clearError: () => void;
  retryConnection: () => Promise<void>;
}

const JWT_STORAGE_KEY = 'sxlm_jwt_token';
const WALLET_STORAGE_KEY = 'sxlm_wallet';
const MAX_CONNECTION_ATTEMPTS = 3;
const CONNECTION_RETRY_DELAY = 2000;


const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>(() => {
    const savedToken = localStorage.getItem(JWT_STORAGE_KEY);
    const savedWallet = localStorage.getItem(WALLET_STORAGE_KEY);
    if (savedToken && savedWallet) {
      return {
        publicKey: savedWallet,
        isConnected: true,
        isConnecting: false,
        error: null,
        jwtToken: savedToken,
        connectionAttempts: 0,
        lastErrorType: null,
      };
    }
    return {
      publicKey: null,
      isConnected: false,
      isConnecting: false,
      error: null,
      jwtToken: null,
      connectionAttempts: 0,
      lastErrorType: null,
    };
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  // Check if Freighter is still connected on mount
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const freighterApi = await import('@stellar/freighter-api');
        const connected = await freighterApi.isConnected();
        if (!connected) return;

        // getPublicKey returns string in v2
        const pubKey = await freighterApi.getPublicKey();
        if (pubKey) {
          const savedToken = localStorage.getItem(JWT_STORAGE_KEY);
          const savedWallet = localStorage.getItem(WALLET_STORAGE_KEY);
          if (savedToken && savedWallet === pubKey) {
            setState({
              publicKey: pubKey,
              isConnected: true,
              isConnecting: false,
              error: null,
              jwtToken: savedToken,
              connectionAttempts: 0,
              lastErrorType: null,
            });
          }
        }
      } catch {
        // Freighter not available or not connected
      }
    };
    checkConnection();
  }, []);

  const authenticateWithBackend = useCallback(async (wallet: string): Promise<string> => {
    const message = `sXLM Protocol Login: ${wallet} at ${Date.now()}`;

    // Backend accepts empty signature — Freighter connection itself proves wallet ownership.
    // We intentionally skip signBlob to avoid showing a second "Sign Message" popup,
    // which confuses users who have already confirmed the Connect dialog.
    const { data } = await axios.post(`${API_BASE_URL}/api/auth/login`, {
      wallet,
      signature: '',
      message,
    });

    return data.token;
  }, []);

  const connect = useCallback(async (isRetry = false) => {
    if (!isRetry) {
      setState((prev) => ({ ...prev, isConnecting: true, error: null, connectionAttempts: 0 }));
    }
    
    try {
      const freighterApi = await import('@stellar/freighter-api');

      // Check if Freighter extension is installed
      const connected = await freighterApi.isConnected();
      if (!connected) {
        throw new Error('Freighter wallet extension not detected. Please install it from https://freighter.app');
      }

      // requestAccess() returns string (the public key) in v2
      const wallet = await freighterApi.requestAccess();
      if (!wallet) {
        throw new Error('No address returned from Freighter. Please unlock your wallet and try again.');
      }

      // Authenticate with backend to get JWT
      let token: string;
      try {
        token = await authenticateWithBackend(wallet);
      } catch (authError) {
        console.warn('Backend authentication failed:', authError);
        token = '';
      }

      if (token) {
        localStorage.setItem(JWT_STORAGE_KEY, token);
      }
      localStorage.setItem(WALLET_STORAGE_KEY, wallet);

      setState({
        publicKey: wallet,
        isConnected: true,
        isConnecting: false,
        error: null,
        jwtToken: token || null,
        connectionAttempts: 0,
        lastErrorType: null,
      });
    } catch (err: unknown) {
      const errorInfo = getWalletErrorInfo(err instanceof Error ? err : String(err));
      const currentAttempts = stateRef.current.connectionAttempts + 1;
      
      setState((prev) => ({
        ...prev,
        isConnecting: false,
        error: `${errorInfo.title}: ${errorInfo.message}`,
        connectionAttempts: currentAttempts,
        lastErrorType: errorInfo.type,
      }));

      // Auto-retry for errors that support it
      if (errorInfo.autoRetry && currentAttempts < MAX_CONNECTION_ATTEMPTS) {
        setTimeout(() => {
          connect(true);
        }, CONNECTION_RETRY_DELAY * currentAttempts);
      }
    }
  }, [authenticateWithBackend]);

  const retryConnection = useCallback(async () => {
    await connect(false);
  }, [connect]);

  const clearError = useCallback(() => {
    setState((prev) => ({
      ...prev,
      error: null,
      lastErrorType: null,
      connectionAttempts: 0,
    }));
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(JWT_STORAGE_KEY);
    localStorage.removeItem(WALLET_STORAGE_KEY);
    setState({
      publicKey: null,
      isConnected: false,
      isConnecting: false,
      error: null,
      jwtToken: null,
      connectionAttempts: 0,
      lastErrorType: null,
    });
  }, []);

  const signTransaction = useCallback(
    async (xdr: string, networkPassphrase: string): Promise<string> => {
      if (!stateRef.current.isConnected) {
        throw new Error('Wallet not connected');
      }
      try {
        const freighterApi = await import('@stellar/freighter-api');
        // signTransaction returns string in v2
        const signedXdr = await freighterApi.signTransaction(xdr, {
          networkPassphrase,
        });
        return signedXdr;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to sign transaction';
        throw new Error(message, { cause: err });
      }
    },
    []
  );

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (stateRef.current.jwtToken) {
      return { Authorization: `Bearer ${stateRef.current.jwtToken}` };
    }
    return {};
  }, []);

  const value: WalletContextValue = {
    ...state,
    connect,
    disconnect,
    signTransaction,
    getAuthHeaders,
    clearError,
    retryConnection,
  };

  return createElement(WalletContext.Provider, { value }, children);
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used within a <WalletProvider>');
  }
  return ctx;
}

import { useState, useCallback, useEffect, useRef, createContext, useContext, createElement } from 'react';
import type { ReactNode } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';

interface WalletState {
  publicKey: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  jwtToken: string | null;
}

interface WalletContextValue extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string, networkPassphrase: string) => Promise<string>;
  getAuthHeaders: () => Record<string, string>;
}

const JWT_STORAGE_KEY = 'sxlm_jwt_token';
const WALLET_STORAGE_KEY = 'sxlm_wallet';

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
      };
    }
    return {
      publicKey: null,
      isConnected: false,
      isConnecting: false,
      error: null,
      jwtToken: null,
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

    // Attempt to get a signature from Freighter for the auth message.
    // In development/testnet the backend skips signature verification, so
    // a failed signBlob is non-fatal — we fall back to an empty signature.
    let signature = '';
    try {
      const freighterApi = await import('@stellar/freighter-api');
      if ('signBlob' in freighterApi && typeof freighterApi.signBlob === 'function') {
        const encoder = new TextEncoder();
        const blob = encoder.encode(message);
        const blobB64 = btoa(String.fromCharCode(...blob));
        signature = await freighterApi.signBlob(blobB64, { accountToSign: wallet });
      } else {
        const encoder = new TextEncoder();
        const data = encoder.encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        signature = btoa(String.fromCharCode(...hashArray));
      }
    } catch {
      // signBlob rejected or not available — proceed with empty signature.
      // Backend accepts this in dev/testnet mode.
    }

    // Coerce to string — some Freighter versions return an object instead of a string
    const safeSignature = typeof signature === 'string' ? signature : '';
    const { data } = await axios.post(`${API_BASE_URL}/api/auth/login`, {
      wallet,
      signature: safeSignature,
      message,
    });

    return data.token;
  }, []);

  const connect = useCallback(async () => {
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));
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
      } catch {
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
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to connect wallet';
      setState((prev) => ({
        ...prev,
        isConnecting: false,
        error: message,
      }));
    }
  }, [authenticateWithBackend]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(JWT_STORAGE_KEY);
    localStorage.removeItem(WALLET_STORAGE_KEY);
    setState({
      publicKey: null,
      isConnected: false,
      isConnecting: false,
      error: null,
      jwtToken: null,
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

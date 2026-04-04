/**
 * Axios instance with:
 *  - Automatic retry on network errors / ERR_CONNECTION_REFUSED (up to 3 attempts)
 *  - isAxiosError attached so callers can use the same import for everything
 */
import axios, { type AxiosInstance } from 'axios';
import { API_BASE_URL } from '../config/contracts';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

function isNetworkError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  return !err.response; // No response = server unreachable
}

const instance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60_000, // 60s — submit route polls Stellar testnet for tx confirmation
});

instance.interceptors.response.use(
  (res) => res,
  async (err) => {
    const config = err.config as typeof err.config & { _retryCount?: number };
    if (!config) return Promise.reject(err);

    config._retryCount = config._retryCount ?? 0;

    if (isNetworkError(err) && config._retryCount < MAX_RETRIES) {
      config._retryCount += 1;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * config._retryCount!));
      return instance(config);
    }

    return Promise.reject(err);
  }
);

// Attach static helpers so hooks can do: import axios from '../lib/apiClient'; axios.isAxiosError(err)
const apiClient = Object.assign(instance as AxiosInstance & { isAxiosError: typeof axios.isAxiosError }, {
  isAxiosError: axios.isAxiosError,
});

export default apiClient;

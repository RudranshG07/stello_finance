import { useCallback, useState } from 'react';
import axios from '../lib/apiClient';
import { API_BASE_URL } from '../config/contracts';
import { useWallet } from './useWallet';

export function useTransactionExport() {
  const { publicKey } = useWallet();
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportTransactionsCSV = useCallback(async (): Promise<void> => {
    if (!publicKey) {
      setError('Please connect your wallet first');
      return;
    }

    setIsExporting(true);
    setError(null);

    try {
      const response = await axios.get(
        `${API_BASE_URL}/api/analytics/export/transactions`,
        {
          params: { wallet: publicKey },
          responseType: 'blob',
        }
      );

      // Create a blob URL and trigger download
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute(
        'download',
        `sxlm-transactions-${publicKey.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.csv`
      );
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : err instanceof Error
            ? err.message
            : 'Export failed';
      setError(message);
    } finally {
      setIsExporting(false);
    }
  }, [publicKey]);

  return {
    exportTransactionsCSV,
    isExporting,
    error,
  };
}

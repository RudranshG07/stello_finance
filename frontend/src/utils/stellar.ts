import { PROTOCOL_CONFIG } from '../config/contracts';

export function formatXLM(amount: number | string, decimals: number = 4): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return '0.0000';
  if (num >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(2)}B`;
  }
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(2)}K`;
  }
  return num.toFixed(decimals);
}

export function formatUSD(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return '$0.00';
  if (num >= 1_000_000_000) {
    return `$${(num / 1_000_000_000).toFixed(2)}B`;
  }
  if (num >= 1_000_000) {
    return `$${(num / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `$${(num / 1_000).toFixed(2)}K`;
  }
  return `$${num.toFixed(2)}`;
}

export function formatAddress(address: string, startChars: number = 6, endChars: number = 4): string {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

export function formatAPY(apy: number | string): string {
  const num = typeof apy === 'string' ? parseFloat(apy) : apy;
  if (isNaN(num)) return '0.00%';
  return `${num.toFixed(2)}%`;
}

export function calculateSxlmFromXlm(xlmAmount: number, exchangeRate: number): number {
  if (!exchangeRate || exchangeRate === 0) return 0;
  return xlmAmount / exchangeRate;
}

export function calculateXlmFromSxlm(sxlmAmount: number, exchangeRate: number): number {
  return sxlmAmount * exchangeRate;
}

export function stroopsToXLM(stroops: string | number): number {
  const s = typeof stroops === 'string' ? parseInt(stroops, 10) : stroops;
  return s / 10 ** PROTOCOL_CONFIG.decimals;
}

export function xlmToStroops(xlm: number): string {
  return Math.floor(xlm * 10 ** PROTOCOL_CONFIG.decimals).toString();
}

export function formatTimestamp(timestamp: string | number): string {
  const date = new Date(typeof timestamp === 'string' ? timestamp : timestamp * 1000);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeUntil(futureDate: string | number): string {
  const now = Date.now();
  const target = typeof futureDate === 'string' ? new Date(futureDate).getTime() : futureDate * 1000;
  const diff = target - now;

  if (diff <= 0) return 'Ready';

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

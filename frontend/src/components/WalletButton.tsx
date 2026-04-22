import { useState, useRef, useEffect } from 'react';
import { LogOut, Copy, Check, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { useStaking } from '../hooks/useStaking';
import { formatAddress } from '../utils/stellar';
import { WALLET_ERROR_MESSAGES, type WalletErrorType } from '../utils/walletErrors';

export default function WalletButton() {
  const { 
    publicKey, 
    isConnected, 
    isConnecting, 
    error, 
    lastErrorType,
    connectionAttempts,
    connect, 
    disconnect,
    clearError,
    retryConnection
  } = useWallet();
  const { balance } = useStaking();
  const [showDropdown, setShowDropdown] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const copyAddress = async () => {
    if (publicKey) {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!isConnected) {
    const getErrorIcon = (errorType: WalletErrorType | null) => {
      if (errorType === 'freighter_missing') return <ExternalLink className="w-3 h-3" />;
      if (errorType === 'freighter_locked') return <AlertCircle className="w-3 h-3" />;
      return <AlertCircle className="w-3 h-3" />;
    };

    const getErrorAction = (errorType: WalletErrorType | null) => {
      if (!errorType) return null;
      
      const errorInfo = WALLET_ERROR_MESSAGES[errorType];
      
      if (errorType === 'freighter_missing') {
        return (
          <button
            onClick={() => window.open('https://freighter.app', '_blank')}
            className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            {errorInfo.action}
          </button>
        );
      }
      
      if (errorType === 'user_rejected') {
        return (
          <button
            onClick={() => { clearError(); connect(); }}
            className="flex items-center gap-1 text-xs text-yellow-400 hover:text-yellow-300 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            {errorInfo.action}
          </button>
        );
      }
      
      if (errorInfo.canRetry && connectionAttempts < 3) {
        return (
          <button
            onClick={retryConnection}
            className="flex items-center gap-1 text-xs text-yellow-400 hover:text-yellow-300 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${isConnecting ? 'animate-spin' : ''}`} />
            {isConnecting ? 'Retrying...' : `${errorInfo.action} (${connectionAttempts}/3)`}
          </button>
        );
      }
      
      return null;
    };

    return (
      <div className="flex flex-col items-end gap-2">
        <button 
          onClick={connect} 
          disabled={isConnecting} 
          className="btn text-xs relative"
        >
          {isConnecting ? (
            <span className="flex items-center gap-2">
              <RefreshCw className="w-3 h-3 animate-spin" />
              {connectionAttempts > 0 ? `Retrying... (${connectionAttempts}/3)` : 'Connecting...'}
            </span>
          ) : (
            'Connect Wallet'
          )}
        </button>
        
        {error && (
          <div className="flex flex-col items-end gap-1 max-w-[300px]">
            <div className="flex items-center gap-2 text-xs text-red-400">
              {getErrorIcon(lastErrorType)}
              <span className="text-right">{error}</span>
            </div>
            {getErrorAction(lastErrorType)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all duration-150"
        style={{
          border: '1px solid #1e1e1e',
          background: showDropdown ? '#0d0d0d' : 'transparent',
          color: '#ccc',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(245,207,0,0.3)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = showDropdown ? 'rgba(245,207,0,0.3)' : '#1e1e1e')}
      >
        {/* Yellow pulsing dot for connected state */}
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#F5CF00',
            boxShadow: '0 0 6px rgba(245,207,0,0.6)',
            animation: 'yellow-pulse 2.5s ease-in-out infinite',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span className="font-mono" style={{ color: '#F5CF00', fontWeight: 600 }}>
          {balance.sxlmBalance.toFixed(2)} sXLM
        </span>
        <span className="font-mono" style={{ color: '#444' }}>|</span>
        <span className="font-mono" style={{ color: '#6b6b6b' }}>
          {formatAddress(publicKey || '')}
        </span>
      </button>

      {showDropdown && (
        <div
          className="absolute right-0 top-full mt-2 w-60 rounded-xl p-2 z-50"
          style={{
            background: '#0d0d0d',
            border: '1px solid #1e1e1e',
            boxShadow: '0 16px 48px rgba(0,0,0,0.8)',
          }}
        >
          <div className="px-3 py-2 mb-1">
            <p className="text-[10px] mb-1" style={{ color: '#525252' }}>Connected</p>
            <p className="font-mono text-[10px] break-all" style={{ color: '#6b6b6b' }}>{publicKey}</p>

            {/* sXLM balance — primary */}
            <div className="mt-2 pt-2" style={{ borderTop: '1px solid #1e1e1e' }}>
              <p className="text-[10px] mb-0.5" style={{ color: '#525252' }}>sXLM Balance</p>
              <p className="font-mono text-base font-bold" style={{ color: '#F5CF00' }}>
                {balance.sxlmBalance.toFixed(4)}
                <span className="text-[10px] font-normal ml-1" style={{ color: '#525252' }}>sXLM</span>
              </p>
              <p className="text-[10px] mt-0.5" style={{ color: '#383838' }}>
                ≈ {balance.xlmValue.toFixed(4)} XLM value
              </p>
            </div>

            {/* XLM in wallet — secondary */}
            <div className="mt-2 pt-2 flex justify-between items-center" style={{ borderTop: '1px solid #1e1e1e' }}>
              <p className="text-[10px]" style={{ color: '#525252' }}>XLM in Wallet</p>
              <p className="font-mono text-[11px]" style={{ color: '#6b6b6b' }}>
                {balance.xlmNativeBalance.toFixed(4)}
                <span className="text-[10px] ml-1" style={{ color: '#3a3a3a' }}>XLM</span>
              </p>
            </div>
          </div>

          <button
            onClick={copyAddress}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors"
            style={{ color: '#6b6b6b' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = '#6b6b6b';
            }}
          >
            {copied
              ? <Check className="w-3 h-3" style={{ color: '#4ade80' }} />
              : <Copy className="w-3 h-3" />
            }
            {copied ? 'Copied!' : 'Copy Address'}
          </button>

          <button
            onClick={() => { disconnect(); setShowDropdown(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors"
            style={{ color: '#f87171' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(248,113,113,0.06)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <LogOut className="w-3 h-3" />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

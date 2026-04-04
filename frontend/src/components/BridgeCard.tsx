import { useState } from 'react';
import axios from '../lib/apiClient';
import { useWallet } from '../hooks/useWallet';
import { API_BASE_URL } from '../config/contracts';

// Supported EVM chains
const EVM_CHAINS = [
  { id: 42161, name: 'Arbitrum', icon: '🔵' },
  { id: 1,     name: 'Ethereum', icon: '⬡' },
  { id: 11155111, name: 'Sepolia (testnet)', icon: '🔧' },
];

type BridgeDirection = 'stellar_to_evm' | 'evm_to_stellar';

type BridgeTxStatus =
  | 'idle'
  | 'pending'       // submitted, waiting for relayer
  | 'relaying'      // relayer picked up, minting/releasing
  | 'confirmed'     // done
  | 'failed';

interface BridgeTx {
  txHash: string;
  status: BridgeTxStatus;
  direction: BridgeDirection;
  amount: string;
  chainId: number;
  createdAt: number;
}

export default function BridgeCard() {
  const { isConnected, connect, publicKey, signTransaction } = useWallet();

  const [direction, setDirection] = useState<BridgeDirection>('stellar_to_evm');
  const [amount, setAmount] = useState('');
  const [evmAddress, setEvmAddress] = useState('');
  const [selectedChainId, setSelectedChainId] = useState(42161);
  const [stellarAddress, setStellarAddress] = useState('');

  const [isBridging, setIsBridging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Transaction history with status tracking
  const [transactions, setTransactions] = useState<BridgeTx[]>([]);

  const selectedChain = EVM_CHAINS.find((c) => c.id === selectedChainId)!;

  const isValidEvmAddress = /^0x[0-9a-fA-F]{40}$/.test(evmAddress);
  const isValidStellarAddress = stellarAddress.startsWith('G') && stellarAddress.length === 56;
  const isValidAmount = amount && parseFloat(amount) >= 1;

  const canBridge =
    isConnected &&
    isValidAmount &&
    !isBridging &&
    (direction === 'stellar_to_evm' ? isValidEvmAddress : isValidStellarAddress);

  // Poll relayer for tx status
  const pollStatus = async (txHash: string, direction: BridgeDirection) => {
    const maxAttempts = 60; // 5 minutes at 5s intervals
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        setTransactions((prev) =>
          prev.map((tx) =>
            tx.txHash === txHash ? { ...tx, status: 'failed' } : tx
          )
        );
        return;
      }
      attempts++;

      try {
        const { data } = await axios.get(
          `${API_BASE_URL}/api/bridge/status/${txHash}`
        );

        const newStatus: BridgeTxStatus =
          data.status === 'confirmed'
            ? 'confirmed'
            : data.status === 'relaying'
            ? 'relaying'
            : data.status === 'failed'
            ? 'failed'
            : 'pending';

        setTransactions((prev) =>
          prev.map((tx) =>
            tx.txHash === txHash ? { ...tx, status: newStatus } : tx
          )
        );

        if (newStatus !== 'confirmed' && newStatus !== 'failed') {
          setTimeout(poll, 5000);
        }
      } catch {
        setTimeout(poll, 5000);
      }
    };

    setTimeout(poll, 5000);
  };

  const handleBridge = async () => {
    if (!canBridge || !publicKey) return;
    setError(null);
    setIsBridging(true);

    try {
      if (direction === 'stellar_to_evm') {
        // Stellar → EVM: build tx on backend, sign with Freighter, submit
        const { data } = await axios.post(`${API_BASE_URL}/api/bridge/stellar-to-evm`, {
          senderAddress: publicKey,
          evmRecipient: evmAddress,
          amount: parseFloat(amount),
          targetChainId: selectedChainId,
        });

        const signedXdr = await signTransaction(data.xdr, data.networkPassphrase);
        const { data: result } = await axios.post(`${API_BASE_URL}/api/bridge/submit`, {
          signedXdr,
        });

        const newTx: BridgeTx = {
          txHash: result.txHash,
          status: 'pending',
          direction,
          amount,
          chainId: selectedChainId,
          createdAt: Date.now(),
        };
        setTransactions((prev) => [newTx, ...prev]);
        setAmount('');
        setEvmAddress('');
        pollStatus(result.txHash, direction);
      } else {
        // EVM → Stellar: user calls burnForStellar on EVM side
        // We build the call via backend which returns calldata
        const { data } = await axios.post(`${API_BASE_URL}/api/bridge/evm-to-stellar`, {
          stellarRecipient: stellarAddress,
          amount: parseFloat(amount),
          sourceChainId: selectedChainId,
          evmSender: evmAddress, // user's EVM address
        });

        // For EVM direction, we return the calldata for the user's EVM wallet
        // The backend monitors for the BridgeBackInitiated event
        const newTx: BridgeTx = {
          txHash: data.evmTxHash,
          status: 'pending',
          direction,
          amount,
          chainId: selectedChainId,
          createdAt: Date.now(),
        };
        setTransactions((prev) => [newTx, ...prev]);
        setAmount('');
        setStellarAddress('');
        pollStatus(data.evmTxHash, direction);
      }
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : err instanceof Error
          ? err.message
          : 'Bridge transaction failed';
      setError(msg);
    } finally {
      setIsBridging(false);
    }
  };

  const getStatusColor = (status: BridgeTxStatus) => {
    switch (status) {
      case 'confirmed': return '#4ade80';
      case 'failed':    return '#f87171';
      case 'relaying':  return '#F5CF00';
      default:          return '#525252';
    }
  };

  const getStatusLabel = (status: BridgeTxStatus) => {
    switch (status) {
      case 'pending':   return 'Submitted';
      case 'relaying':  return 'Relaying...';
      case 'confirmed': return 'Confirmed';
      case 'failed':    return 'Failed';
      default:          return 'Unknown';
    }
  };

  const getTxExplorerUrl = (tx: BridgeTx) => {
    if (tx.direction === 'stellar_to_evm') {
      return `https://stellar.expert/explorer/public/tx/${tx.txHash}`;
    }
    const explorers: Record<number, string> = {
      1:        `https://etherscan.io/tx/${tx.txHash}`,
      42161:    `https://arbiscan.io/tx/${tx.txHash}`,
      11155111: `https://sepolia.etherscan.io/tx/${tx.txHash}`,
    };
    return explorers[tx.chainId] ?? '#';
  };

  return (
    <div className="card p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Bridge sXLM</h3>
        <span className="tag-yellow">Cross-Chain</span>
      </div>

      {/* Direction toggle */}
      <div
        className="flex rounded-lg overflow-hidden text-xs font-medium"
        style={{ border: '1px solid #1e1e1e' }}
      >
        <button
          onClick={() => { setDirection('stellar_to_evm'); setError(null); }}
          className="flex-1 py-2 transition-colors"
          style={{
            background: direction === 'stellar_to_evm' ? '#F5CF00' : '#080808',
            color:      direction === 'stellar_to_evm' ? '#000' : '#525252',
          }}
        >
          Stellar → EVM
        </button>
        <button
          onClick={() => { setDirection('evm_to_stellar'); setError(null); }}
          className="flex-1 py-2 transition-colors"
          style={{
            background: direction === 'evm_to_stellar' ? '#F5CF00' : '#080808',
            color:      direction === 'evm_to_stellar' ? '#000' : '#525252',
          }}
        >
          EVM → Stellar
        </button>
      </div>

      {/* Chain selector */}
      <div>
        <label className="label">Target Chain</label>
        <div className="flex gap-2">
          {EVM_CHAINS.map((chain) => (
            <button
              key={chain.id}
              onClick={() => setSelectedChainId(chain.id)}
              className="flex-1 rounded-lg py-2 text-xs transition-colors"
              style={{
                background: selectedChainId === chain.id ? '#111' : '#080808',
                border: `1px solid ${selectedChainId === chain.id ? '#F5CF00' : '#1e1e1e'}`,
                color: selectedChainId === chain.id ? '#F5CF00' : '#525252',
              }}
            >
              {chain.icon} {chain.name.split(' ')[0]}
            </button>
          ))}
        </div>
      </div>

      {/* Amount input */}
      <div>
        <label className="label">Amount (sXLM)</label>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          min="1"
          className="input font-mono text-lg"
        />
        <p className="text-[10px] mt-1" style={{ color: '#525252' }}>
          Minimum: 1 sXLM
        </p>
      </div>

      <div className="flex items-center justify-center gap-3 text-neutral-700 text-xs">
        <div className="flex-1 h-px bg-border" />
        <span>→</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Destination address */}
      {direction === 'stellar_to_evm' ? (
        <div>
          <label className="label">EVM Recipient Address</label>
          <input
            type="text"
            value={evmAddress}
            onChange={(e) => setEvmAddress(e.target.value)}
            placeholder="0x..."
            className="input font-mono text-sm"
          />
          {evmAddress && !isValidEvmAddress && (
            <p className="text-[10px] mt-1 text-red-400">Invalid EVM address</p>
          )}
        </div>
      ) : (
        <div>
          <label className="label">Stellar Recipient Address</label>
          <input
            type="text"
            value={stellarAddress}
            onChange={(e) => setStellarAddress(e.target.value)}
            placeholder="G..."
            className="input font-mono text-sm"
          />
          {stellarAddress && !isValidStellarAddress && (
            <p className="text-[10px] mt-1 text-red-400">Invalid Stellar address</p>
          )}
          <div className="mt-2">
            <label className="label">Your EVM Address (source)</label>
            <input
              type="text"
              value={evmAddress}
              onChange={(e) => setEvmAddress(e.target.value)}
              placeholder="0x..."
              className="input font-mono text-sm"
            />
          </div>
        </div>
      )}

      {/* Info row */}
      <div className="space-y-1.5 text-xs px-1" style={{ color: '#525252' }}>
        <div className="flex justify-between">
          <span>You send</span>
          <span className="text-neutral-400">{amount || '0'} sXLM</span>
        </div>
        <div className="flex justify-between">
          <span>You receive</span>
          <span className="font-mono" style={{ color: '#F5CF00' }}>
            {amount || '0'} {direction === 'stellar_to_evm' ? 'wsXLM' : 'sXLM'}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Destination</span>
          <span className="text-neutral-400">
            {direction === 'stellar_to_evm' ? selectedChain.name : 'Stellar'}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Bridge fee</span>
          <span className="text-neutral-400">Gas only</span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="banner-error">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* CTA */}
      {isConnected ? (
        <button
          onClick={handleBridge}
          disabled={!canBridge}
          className="w-full btn"
        >
          {isBridging
            ? 'Bridging...'
            : direction === 'stellar_to_evm'
            ? `Bridge to ${selectedChain.name}`
            : 'Bridge to Stellar'}
        </button>
      ) : (
        <button onClick={connect} className="w-full btn">
          Connect Wallet to Bridge
        </button>
      )}

      {/* Transaction status tracker */}
      {transactions.length > 0 && (
        <div className="pt-4" style={{ borderTop: '1px solid #1e1e1e' }}>
          <h4 className="text-xs font-medium mb-3" style={{ color: '#525252' }}>
            Bridge Transactions
          </h4>
          <div className="space-y-2">
            {transactions.map((tx) => (
              <div
                key={tx.txHash}
                className="rounded-lg p-3"
                style={{ background: '#080808', border: '1px solid #1e1e1e' }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-white">
                    {tx.amount} {tx.direction === 'stellar_to_evm' ? 'sXLM → wsXLM' : 'wsXLM → sXLM'}
                  </span>
                  <span
                    className="text-[10px] font-medium"
                    style={{ color: getStatusColor(tx.status) }}
                  >
                    {getStatusLabel(tx.status)}
                  </span>
                </div>

                {/* Progress bar */}
                <div
                  className="w-full rounded-full h-0.5 mb-2"
                  style={{ background: '#1e1e1e' }}
                >
                  <div
                    className="h-0.5 rounded-full transition-all duration-500"
                    style={{
                      background: getStatusColor(tx.status),
                      width:
                        tx.status === 'pending'   ? '33%'  :
                        tx.status === 'relaying'  ? '66%'  :
                        tx.status === 'confirmed' ? '100%' :
                        tx.status === 'failed'    ? '100%' : '0%',
                    }}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[10px]" style={{ color: '#525252' }}>
                    {EVM_CHAINS.find((c) => c.id === tx.chainId)?.name ?? 'Unknown'}
                  </span>
                  <a
                    href={getTxExplorerUrl(tx)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-mono truncate max-w-[140px]"
                    style={{ color: '#525252' }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#F5CF00')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#525252')}
                  >
                    {tx.txHash.slice(0, 8)}...{tx.txHash.slice(-6)} ↗
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
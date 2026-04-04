// ABI for the WrappedSXLM (wsXLM) ERC-20 contract on EVM chains.
// Matches WrappedSXLM.sol — update if the Solidity contract changes.

export const WSXLM_ABI = [
  // ERC-20 standard
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",

  // Bridge-specific
  "function mintFromStellar(address to, uint256 amount, bytes32 stellarTxHash) external",
  "function burnForStellar(uint256 amount, string calldata stellarRecipient) external",
  "function isProcessed(bytes32 stellarTxHash) view returns (bool)",

  // Events
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event BridgeBackInitiated(string indexed stellarAddress, uint256 amount, bytes32 evmTxHash)",
] as const;
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract WrappedSXLM is ERC20, Ownable {
    address public relayer;
    mapping(bytes32 => bool) public processedStellarTxHashes;
    mapping(address => uint256) public burnNonces;

    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event BridgeBackInitiated(
        string indexed stellarAddress,
        uint256 amount,
        bytes32 burnId
    );

    error OnlyRelayer();
    error AlreadyProcessed(bytes32 stellarTxHash);
    error ZeroAmount();
    error InvalidStellarAddress();

    constructor(address _relayer, address _owner)
        ERC20("Wrapped Staked XLM", "wsXLM")
        Ownable(_owner)
    {
        require(_relayer != address(0), "relayer cannot be zero address");
        relayer = _relayer;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    function mintFromStellar(
        address to,
        uint256 amount,
        bytes32 stellarTxHash
    ) external onlyRelayer {
        if (amount == 0) revert ZeroAmount();
        if (processedStellarTxHashes[stellarTxHash]) revert AlreadyProcessed(stellarTxHash);
        processedStellarTxHashes[stellarTxHash] = true;
        _mint(to, amount);
    }

    function burnForStellar(
        uint256 amount,
        string calldata stellarRecipient
    ) external {
        if (amount == 0) revert ZeroAmount();
        if (bytes(stellarRecipient).length != 56) revert InvalidStellarAddress();

        _burn(msg.sender, amount);

        // keccak256 of sender + per-user nonce + block data
        // guarantees uniqueness even if two users burn in the same block
        uint256 nonce = burnNonces[msg.sender]++;
        bytes32 burnId = keccak256(
            abi.encodePacked(msg.sender, nonce, block.number, block.chainid)
        );

        emit BridgeBackInitiated(stellarRecipient, amount, burnId);
    }

    function isProcessed(bytes32 stellarTxHash) external view returns (bool) {
        return processedStellarTxHashes[stellarTxHash];
    }

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "relayer cannot be zero address");
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}
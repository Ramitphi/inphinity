// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The parts of Inphinity's live Arc contracts the sender reads (contracts/IndexFactory.sol, IndexFund.sol).
interface IIndexFactory {
    function isIndex(address fund) external view returns (bool);
    function indexCount() external view returns (uint256);
    function indexAt(uint256 index) external view returns (address);
}

interface IIndexFund {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function creator() external view returns (address);
    function feeBps() external view returns (uint16);
    function getTokens() external view returns (address[] memory);
    function getWeights() external view returns (uint16[] memory);
}

interface IERC20Symbol {
    function symbol() external view returns (string memory);
}

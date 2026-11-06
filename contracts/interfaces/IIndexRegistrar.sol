// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Optional atomic index naming service, implemented separately.
interface IIndexRegistrar {
    /// @notice Registers a label for the fund and assigns the name to its creator.
    function register(string calldata label, address fund, address creator, string calldata description)
        external returns (bytes32 node);
    /// @notice Returns whether a label is available.
    function isAvailable(string calldata label) external view returns (bool);
}

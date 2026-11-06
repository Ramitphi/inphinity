// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Chainlink CRE receiver interface, adapted from the consumer-contract docs.
interface IReceiver is IERC165 {
    /// @notice Handles a forwarder-delivered workflow report; a revert permits retry.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

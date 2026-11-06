// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal views of the live ENSv2 Sepolia contracts (ensdomains/contracts-v2, branch
///         deploy/mainnet-v2-20261002): PermissionedRegistry (our UserRegistry and the .eth registry)
///         and PermissionedResolver. Signatures match ens/src/abis.ts.
interface IPermissionedRegistry {
    struct State {
        uint8 status; // 0 AVAILABLE, 1 RESERVED, 2 REGISTERED
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }

    function getState(uint256 anyId) external view returns (State memory);
    function getExpiry(uint256 anyId) external view returns (uint64);
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);
}

interface IPermissionedResolver {
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function linkToNode(bytes calldata sourceName, bytes32 targetNode) external;
    function linkToRecord(bytes calldata sourceName, uint256 recordId) external;
    function getRecordId(bytes32 node) external view returns (uint256);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
    function multicall(bytes[] calldata calls) external returns (bytes[] memory results);
}

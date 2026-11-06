// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The parts of ENS's live ENSv2 Sepolia contracts the receiver uses
/// (ensdomains/contracts-v2, branch deploy/mainnet-v2-20261002).
interface IEnsV2Registry {
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

interface IEnsV2PermissionedResolver {
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function linkToNode(bytes calldata sourceName, bytes32 targetNode) external;
    function linkToRecord(bytes calldata sourceName, uint256 recordId) external;
    function getRecordId(bytes32 node) external view returns (uint256);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @notice The Inphinity fund views the Arc-side registrar reads.
interface IInphinityFund {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function feeBps() external view returns (uint16);
    function getTokens() external view returns (address[] memory);
    function getWeights() external view returns (uint16[] memory);
}

interface IInphinityFactory {
    function indexCount() external view returns (uint256);
}

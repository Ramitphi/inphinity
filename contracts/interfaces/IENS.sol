// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ENS surfaces used by FundNamePublisher on Ethereum Sepolia.
/// @dev Signatures checked against ensdomains/ens-contracts (staging), deployments/sepolia:
/// ENSRegistry 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e,
/// NameWrapper 0x0635513f179D50A207757E05759CbD106d7dFcE8,
/// PublicResolver 0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5.
interface IENS {
    function owner(bytes32 node) external view returns (address);
    function resolver(bytes32 node) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl) external;
}

interface INameWrapper {
    function ownerOf(uint256 id) external view returns (address);
    function isApprovedForAll(address account, address operator) external view returns (bool);
    function setSubnodeRecord(
        bytes32 parentNode, string calldata label, address owner, address resolver,
        uint64 ttl, uint32 fuses, uint64 expiry
    ) external returns (bytes32 node);
}

interface IPublicResolver {
    function setAddr(bytes32 node, uint256 coinType, bytes calldata a) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
    function multicallWithNodeCheck(bytes32 nodehash, bytes[] calldata data) external returns (bytes[] memory);
}

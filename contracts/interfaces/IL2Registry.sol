// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Durin registry surface used by IndexRegistrar and registry setup.
/// @dev Signatures verified from namestonehq/durin (redirects to ensdomains/durin),
/// commit f19cd3e48f72a8c02cf43dad06002ffebe3e4a46:
/// src/interfaces/IL2Registry.sol and src/interfaces/IL2Resolver.sol.
interface IL2Registry {
    function baseNode() external view returns (bytes32);
    /// @notice Returns zero for an unregistered node, unlike ERC721.ownerOf.
    function owner(bytes32 node) external view returns (address);
    function createSubnode(bytes32 node, string calldata label, address owner_, bytes[] calldata data)
        external returns (bytes32);
    function setAddr(bytes32 node, uint256 coinType, bytes calldata a) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    /// @notice Must be called by the registry's owner, not IndexRegistrar's owner by proxy.
    function addRegistrar(address registrar) external;
}

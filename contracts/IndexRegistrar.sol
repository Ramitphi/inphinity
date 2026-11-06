// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IIndexRegistrar} from "./interfaces/IIndexRegistrar.sol";
import {IL2Registry} from "./interfaces/IL2Registry.sol";

/// @notice Factory-only ENS subname issuance for funds on Arc Testnet.
/// @dev The Durin registry owner must call addRegistrar(address(this)) on the registry.
/// Registry and parent are fixed; the owner authorizes the factory after its deployment.
contract IndexRegistrar is IIndexRegistrar, Ownable2Step, ReentrancyGuard {
    uint256 public constant ARC_COIN_TYPE = uint256(0x80000000) | uint256(5042002);
    IL2Registry public immutable registry;
    bytes32 public immutable parentNode;
    address public factory;

    error InvalidConfiguration();
    error OnlyFactory();
    error InvalidLabel();
    error InvalidRecipient();
    error LabelTaken(bytes32 node);
    error UnexpectedNode();

    event FactoryUpdated(address indexed factory);
    event NameRegistered(bytes32 indexed node, address indexed fund, address indexed creator, string label);

    /// @param initialOwner Administrator with two-step ownership transfers.
    /// @param registry_ Initialized Durin registry clone for the intended ENS parent on Arc Testnet.
    constructor(address initialOwner, address registry_) Ownable(initialOwner) {
        if (registry_ == address(0) || registry_.code.length == 0) revert InvalidConfiguration();
        IL2Registry target = IL2Registry(registry_);
        bytes32 parent = target.baseNode();
        if (parent == bytes32(0) || target.owner(parent) == address(0)) revert InvalidConfiguration();
        registry = target;
        parentNode = parent;
    }

    /// @notice Authorizes the factory for future registrations; zero disables issuance.
    function setFactory(address factory_) external onlyOwner nonReentrant {
        if (factory_ != address(0) && factory_.code.length == 0) revert InvalidConfiguration();
        factory = factory_;
        emit FactoryUpdated(factory_);
    }

    /// @notice Mints the label's NFT to the creator and atomically sets its initial records.
    /// @dev All registry failures propagate to IndexFactory, rolling back fund creation.
    /// Only the Arc multicoin address record is set: no Ethereum coin type 60 record.
    function register(string calldata label, address fund, address creator, string calldata description)
        external override nonReentrant returns (bytes32 node)
    {
        if (msg.sender != factory) revert OnlyFactory();
        if (!_validLabel(label)) revert InvalidLabel();
        if (fund == address(0) || creator == address(0)) revert InvalidRecipient();
        node = _labelToNode(label);
        if (registry.owner(node) != address(0)) revert LabelTaken(node);

        // Durin executes these resolver calls within createSubnode after safe-minting.
        // The registrar role authorizes record writes even though the creator owns the NFT.
        bytes[] memory records = new bytes[](3);
        records[0] = abi.encodeCall(IL2Registry.setAddr, (node, ARC_COIN_TYPE, abi.encodePacked(fund)));
        records[1] = abi.encodeCall(IL2Registry.setText, (node, "description", description));
        records[2] = abi.encodeCall(IL2Registry.setText, (node, "creator", Strings.toHexString(creator)));
        if (registry.createSubnode(parentNode, label, creator, records) != node) revert UnexpectedNode();

        emit NameRegistered(node, fund, creator, label);
    }

    /// @notice Invalid labels and existing nodes are unavailable; registry read failures propagate.
    function isAvailable(string calldata label) external view override returns (bool) {
        return _validLabel(label) && registry.owner(_labelToNode(label)) == address(0);
    }

    function _labelToNode(string calldata label) private view returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    function _validLabel(string calldata label) private pure returns (bool) {
        bytes calldata value = bytes(label);
        if (value.length < 3 || value.length > 20) return false;
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) return false;
        }
        return true;
    }
}

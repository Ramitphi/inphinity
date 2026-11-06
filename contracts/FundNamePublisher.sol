// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IENS, INameWrapper, IPublicResolver} from "./interfaces/IENS.sol";

/// @notice Deployed on Ethereum Sepolia. Gives every Inphinity fund created on Arc Testnet an
/// ENS subname `<label>.<parent>` whose records carry the fund's metadata.
/// @dev Setup: the parent name's owner approves this contract as an operator, with
/// NameWrapper.setApprovalForAll(this, true) for a wrapped parent, or
/// ENSRegistry.setApprovalForAll(this, true) for an unwrapped one.
/// This contract keeps ownership of every subname it creates, so the records can only be
/// written through it. The parent owner can still reclaim a subname, since no fuses are burned.
/// Arc data reaches this contract through an allowlisted publisher (the relayer), which is trusted
/// to copy the fund's on-chain data faithfully; this contract checks format, not truth.
contract FundNamePublisher is Ownable2Step, ERC1155Holder {
    using Strings for uint256;
    using Strings for address;

    uint256 public constant ARC_TESTNET_CHAIN_ID = 5042002;
    /// @notice ENSIP-11 coin type for Arc Testnet addresses.
    uint256 public constant ARC_COIN_TYPE = 0x80000000 | ARC_TESTNET_CHAIN_ID;
    uint256 public constant MIN_HOLDINGS = 2;
    uint256 public constant MAX_HOLDINGS = 10;
    uint16 public constant MAX_FEE_BPS = 200;

    struct Holding {
        address token;
        string symbol;
        uint16 weightBps;
    }

    struct FundRecord {
        string label;
        address fund;
        address creator;
        address venue;
        string name;
        string symbol;
        string description;
        uint16 feeBps;
        uint64 createdAt;
        Holding[] holdings;
    }

    IENS public immutable ens;
    INameWrapper public immutable nameWrapper;
    IPublicResolver public immutable resolver;
    bytes32 public immutable parentNode;
    string public parentName;

    mapping(address => bool) public isPublisher;
    /// @notice ENS node => Arc fund address.
    mapping(bytes32 => address) public fundOf;
    /// @notice Arc fund address => ENS node.
    mapping(address => bytes32) public nodeOf;

    error InvalidConfiguration();
    error NotPublisher(address account);
    error InvalidLabel();
    error InvalidRecord();
    error InvalidHoldings();
    error NameTaken(bytes32 node);
    error FundAlreadyPublished(address fund);
    error UnknownNode(bytes32 node);

    event PublisherUpdated(address indexed account, bool allowed);
    event FundPublished(bytes32 indexed node, address indexed fund, address indexed creator, string label);
    event RecordUpdated(bytes32 indexed node, string key, string value);

    /// @param parentName_ Normalized parent, e.g. "inphinity.eth". Must already exist in the registry.
    constructor(
        address initialOwner, address ens_, address nameWrapper_, address resolver_, string memory parentName_
    ) Ownable(initialOwner) {
        if (ens_.code.length == 0 || nameWrapper_.code.length == 0 || resolver_.code.length == 0) {
            revert InvalidConfiguration();
        }
        bytes32 node = _namehash(bytes(parentName_));
        if (IENS(ens_).owner(node) == address(0)) revert InvalidConfiguration();
        ens = IENS(ens_);
        nameWrapper = INameWrapper(nameWrapper_);
        resolver = IPublicResolver(resolver_);
        parentNode = node;
        parentName = parentName_;
    }

    /// @notice Allows or revokes a relayer account.
    function setPublisher(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert InvalidConfiguration();
        isPublisher[account] = allowed;
        emit PublisherUpdated(account, allowed);
    }

    /// @notice Creates `<label>.<parent>` and writes the fund's address and metadata records.
    function publish(FundRecord calldata r) external returns (bytes32 node) {
        if (!isPublisher[msg.sender]) revert NotPublisher(msg.sender);
        if (!isValidLabel(r.label)) revert InvalidLabel();
        _validateRecord(r);
        if (nodeOf[r.fund] != bytes32(0)) revert FundAlreadyPublished(r.fund);
        bytes32 labelHash = keccak256(bytes(r.label));
        node = keccak256(abi.encodePacked(parentNode, labelHash));
        if (ens.owner(node) != address(0)) revert NameTaken(node);

        fundOf[node] = r.fund;
        nodeOf[r.fund] = node;

        if (ens.owner(parentNode) == address(nameWrapper)) {
            // Max expiry is capped by the NameWrapper at the parent's expiry.
            nameWrapper.setSubnodeRecord(
                parentNode, r.label, address(this), address(resolver), 0, 0, type(uint64).max
            );
        } else {
            ens.setSubnodeRecord(parentNode, labelHash, address(this), address(resolver), 0);
        }
        resolver.multicallWithNodeCheck(node, _records(node, r));
        emit FundPublished(node, r.fund, r.creator, r.label);
    }

    /// @notice Updates one text record of a published fund name, e.g. a later `pool` address.
    function updateText(bytes32 node, string calldata key, string calldata value) external {
        if (msg.sender != owner() && !isPublisher[msg.sender]) revert NotPublisher(msg.sender);
        if (fundOf[node] == address(0)) revert UnknownNode(node);
        if (bytes(key).length == 0 || bytes(key).length > 64 || bytes(value).length > 2048) revert InvalidRecord();
        resolver.setText(node, key, value);
        emit RecordUpdated(node, key, value);
    }

    /// @notice Returns the ENS node a label maps to under the parent.
    function nodeForLabel(string calldata label) public view returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    /// @notice Returns `<label>.<parent>`.
    function fullName(string calldata label) external view returns (string memory) {
        return string.concat(label, ".", parentName);
    }

    /// @notice True when this contract already published the label.
    function isPublished(string calldata label) external view returns (bool) {
        return fundOf[nodeForLabel(label)] != address(0);
    }

    /// @notice Same label rule as the Arc factory: 3 to 20 characters, lowercase a-z and 0-9.
    function isValidLabel(string calldata label) public pure returns (bool) {
        bytes calldata value = bytes(label);
        if (value.length < 3 || value.length > 20) return false;
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) return false;
        }
        return true;
    }

    /// @notice Composition as JSON: [{"symbol":"tAAPL","token":"0x..","weightBps":5000},...].
    function compositionJson(Holding[] calldata holdings) public pure returns (string memory json) {
        json = "[";
        for (uint256 i; i < holdings.length; ++i) {
            json = string.concat(
                json,
                i == 0 ? "" : ",",
                '{"symbol":"', holdings[i].symbol,
                '","token":"', holdings[i].token.toChecksumHexString(),
                '","weightBps":', uint256(holdings[i].weightBps).toString(),
                "}"
            );
        }
        json = string.concat(json, "]");
    }

    function _validateRecord(FundRecord calldata r) private pure {
        if (r.fund == address(0) || r.creator == address(0) || r.venue == address(0) || r.createdAt == 0
            || bytes(r.name).length == 0 || bytes(r.name).length > 128
            || bytes(r.symbol).length == 0 || bytes(r.symbol).length > 32
            || bytes(r.description).length > 2048 || r.feeBps > MAX_FEE_BPS) revert InvalidRecord();
        uint256 count = r.holdings.length;
        if (count < MIN_HOLDINGS || count > MAX_HOLDINGS) revert InvalidHoldings();
        uint256 sum;
        for (uint256 i; i < count; ++i) {
            Holding calldata h = r.holdings[i];
            if (h.token == address(0) || h.weightBps == 0 || !_isSafeSymbol(h.symbol)) revert InvalidHoldings();
            for (uint256 j; j < i; ++j) if (r.holdings[j].token == h.token) revert InvalidHoldings();
            sum += h.weightBps;
        }
        if (sum != 10000) revert InvalidHoldings();
    }

    /// @dev Symbols are embedded in JSON, so only characters that need no escaping are accepted.
    function _isSafeSymbol(string calldata symbol) private pure returns (bool) {
        bytes calldata s = bytes(symbol);
        if (s.length == 0 || s.length > 32) return false;
        for (uint256 i; i < s.length; ++i) {
            bytes1 c = s[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)
                || c == 0x2e || c == 0x2d || c == 0x5f)) return false;
        }
        return true;
    }

    function _records(bytes32 node, FundRecord calldata r) private pure returns (bytes[] memory data) {
        data = new bytes[](11);
        data[0] = abi.encodeCall(IPublicResolver.setAddr, (node, ARC_COIN_TYPE, abi.encodePacked(r.fund)));
        data[1] = _text(node, "name", r.name);
        data[2] = _text(node, "symbol", r.symbol);
        data[3] = _text(node, "description", r.description);
        data[4] = _text(node, "fund", r.fund.toChecksumHexString());
        data[5] = _text(node, "creator", r.creator.toChecksumHexString());
        data[6] = _text(node, "fee", uint256(r.feeBps).toString());
        data[7] = _text(node, "composition", compositionJson(r.holdings));
        data[8] = _text(node, "venue", r.venue.toChecksumHexString());
        data[9] = _text(node, "chain", string.concat("eip155:", ARC_TESTNET_CHAIN_ID.toString()));
        data[10] = _text(node, "created", uint256(r.createdAt).toString());
    }

    function _text(bytes32 node, string memory key, string memory value) private pure returns (bytes memory) {
        return abi.encodeCall(IPublicResolver.setText, (node, key, value));
    }

    /// @dev ENS namehash of a dot-separated name; empty labels and uppercase are rejected.
    function _namehash(bytes memory name) private pure returns (bytes32 node) {
        if (name.length == 0) revert InvalidConfiguration();
        uint256 end = name.length;
        for (uint256 i = name.length; i > 0; --i) {
            bytes1 c = name[i - 1];
            if (c == ".") {
                node = keccak256(abi.encodePacked(node, _labelhash(name, i, end)));
                end = i - 1;
            } else if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d)) {
                revert InvalidConfiguration();
            }
        }
        node = keccak256(abi.encodePacked(node, _labelhash(name, 0, end)));
    }

    function _labelhash(bytes memory name, uint256 start, uint256 end) private pure returns (bytes32) {
        if (end <= start) revert InvalidConfiguration();
        bytes memory label = new bytes(end - start);
        for (uint256 i; i < label.length; ++i) label[i] = name[start + i];
        return keccak256(label);
    }
}

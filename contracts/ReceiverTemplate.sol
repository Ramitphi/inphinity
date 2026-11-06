// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";

/// @notice Minimal CRE receiver adapted from Chainlink's canonical consumer-contract guide.
/// @dev Source: https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts
/// Forwarder validation cannot be disabled. Workflow name uses the first ten ASCII hex
/// characters of SHA256(name), and is meaningful only together with workflow owner validation.
abstract contract ReceiverTemplate is IReceiver, Ownable {
    address private _forwarder;
    address private _expectedAuthor;
    bytes32 private _expectedWorkflowId;
    bytes10 private _expectedWorkflowName;

    error InvalidForwarderAddress();
    error InvalidSender(address received, address expected);
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidWorkflowName(bytes10 received, bytes10 expected);
    error InvalidMetadataLength(uint256 length);
    error WorkflowNameRequiresAuthorValidation();

    event ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder);
    event ExpectedAuthorUpdated(address indexed previousAuthor, address indexed newAuthor);
    event ExpectedWorkflowIdUpdated(bytes32 indexed previousId, bytes32 indexed newId);
    event ExpectedWorkflowNameUpdated(bytes10 indexed previousName, bytes10 indexed newName);

    constructor(address initialOwner, address forwarder) Ownable(initialOwner) {
        if (forwarder == address(0)) revert InvalidForwarderAddress();
        _forwarder = forwarder;
        emit ForwarderAddressUpdated(address(0), forwarder);
    }

    /// @notice Returns the mandatory trusted forwarder.
    function getForwarderAddress() external view returns (address) { return _forwarder; }
    /// @notice Returns the expected workflow owner; zero disables this check.
    function getExpectedAuthor() external view returns (address) { return _expectedAuthor; }
    /// @notice Returns the optional workflow ID.
    function getExpectedWorkflowId() external view returns (bytes32) { return _expectedWorkflowId; }
    /// @notice Returns the encoded optional workflow name.
    function getExpectedWorkflowName() external view returns (bytes10) { return _expectedWorkflowName; }

    /// @notice Replaces the trusted forwarder; zero is never permitted.
    function setForwarderAddress(address forwarder) external onlyOwner {
        if (forwarder == address(0)) revert InvalidForwarderAddress();
        emit ForwarderAddressUpdated(_forwarder, forwarder);
        _forwarder = forwarder;
    }

    /// @notice Sets the expected workflow owner; clear the name first to disable owner checks.
    function setExpectedAuthor(address author) external onlyOwner {
        if (author == address(0) && _expectedWorkflowName != bytes10(0)) {
            revert WorkflowNameRequiresAuthorValidation();
        }
        emit ExpectedAuthorUpdated(_expectedAuthor, author);
        _expectedAuthor = author;
        _afterIdentityChange();
    }

    /// @notice Sets an optional workflow ID (zero disables the check).
    function setExpectedWorkflowId(bytes32 id) external onlyOwner {
        emit ExpectedWorkflowIdUpdated(_expectedWorkflowId, id);
        _expectedWorkflowId = id;
        _afterIdentityChange();
    }

    /// @notice Sets a plaintext workflow name using CRE's SHA256/ASCII-hex encoding; empty disables it.
    function setExpectedWorkflowName(string calldata name) external onlyOwner {
        bytes10 encoded;
        if (bytes(name).length != 0) {
            if (_expectedAuthor == address(0)) revert WorkflowNameRequiresAuthorValidation();
            bytes32 hash = sha256(bytes(name));
            bytes memory chars = new bytes(10);
            bytes16 alphabet = "0123456789abcdef";
            for (uint256 i; i < 10; ++i) {
                uint8 octet = uint8(hash[i / 2]);
                chars[i] = alphabet[i % 2 == 0 ? octet >> 4 : octet & 15];
            }
            encoded = bytes10(chars);
        }
        emit ExpectedWorkflowNameUpdated(_expectedWorkflowName, encoded);
        _expectedWorkflowName = encoded;
        _afterIdentityChange();
    }

    function _hasWorkflowIdentity() internal view returns (bool) {
        return _expectedWorkflowId != bytes32(0) || _expectedAuthor != address(0);
    }

    function _afterIdentityChange() internal virtual {}

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != _forwarder) revert InvalidSender(msg.sender, _forwarder);
        // Simulation forwarders may omit metadata entirely when identity checks are off.
        if (_expectedWorkflowId != bytes32(0) || _expectedAuthor != address(0)
            || _expectedWorkflowName != bytes10(0)) {
            (bytes32 id, bytes10 name, address author) = _decodeMetadata(metadata);
            if (_expectedWorkflowId != bytes32(0) && id != _expectedWorkflowId) {
                revert InvalidWorkflowId(id, _expectedWorkflowId);
            }
            if (_expectedAuthor != address(0) && author != _expectedAuthor) {
                revert InvalidAuthor(author, _expectedAuthor);
            }
            if (_expectedWorkflowName != bytes10(0) && name != _expectedWorkflowName) {
                revert InvalidWorkflowName(name, _expectedWorkflowName);
            }
        }
        _processReport(report);
    }

    function _decodeMetadata(bytes calldata metadata)
        internal pure returns (bytes32 id, bytes10 name, address author)
    {
        // 62 packed identity bytes; production additionally appends a two-byte reportId.
        if (metadata.length != 62 && metadata.length != 64) revert InvalidMetadataLength(metadata.length);
        id = bytes32(metadata[0:32]);
        name = bytes10(metadata[32:42]);
        author = address(bytes20(metadata[42:62]));
    }

    function _processReport(bytes calldata report) internal virtual;

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public pure virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}

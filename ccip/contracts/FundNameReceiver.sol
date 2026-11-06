// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

import {FundLabel} from "./FundLabel.sol";
import {IPermissionedRegistry, IPermissionedResolver} from "./interfaces/IENSv2.sol";

/// @title FundNameReceiver (Ethereum Sepolia)
/// @notice Receives fund announcements from FundNameSender on Arc Testnet over Chainlink CCIP and
///         names the fund `<label>.inphinity.eth` in Inphinity's ENSv2 UserRegistry, exactly like
///         the off-chain relayer (ens/src/relayer.ts) does:
///           1. pick the label (dedupe with -2, -3, ...; reuse a name that already points at this fund),
///           2. register it as an ERC-1155 token owned by the fund creator with only ROLE_RENEW
///              (no resolver change, no subregistry, no transfer), expiring with inphinity.eth,
///           3. write the fund's record bundle on the shared PermissionedResolver: the fund address
///              under Arc's ENSIP-11 coin type 2152525650 (never 60) and the same 11 text records
///              (formatted by FundNameSender on Arc, where gas is cheap; written here verbatim),
///           4. link <symbol>.inphinity.eth (if free) and latest.inphinity.eth to that bundle.
/// @dev Needs, granted by the team wallet (ccip/scripts/grant-roles.ts):
///        UserRegistry root ROLE_REGISTRAR, PermissionedResolver root ROLE_SET_ADDRESS | ROLE_SET_TEXT | ROLE_LINK.
///      Only messages from `sourceChainSelector` and `sender` are accepted. Idempotent per fund.
///      Business "no-ops" (already named, no free label) emit FundSkipped instead of reverting; any
///      other failure reverts so the message can be manually re-executed on ccip.chain.link.
contract FundNameReceiver is CCIPReceiver {
    /// @notice ENSIP-11 coin type of Arc Testnet: 0x80000000 | 5042002.
    uint256 public constant ARC_COIN_TYPE = 0x80000000 | 5042002;
    /// @notice RegistryRolesLib.ROLE_RENEW: the only role a creator gets on their name token.
    uint256 public constant CREATOR_TOKEN_ROLES = 1 << 16;
    uint256 public constant MAX_LABEL_TRIES = 10;

    uint64 public immutable sourceChainSelector;
    address public immutable sender;
    IPermissionedRegistry public immutable userRegistry;
    IPermissionedResolver public immutable resolver;
    IPermissionedRegistry public immutable ethRegistry;
    uint256 public immutable parentLabelId;
    bytes32 public immutable parentNode;
    string public parentLabel;

    /// @notice Full ENS name given to each fund by this receiver or found already pointing at it.
    mapping(address fund => string name) public nameOf;
    /// @notice 1 + IndexFactory index of the fund latest.inphinity.eth points at (0 = none yet).
    uint256 public latestIndexPlusOne;

    event FundNamed(string label, address indexed fund, bytes32 indexed messageId);
    event FundSkipped(address indexed fund, bytes32 indexed messageId, string reason);

    error WrongSourceChain(uint64 selector);
    error WrongSender(bytes sender);

    constructor(
        address router_,
        uint64 sourceChainSelector_,
        address sender_,
        address userRegistry_,
        address resolver_,
        address ethRegistry_,
        string memory parentLabel_
    ) CCIPReceiver(router_) {
        sourceChainSelector = sourceChainSelector_;
        sender = sender_;
        userRegistry = IPermissionedRegistry(userRegistry_);
        resolver = IPermissionedResolver(resolver_);
        ethRegistry = IPermissionedRegistry(ethRegistry_);
        parentLabel = parentLabel_;
        parentLabelId = uint256(keccak256(bytes(parentLabel_)));
        bytes32 ethNode = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        parentNode = keccak256(abi.encodePacked(ethNode, keccak256(bytes(parentLabel_))));
    }

    // ---------------------------------------------------------------------------------------------
    // CCIP entry point
    // ---------------------------------------------------------------------------------------------

    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        if (message.sourceChainSelector != sourceChainSelector) revert WrongSourceChain(message.sourceChainSelector);
        if (message.sender.length != 32 || abi.decode(message.sender, (address)) != sender) {
            revert WrongSender(message.sender);
        }
        _nameFund(abi.decode(message.data, (FundLabel.Payload)), message.messageId);
    }

    // ---------------------------------------------------------------------------------------------
    // Naming
    // ---------------------------------------------------------------------------------------------

    function _nameFund(FundLabel.Payload memory p, bytes32 messageId) internal {
        if (bytes(nameOf[p.fund]).length != 0) {
            emit FundSkipped(p.fund, messageId, "already named");
            return;
        }
        (string memory label, bool registered, bool complete) = _chooseLabel(p.label, p.fund, p.creator);
        if (bytes(label).length == 0) {
            emit FundSkipped(p.fund, messageId, "no free label");
            return;
        }
        bytes memory dns = _dns(label);
        bytes32 node = _node(label);

        if (!complete) {
            if (!registered) {
                // The label may be a symbol link to another fund's bundle: detach it first, or the
                // records below would overwrite that fund's bundle. A real fund name beats a link.
                if (resolver.getRecordId(node) != 0) resolver.linkToRecord(dns, 0);
                userRegistry.register(
                    label, p.creator, address(0), address(resolver), CREATOR_TOKEN_ROLES, ethRegistry.getExpiry(parentLabelId)
                );
            }
            resolver.multicall(_recordCalls(dns, p));
            _linkSymbol(p.symbolLabel, label, node);
        }
        // latest.inphinity.eth follows the newest fund, even if messages arrive out of order.
        if (uint256(p.index) + 1 > latestIndexPlusOne) {
            latestIndexPlusOne = uint256(p.index) + 1;
            resolver.linkToNode(_dns("latest"), node);
        }

        nameOf[p.fund] = string.concat(label, ".", parentLabel, ".eth");
        emit FundNamed(label, p.fund, messageId);
    }

    /// @dev Mirrors relayer.ts chooseLabel. Returns ("", ..) if every candidate is taken.
    ///      registered: the token exists already (an earlier relayer run died before writing records).
    ///      complete: the name already resolves to this fund (the relayer named it), nothing to write.
    function _chooseLabel(string memory base, address fund, address creator)
        internal
        view
        returns (string memory label, bool registered, bool complete)
    {
        // `base` was sanitised by the sender (the only accepted source); only its length is re-checked.
        if (bytes(base).length < FundLabel.MIN_LEN || bytes(base).length > FundLabel.MAX_LEN) return ("", false, false);
        for (uint256 n = 1; n <= MAX_LABEL_TRIES; ++n) {
            label = FundLabel.withSuffix(base, n);
            if (FundLabel.isReserved(bytes(label))) continue;
            IPermissionedRegistry.State memory st = userRegistry.getState(uint256(keccak256(bytes(label))));
            if (st.status == 2) {
                bytes memory a = _readArcAddr(label);
                if (a.length == 20 && address(bytes20(a)) == fund) return (label, true, true);
                if (a.length == 0 && st.latestOwner == creator) return (label, true, false);
                continue; // another fund's name
            }
            if (st.status == 1) continue; // reserved entry
            return (label, false, false);
        }
        return ("", false, false);
    }

    /// @dev Address record (Arc coin type) + the texts exactly as the sender formatted them.
    function _recordCalls(bytes memory dns, FundLabel.Payload memory p) internal pure returns (bytes[] memory c) {
        c = new bytes[](p.texts.length + 1);
        c[0] = abi.encodeCall(IPermissionedResolver.setAddress, (dns, ARC_COIN_TYPE, abi.encodePacked(p.fund)));
        for (uint256 i; i < p.texts.length; ++i) {
            c[i + 1] = abi.encodeCall(IPermissionedResolver.setText, (dns, p.texts[i].key, p.texts[i].value));
        }
    }

    /// @dev <symbol>.inphinity.eth shares the fund's bundle if that label is free. First fund wins.
    function _linkSymbol(string memory sym, string memory label, bytes32 node) internal {
        if (bytes(sym).length == 0 || keccak256(bytes(sym)) == keccak256(bytes(label))) return;
        if (userRegistry.getState(uint256(keccak256(bytes(sym)))).status != 0) return;
        if (resolver.getRecordId(_node(sym)) != 0) return;
        resolver.linkToNode(_dns(sym), node);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _readArcAddr(string memory label) internal view returns (bytes memory) {
        // addr(bytes32 node, uint256 coinType) through the resolver's extended `resolve`.
        bytes memory q = abi.encodeWithSelector(0xf1cb7e06, _node(label), ARC_COIN_TYPE);
        return abi.decode(resolver.resolve(_dns(label), q), (bytes));
    }

    /// @notice DNS wire format of `<label>.<parent>.eth`.
    function _dns(string memory label) internal view returns (bytes memory) {
        bytes memory l = bytes(label);
        bytes memory pl = bytes(parentLabel);
        return abi.encodePacked(uint8(l.length), l, uint8(pl.length), pl, uint8(3), "eth", uint8(0));
    }

    /// @notice namehash of `<label>.<parent>.eth`.
    function _node(string memory label) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    /// @notice The label this receiver would give a fund right now, for scripts and UIs.
    /// @return label "" if none is free; complete = a name already resolves to `fund` (nothing to write).
    function previewLabel(string calldata base, address fund, address creator)
        external
        view
        returns (string memory label, bool registered, bool complete)
    {
        return _chooseLabel(base, fund, creator);
    }
}

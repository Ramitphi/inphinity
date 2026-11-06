// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Client, IAny2EVMMessageReceiver} from "./CcipInterfaces.sol";
import {IEnsV2PermissionedResolver, IEnsV2Registry} from "./EnsV2Interfaces.sol";
import {FundNameLib} from "./FundNameLib.sol";

/// @title InphinityEnsReceiver
/// @notice Ethereum Sepolia side of the Inphinity ENS bridge. Receives fund data from
/// `ArcEnsRegistrar` on Arc Testnet through Chainlink CCIP and, using ENS's live ENSv2 contracts:
///   1. registers `<label>.inphinity.eth` in the inphinity.eth UserRegistry, owned by the fund
///      creator with only ROLE_RENEW (no resolver change, no subregistry, no transfer),
///   2. writes the fund's record bundle on the shared Permissioned Resolver: the Arc address under
///      ENSIP-11 coin type 0x80000000|5042002 (never coin type 60) and text records,
///   3. links `<symbol>.inphinity.eth` (if free) and `latest.inphinity.eth` to that bundle.
/// It needs ROLE_REGISTRAR on the UserRegistry and SET_ADDRESS, SET_TEXT and LINK on the resolver.
/// @dev Same output as the off-chain relayer (ens/src/relayer.ts), so both can run side by side.
/// Messages from anyone but the Arc registrar are rejected. A valid message that fails while
/// naming (e.g. a role was revoked) is stored and can be retried by anyone with `retry`.
contract InphinityEnsReceiver is IAny2EVMMessageReceiver, IERC165, Ownable2Step {
    using Strings for uint256;
    using Strings for address;

    string public constant PARENT = "inphinity";
    uint256 public constant ARC_COIN_TYPE = 0x80000000 | 5042002;
    uint256 internal constant ROLE_RENEW = 1 << 16; // RegistryRolesLib.ROLE_RENEW
    uint8 internal constant REGISTERED = 2;
    uint256 internal constant MAX_SUFFIX = 20;

    address public immutable router;
    uint64 public immutable sourceChainSelector;
    address public immutable arcSender;
    IEnsV2Registry public immutable userRegistry;
    IEnsV2PermissionedResolver public immutable resolver;
    IEnsV2Registry public immutable ethRegistry;

    /// @notice messageId => payload, for messages whose naming failed.
    mapping(bytes32 => bytes) public failedMessages;
    /// @notice messageId => true once named (guards against double processing).
    mapping(bytes32 => bool) public processed;

    event FundNamed(bytes32 indexed messageId, address indexed fund, address indexed creator, string name);
    event NamingFailed(bytes32 indexed messageId, bytes reason);

    error OnlyRouter();
    error UnknownSource(uint64 chainSelector, bytes sender);
    error OnlySelf();
    error NothingToRetry();
    error NoFreeLabel();
    error InvalidConfiguration();

    constructor(
        address owner_,
        address router_,
        uint64 sourceChainSelector_,
        address arcSender_,
        address userRegistry_,
        address resolver_,
        address ethRegistry_
    ) Ownable(owner_) {
        if (router_ == address(0) || arcSender_ == address(0) || userRegistry_.code.length == 0
            || resolver_.code.length == 0 || ethRegistry_.code.length == 0) revert InvalidConfiguration();
        router = router_;
        sourceChainSelector = sourceChainSelector_;
        arcSender = arcSender_;
        userRegistry = IEnsV2Registry(userRegistry_);
        resolver = IEnsV2PermissionedResolver(resolver_);
        ethRegistry = IEnsV2Registry(ethRegistry_);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @inheritdoc IAny2EVMMessageReceiver
    function ccipReceive(Client.Any2EVMMessage calldata message) external {
        if (msg.sender != router) revert OnlyRouter();
        if (message.sourceChainSelector != sourceChainSelector || message.sender.length != 32
            || abi.decode(message.sender, (address)) != arcSender) {
            revert UnknownSource(message.sourceChainSelector, message.sender);
        }
        if (processed[message.messageId]) return;
        try this.name(message.messageId, message.data) returns (string memory full) {
            emit FundNamed(message.messageId, _fund(message.data), _creator(message.data), full);
        } catch (bytes memory reason) {
            failedMessages[message.messageId] = message.data;
            emit NamingFailed(message.messageId, reason);
        }
    }

    /// @notice Re-runs a stored failed message (anyone may call; the payload came from Arc).
    function retry(bytes32 messageId) external {
        bytes memory data = failedMessages[messageId];
        if (data.length == 0) revert NothingToRetry();
        delete failedMessages[messageId];
        string memory full = this.name(messageId, data);
        emit FundNamed(messageId, _fund(data), _creator(data), full);
    }

    /// @notice Does the naming. External so failures can be caught; only callable by this contract.
    function name(bytes32 messageId, bytes calldata data) external returns (string memory full) {
        if (msg.sender != address(this)) revert OnlySelf();
        FundNameLib.FundMessage memory m = abi.decode(data, (FundNameLib.FundMessage));
        string memory base = FundNameLib.sanitize(m.label);
        if (bytes(base).length == 0) base = "fund";

        (string memory label, bool exists) = _chooseLabel(base, m.fund);
        bytes memory dns = FundNameLib.dnsName(label, PARENT);
        bytes32 node = FundNameLib.node(label, PARENT);

        if (!exists) {
            // The label may be a symbol link to another fund's bundle: detach it so we do not
            // overwrite that fund's records. A real fund name beats a symbol link.
            if (resolver.getRecordId(node) != 0) resolver.linkToRecord(dns, 0);
            uint64 expiry = ethRegistry.getExpiry(uint256(keccak256(bytes(PARENT))));
            userRegistry.register(label, m.creator, address(0), address(resolver), ROLE_RENEW, expiry);
        }
        _writeRecords(dns, m, messageId);

        // <symbol>.inphinity.eth -> this bundle, if that name is free.
        string memory sym = FundNameLib.sanitize(m.symbol);
        if (bytes(sym).length != 0 && keccak256(bytes(sym)) != keccak256(bytes(label))) {
            bytes32 symNode = FundNameLib.node(sym, PARENT);
            IEnsV2Registry.State memory st = userRegistry.getState(uint256(keccak256(bytes(sym))));
            if (st.status == 0 && resolver.getRecordId(symNode) == 0) {
                resolver.linkToNode(FundNameLib.dnsName(sym, PARENT), node);
            }
        }
        resolver.linkToNode(FundNameLib.dnsName("latest", PARENT), node);

        processed[messageId] = true;
        full = string.concat(label, ".", PARENT, ".eth");
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /// @dev First of base, base-2, base-3... that is free or already this fund's name.
    function _chooseLabel(string memory base, address fund) internal view returns (string memory, bool) {
        for (uint256 n = 1; n <= MAX_SUFFIX; ++n) {
            string memory label = FundNameLib.withSuffix(base, n);
            IEnsV2Registry.State memory st = userRegistry.getState(uint256(keccak256(bytes(label))));
            if (st.status == 0) return (label, false);
            if (st.status == REGISTERED && _arcAddress(label) == fund) return (label, true);
        }
        revert NoFreeLabel();
    }

    function _arcAddress(string memory label) internal view returns (address) {
        bytes32 node = FundNameLib.node(label, PARENT);
        bytes memory call_ = abi.encodeWithSignature("addr(bytes32,uint256)", node, ARC_COIN_TYPE);
        try resolver.resolve(FundNameLib.dnsName(label, PARENT), call_) returns (bytes memory out) {
            bytes memory a = abi.decode(out, (bytes));
            return a.length == 20 ? address(bytes20(a)) : address(0);
        } catch {
            return address(0);
        }
    }

    function _writeRecords(bytes memory dns, FundNameLib.FundMessage memory m, bytes32 messageId) internal {
        resolver.setAddress(dns, ARC_COIN_TYPE, abi.encodePacked(m.fund));
        string memory fund = m.fund.toChecksumHexString();
        _text(dns, "name", m.name);
        _text(dns, "description", string.concat(m.name, " (", m.symbol, "): an Inphinity index fund on Arc Testnet holding ", _symbols(m.weights), "."));
        _text(dns, "url", string.concat("https://explorer.testnet.arc.io/address/", fund));
        _text(dns, "inphinity.symbol", m.symbol);
        _text(dns, "inphinity.weights", m.weights);
        _text(dns, "inphinity.tokens", m.tokens);
        _text(dns, "inphinity.fee", uint256(m.feeBps).toString());
        _text(dns, "inphinity.creator", m.creator.toChecksumHexString());
        _text(dns, "inphinity.chain", "arc-testnet:5042002");
        _text(dns, "inphinity.index", m.index.toString());
        _text(dns, "inphinity.disclaimer", "Testnet mock tokens, not real securities.");
        _text(dns, "inphinity.ccip", uint256(messageId).toHexString(32)); // provenance: the CCIP message id
    }

    function _text(bytes memory dns, string memory key, string memory value) internal {
        resolver.setText(dns, key, value);
    }

    /// @dev "tAAPL:3000,tMSFT:2500" -> "tAAPL, tMSFT"
    function _symbols(string memory weights) internal pure returns (string memory out) {
        bytes memory w = bytes(weights);
        bool skipping;
        for (uint256 i; i < w.length; ++i) {
            if (w[i] == ":") skipping = true;
            else if (w[i] == ",") {
                skipping = false;
                out = string.concat(out, ", ");
            } else if (!skipping) {
                out = string.concat(out, string(abi.encodePacked(w[i])));
            }
        }
    }

    function _fund(bytes memory data) internal pure returns (address) {
        return abi.decode(data, (FundNameLib.FundMessage)).fund;
    }

    function _creator(bytes memory data) internal pure returns (address) {
        return abi.decode(data, (FundNameLib.FundMessage)).creator;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {ExtraArgsCodec} from "@chainlink/contracts-ccip/contracts/libraries/ExtraArgsCodec.sol";
import {Ownable} from "@openzeppelin/contracts@5.3.0/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts@5.3.0/utils/Strings.sol";

import {FundLabel} from "./FundLabel.sol";
import {IERC20Symbol, IIndexFactory, IIndexFund} from "./interfaces/IInphinity.sol";

/// @title FundNameSender (Arc Testnet)
/// @notice Announces an Inphinity index fund to Ethereum Sepolia over Chainlink CCIP, where
///         FundNameReceiver registers `<label>.inphinity.eth` for it in our ENSv2 registry.
/// @dev Permissionless: anyone may announce any fund the live IndexFactory created (the
///      `isIndex` check is the spam filter), once per fund. All fund data is read onchain here, so a
///      caller cannot inject records. Only the fund's creator may suggest a label; everyone else
///      gets the label derived from the symbol (then name), like ens/src/relayer.ts.
///      The CCIP fee is paid in Arc's native USDC (`feeToken = address(0)`); any excess is refunded.
contract FundNameSender is Ownable {
    IRouterClient public immutable router;
    IIndexFactory public immutable factory;
    uint64 public immutable destChainSelector;

    /// @notice FundNameReceiver on Sepolia. Set once the receiver is deployed (it needs this address).
    address public receiver;
    /// @notice Destination execution gas limit (Sepolia). Measured on a fork; see ccip/README.md.
    uint32 public gasLimit;

    /// @notice CCIP message id per announced fund (zero = not announced yet).
    mapping(address fund => bytes32 messageId) public announced;

    event FundAnnounced(address indexed fund, bytes32 indexed messageId, string label, uint256 fee);
    event ReceiverSet(address receiver);
    event GasLimitSet(uint32 gasLimit);
    event AnnouncementCleared(address indexed fund);

    error NotAnIndexFund(address fund);
    error AlreadyAnnounced(address fund, bytes32 messageId);
    error ReceiverNotSet();
    error OnlyCreatorMaySetLabel(address creator);
    error InsufficientFee(uint256 sent, uint256 fee);
    error RefundFailed();
    error FundNotInFactory(address fund);

    constructor(address owner_, address router_, address factory_, uint64 destChainSelector_, uint32 gasLimit_)
        Ownable(owner_)
    {
        router = IRouterClient(router_);
        factory = IIndexFactory(factory_);
        destChainSelector = destChainSelector_;
        gasLimit = gasLimit_;
    }

    // ---------------------------------------------------------------------------------------------
    // Announce
    // ---------------------------------------------------------------------------------------------

    /// @notice Sends `fund` to Sepolia with the label derived from its symbol (else name).
    /// @param fund A fund created by IndexFactory. Send at least `getFee(fund)` as msg.value.
    function announce(address fund) external payable returns (bytes32 messageId) {
        return _announce(fund, "");
    }

    /// @notice Same as `announce`, with the label the creator chose in `createIndex` (the
    ///         `IndexCreated.label` field). Only the fund's creator may call this.
    function announceWithLabel(address fund, string calldata label) external payable returns (bytes32 messageId) {
        address creator = IIndexFund(fund).creator();
        if (msg.sender != creator) revert OnlyCreatorMaySetLabel(creator);
        return _announce(fund, label);
    }

    /// @notice CCIP fee in native USDC (wei, 18 decimals) for `announce(fund)`.
    function getFee(address fund) external view returns (uint256) {
        return router.getFee(destChainSelector, buildMessage(fund, ""));
    }

    /// @notice CCIP fee for `announceWithLabel(fund, label)`.
    function getFeeWithLabel(address fund, string calldata label) external view returns (uint256) {
        return router.getFee(destChainSelector, buildMessage(fund, label));
    }

    // ---------------------------------------------------------------------------------------------
    // Message building (public views so UIs and scripts can inspect exactly what is sent)
    // ---------------------------------------------------------------------------------------------

    /// @notice The exact payload `announce` would send: label, links and the relayer's record bundle
    ///         (ens/src/relayer.ts processFund), formatted here from onchain fund data.
    function buildPayload(address fund, string memory labelHint) public view returns (FundLabel.Payload memory p) {
        if (!factory.isIndex(fund)) revert NotAnIndexFund(fund);
        IIndexFund f = IIndexFund(fund);
        string memory name = f.name();
        string memory symbol = f.symbol();
        p.fund = fund;
        p.creator = f.creator();
        p.index = uint32(_indexOf(fund));

        string memory label = FundLabel.sanitize(labelHint);
        if (bytes(label).length == 0) label = FundLabel.sanitize(symbol);
        if (bytes(label).length == 0) label = FundLabel.sanitize(name);
        if (bytes(label).length == 0) label = string.concat("fund-", Strings.toString(p.index));
        p.label = label;
        p.symbolLabel = FundLabel.sanitize(symbol);
        p.texts = _texts(f, name, symbol, p.creator, p.index);
    }

    /// @dev Same keys, order and formatting as the relayer, so CCIP names look identical.
    function _texts(IIndexFund f, string memory name, string memory symbol, address creator, uint256 index)
        internal
        view
        returns (FundLabel.Text[] memory t)
    {
        address[] memory tokens = f.getTokens();
        uint16[] memory weights = f.getWeights();
        string memory symbols;
        string memory weightList;
        string memory tokenList;
        for (uint256 i; i < tokens.length; ++i) {
            string memory sym = _symbolOf(tokens[i]);
            string memory sep = i == 0 ? "" : ",";
            symbols = string.concat(symbols, i == 0 ? "" : ", ", sym);
            weightList = string.concat(weightList, sep, sym, ":", Strings.toString(weights[i]));
            tokenList = string.concat(tokenList, sep, Strings.toChecksumHexString(tokens[i]));
        }
        string memory fundHex = Strings.toChecksumHexString(address(f));
        t = new FundLabel.Text[](11);
        t[0] = FundLabel.Text("name", name);
        t[1] = FundLabel.Text(
            "description",
            string.concat(name, " (", symbol, "): an Inphinity index fund on Arc Testnet holding ", symbols, ".")
        );
        t[2] = FundLabel.Text("url", string.concat("https://explorer.testnet.arc.io/address/", fundHex));
        t[3] = FundLabel.Text("inphinity.symbol", symbol);
        t[4] = FundLabel.Text("inphinity.weights", weightList);
        t[5] = FundLabel.Text("inphinity.tokens", tokenList);
        t[6] = FundLabel.Text("inphinity.fee", Strings.toString(f.feeBps()));
        t[7] = FundLabel.Text("inphinity.creator", Strings.toChecksumHexString(creator));
        t[8] = FundLabel.Text("inphinity.chain", "arc-testnet:5042002");
        t[9] = FundLabel.Text("inphinity.index", Strings.toString(index));
        // A name with its own bundle does not fall back to the default bundle field by field.
        t[10] = FundLabel.Text("inphinity.disclaimer", "Testnet mock tokens, not real securities.");
    }

    function buildMessage(address fund, string memory labelHint) public view returns (Client.EVM2AnyMessage memory) {
        return _message(buildPayload(fund, labelHint));
    }

    function _message(FundLabel.Payload memory p) internal view returns (Client.EVM2AnyMessage memory) {
        address to = receiver;
        if (to == address(0)) revert ReceiverNotSet();
        return Client.EVM2AnyMessage({
            receiver: abi.encode(to),
            data: abi.encode(p),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0), // native USDC
            // ExtraArgsV3: destination gas limit, default verifiers/executor, wait for source finality.
            extraArgs: ExtraArgsCodec._getBasicEncodedExtraArgsV3(gasLimit, bytes4(0))
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function setReceiver(address receiver_) external onlyOwner {
        receiver = receiver_;
        emit ReceiverSet(receiver_);
    }

    function setGasLimit(uint32 gasLimit_) external onlyOwner {
        gasLimit = gasLimit_;
        emit GasLimitSet(gasLimit_);
    }

    /// @notice Lets a fund be announced again, e.g. after a message failed on Sepolia and was
    ///         abandoned. The receiver is idempotent, so a duplicate delivery is harmless.
    function clearAnnouncement(address fund) external onlyOwner {
        delete announced[fund];
        emit AnnouncementCleared(fund);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _announce(address fund, string memory labelHint) internal returns (bytes32 messageId) {
        bytes32 prev = announced[fund];
        if (prev != bytes32(0)) revert AlreadyAnnounced(fund, prev);
        FundLabel.Payload memory p = buildPayload(fund, labelHint);
        Client.EVM2AnyMessage memory message = _message(p);
        uint256 fee = router.getFee(destChainSelector, message);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);

        // The Router keeps any overpayment, so send exactly the fee and refund the rest.
        messageId = router.ccipSend{value: fee}(destChainSelector, message);
        announced[fund] = messageId;
        emit FundAnnounced(fund, messageId, p.label, fee);

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Funds are appended, so a fund being announced right after creation is found first.
    function _indexOf(address fund) internal view returns (uint256) {
        uint256 n = factory.indexCount();
        for (uint256 i = n; i > 0; --i) {
            if (factory.indexAt(i - 1) == fund) return i - 1;
        }
        revert FundNotInFactory(fund);
    }

    /// @dev Same fallback as the relayer: the first 8 characters of the checksummed address.
    function _symbolOf(address token) internal view returns (string memory) {
        try IERC20Symbol(token).symbol() returns (string memory s) {
            return s;
        } catch {
            bytes memory hexAddr = bytes(Strings.toChecksumHexString(token));
            bytes memory out = new bytes(8);
            for (uint256 i; i < 8; ++i) out[i] = hexAddr[i];
            return string(out);
        }
    }
}

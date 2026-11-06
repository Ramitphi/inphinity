// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IIndexRegistrar} from "../interfaces/IIndexRegistrar.sol";
import {Client, IRouterClient} from "./CcipInterfaces.sol";
import {IInphinityFactory, IInphinityFund} from "./EnsV2Interfaces.sol";
import {FundNameLib} from "./FundNameLib.sol";

/// @title ArcEnsRegistrar
/// @notice Arc Testnet side of the Inphinity ENS bridge. IndexFactory calls `register` inside every
/// `createIndex`; this contract reads the new fund's data and sends it to `InphinityEnsReceiver` on
/// Ethereum Sepolia through Chainlink CCIP, which registers `<label>.inphinity.eth` in ENSv2.
/// @dev Never reverts once called by the factory, so naming can never block fund creation: if the
/// receiver is unset, the fee balance is too low or the router refuses, it emits `NamingSkipped`
/// and the off-chain relayer (ens/src/relayer.ts) can still name the fund later.
/// Fees are paid in Arc's native token (USDC) from this contract's balance: fund it by sending value.
contract ArcEnsRegistrar is IIndexRegistrar, Ownable2Step {
    using Strings for uint256;
    using Strings for address;

    string public constant PARENT = "inphinity";

    IRouterClient public immutable router;
    address public immutable factory;
    uint64 public immutable destChainSelector;

    /// @notice InphinityEnsReceiver on Sepolia.
    address public receiver;
    /// @notice Gas limit for `ccipReceive` on Sepolia (register + ~12 records + links uses ~1.3M).
    uint256 public gasLimit = 2_500_000;

    event ReceiverUpdated(address receiver);
    event GasLimitUpdated(uint256 gasLimit);
    event NamingRequested(address indexed fund, address indexed creator, string label, bytes32 indexed messageId, uint256 fee);
    event NamingSkipped(address indexed fund, string label, string reason);
    event Withdrawn(address to, uint256 amount);

    error OnlyFactory();
    error InvalidConfiguration();
    error WithdrawFailed();

    constructor(address owner_, address factory_, address router_, uint64 destChainSelector_) Ownable(owner_) {
        if (factory_.code.length == 0 || router_.code.length == 0 || destChainSelector_ == 0) revert InvalidConfiguration();
        factory = factory_;
        router = IRouterClient(router_);
        destChainSelector = destChainSelector_;
    }

    receive() external payable {}

    // ------------------------------------------------------------------
    // IIndexRegistrar
    // ------------------------------------------------------------------

    /// @inheritdoc IIndexRegistrar
    /// @dev `description` is creator-supplied free text and is deliberately not published: ENS
    /// records are only written from on-chain fund data, so a creator cannot inject links.
    function register(string calldata label, address fund, address creator, string calldata /* description */)
        external
        returns (bytes32 node)
    {
        if (msg.sender != factory) revert OnlyFactory();
        string memory l = _label(label, IInphinityFund(fund));
        node = FundNameLib.node(l, PARENT);
        if (receiver == address(0)) {
            emit NamingSkipped(fund, l, "receiver not set");
            return node;
        }
        _send(fund, creator, l, _message(_payload(l, fund, creator)));
    }

    /// @inheritdoc IIndexRegistrar
    /// @dev Availability lives on Sepolia; the receiver dedupes taken labels (-2, -3, ...).
    function isAvailable(string calldata label) external pure returns (bool) {
        return FundNameLib.isValid(label);
    }

    // ------------------------------------------------------------------
    // Views and admin
    // ------------------------------------------------------------------

    /// @notice Current CCIP fee for a typical message, in native wei (18 decimals).
    function quoteFee() external view returns (uint256) {
        bytes memory sample = abi.encode(
            FundNameLib.FundMessage("sample-fund-label", address(1), address(2), "Sample Fund Name", "SAMPLE", 100, "tAAPL:2500,tMSFT:2500,tNVDA:2500,tGOOGL:2500", "", 0)
        );
        return router.getFee(destChainSelector, _message(sample));
    }

    function setReceiver(address receiver_) external onlyOwner {
        receiver = receiver_;
        emit ReceiverUpdated(receiver_);
    }

    function setGasLimit(uint256 gasLimit_) external onlyOwner {
        gasLimit = gasLimit_;
        emit GasLimitUpdated(gasLimit_);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /// @dev Requested label, else symbol, else name, else "fund"; always a valid label.
    function _label(string calldata requested, IInphinityFund f) internal view returns (string memory l) {
        l = FundNameLib.sanitize(requested);
        if (bytes(l).length == 0) l = FundNameLib.sanitize(f.symbol());
        if (bytes(l).length == 0) l = FundNameLib.sanitize(f.name());
        if (bytes(l).length == 0) l = "fund";
    }

    function _payload(string memory l, address fund, address creator) internal view returns (bytes memory) {
        IInphinityFund f = IInphinityFund(fund);
        (string memory weights, string memory tokens) = _composition(f);
        FundNameLib.FundMessage memory m;
        m.label = l;
        m.fund = fund;
        m.creator = creator;
        m.name = f.name();
        m.symbol = f.symbol();
        m.feeBps = f.feeBps();
        m.weights = weights;
        m.tokens = tokens;
        m.index = IInphinityFactory(factory).indexCount() - 1; // the factory pushes the fund before calling us
        return abi.encode(m);
    }

    /// @dev Never reverts: any failure becomes a NamingSkipped event.
    function _send(address fund, address creator, string memory l, Client.EVM2AnyMessage memory message) internal {
        uint256 fee;
        try router.getFee(destChainSelector, message) returns (uint256 quoted) {
            fee = quoted;
        } catch {
            emit NamingSkipped(fund, l, "fee quote failed");
            return;
        }
        if (fee > address(this).balance) {
            emit NamingSkipped(fund, l, "fee balance too low");
            return;
        }
        try router.ccipSend{value: fee}(destChainSelector, message) returns (bytes32 messageId) {
            emit NamingRequested(fund, creator, l, messageId, fee);
        } catch {
            emit NamingSkipped(fund, l, "ccipSend failed");
        }
    }

    function _message(bytes memory data) internal view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: data,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true}))
        });
    }

    function _composition(IInphinityFund f) internal view returns (string memory weights, string memory tokens) {
        address[] memory t = f.getTokens();
        uint16[] memory w = f.getWeights();
        for (uint256 i; i < t.length; ++i) {
            string memory sym;
            try IERC20Metadata(t[i]).symbol() returns (string memory s) {
                sym = s;
            } catch {
                sym = t[i].toHexString();
            }
            string memory sep = i == 0 ? "" : ",";
            weights = string.concat(weights, sep, sym, ":", uint256(w[i]).toString());
            tokens = string.concat(tokens, sep, t[i].toChecksumHexString());
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Chainlink CCIP types, vendored from smartcontractkit/chainlink-ccip
/// (Client.sol, IRouterClient.sol, IAny2EVMMessageReceiver.sol) so the repo needs no extra package.
library Client {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender; // abi.encode(sender address)
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    struct EVM2AnyMessage {
        bytes receiver; // abi.encode(receiver address)
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken; // address(0) = pay in the source chain's native token
        bytes extraArgs;
    }

    /// @dev bytes4(keccak256("CCIP EVMExtraArgsV2"))
    bytes4 internal constant GENERIC_EXTRA_ARGS_V2_TAG = 0x181dcf10;

    struct GenericExtraArgsV2 {
        uint256 gasLimit;
        bool allowOutOfOrderExecution;
    }

    function _argsToBytes(GenericExtraArgsV2 memory extraArgs) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(GENERIC_EXTRA_ARGS_V2_TAG, extraArgs);
    }
}

interface IRouterClient {
    function isChainSupported(uint64 destChainSelector) external view returns (bool);
    function getFee(uint64 destinationChainSelector, Client.EVM2AnyMessage memory message)
        external view returns (uint256 fee);
    function ccipSend(uint64 destinationChainSelector, Client.EVM2AnyMessage calldata message)
        external payable returns (bytes32 messageId);
}

/// @dev The OffRamp only calls receivers that report this interface through ERC-165.
interface IAny2EVMMessageReceiver {
    function ccipReceive(Client.Any2EVMMessage calldata message) external;
}

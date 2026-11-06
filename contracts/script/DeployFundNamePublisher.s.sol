// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {FundNamePublisher} from "../FundNamePublisher.sol";
import {IENS} from "../interfaces/IENS.sol";

/// @notice Deploys FundNamePublisher to Ethereum Sepolia and allowlists the relayer.
/// Env vars:
///   PARENT_NAME     - parent ENS name you own on Sepolia, e.g. "inphinity.eth"
///   RELAYER_ADDRESS - optional; account the relayer script signs with (defaults to the deployer)
/// Run:
///   forge script contracts/script/DeployFundNamePublisher.s.sol --rpc-url sepolia --broadcast --account <keystore>
/// Afterwards the parent's owner must approve the publisher (the script prints the exact call).
contract DeployFundNamePublisher is Script {
    address constant ENS_REGISTRY = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant NAME_WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address constant PUBLIC_RESOLVER = 0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5;

    function run() external returns (FundNamePublisher pub) {
        require(block.chainid == 11155111, "Deploy on Ethereum Sepolia");
        string memory parent = vm.envString("PARENT_NAME");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address relayer = vm.envOr("RELAYER_ADDRESS", deployer);
        pub = new FundNamePublisher(deployer, ENS_REGISTRY, NAME_WRAPPER, PUBLIC_RESOLVER, parent);
        pub.setPublisher(relayer, true);
        vm.stopBroadcast();

        bool wrapped = IENS(ENS_REGISTRY).owner(pub.parentNode()) == NAME_WRAPPER;
        console2.log("FundNamePublisher:", address(pub));
        console2.log("Relayer allowlisted:", relayer);
        console2.log("Parent is wrapped:", wrapped);
        console2.log("Next, from the parent owner's wallet, approve the publisher:");
        console2.log(
            string.concat(
                "  cast send ", vm.toString(wrapped ? NAME_WRAPPER : ENS_REGISTRY),
                " 'setApprovalForAll(address,bool)' ", vm.toString(address(pub)), " true --rpc-url sepolia"
            )
        );
    }
}

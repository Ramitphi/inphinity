// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FundNamePublisher} from "../FundNamePublisher.sol";
import {IENS, INameWrapper, IPublicResolver} from "../interfaces/IENS.sol";

interface IApproval {
    function setApprovalForAll(address operator, bool approved) external;
}

/// @notice Runs against the real ENS contracts on a Sepolia fork. Skipped unless both are set:
///   SEPOLIA_RPC_URL=https://...  FORK_PARENT_NAME=yourname.eth  forge test --mt testFork
contract FundNamePublisherForkTest is Test {
    address constant ENS_REGISTRY = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant NAME_WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address constant PUBLIC_RESOLVER = 0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5;

    function testFork_publishOnRealSepoliaEns() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        string memory parent = vm.envOr("FORK_PARENT_NAME", string(""));
        if (bytes(rpc).length == 0 || bytes(parent).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        bytes32 parentNode = vm.ensNamehash(parent);
        address registryOwner = IENS(ENS_REGISTRY).owner(parentNode);
        bool wrapped = registryOwner == NAME_WRAPPER;
        address parentOwner = wrapped ? INameWrapper(NAME_WRAPPER).ownerOf(uint256(parentNode)) : registryOwner;
        assertTrue(parentOwner != address(0), "parent name has no owner on Sepolia");

        FundNamePublisher pub = new FundNamePublisher(address(this), ENS_REGISTRY, NAME_WRAPPER, PUBLIC_RESOLVER, parent);
        pub.setPublisher(address(this), true);
        vm.prank(parentOwner);
        IApproval(wrapped ? NAME_WRAPPER : ENS_REGISTRY).setApprovalForAll(address(pub), true);

        FundNamePublisher.FundRecord memory r;
        r.label = "forktest0001";
        r.fund = makeAddr("fund");
        r.creator = makeAddr("creator");
        r.venue = makeAddr("venue");
        r.name = "Fork Test Fund";
        r.symbol = "FORK";
        r.description = "fork";
        r.feeBps = 100;
        r.createdAt = uint64(block.timestamp);
        r.holdings = new FundNamePublisher.Holding[](2);
        r.holdings[0] = FundNamePublisher.Holding(makeAddr("a"), "tAAPL", 5000);
        r.holdings[1] = FundNamePublisher.Holding(makeAddr("b"), "tMSFT", 5000);

        bytes32 node = pub.publish(r);
        assertEq(node, vm.ensNamehash(string.concat("forktest0001.", parent)));
        assertEq(IENS(ENS_REGISTRY).resolver(node), PUBLIC_RESOLVER);
        assertEq(IPublicResolver(PUBLIC_RESOLVER).text(node, "symbol"), "FORK");
        assertEq(IPublicResolver(PUBLIC_RESOLVER).text(node, "fee"), "100");
        assertEq(IPublicResolver(PUBLIC_RESOLVER).addr(node, pub.ARC_COIN_TYPE()), abi.encodePacked(r.fund));
    }
}

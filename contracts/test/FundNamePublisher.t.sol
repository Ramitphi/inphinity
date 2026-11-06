// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FundNamePublisher} from "../FundNamePublisher.sol";
import {MockENSRegistry, MockNameWrapper, MockPublicResolver} from "./mocks/MockENS.sol";

contract FundNamePublisherTest is Test {
    MockENSRegistry ens;
    MockNameWrapper wrapper;
    MockPublicResolver resolver;
    FundNamePublisher wrappedPub;
    FundNamePublisher unwrappedPub;

    address admin = makeAddr("admin");
    address relayer = makeAddr("relayer");
    address parentOwner = makeAddr("parentOwner");
    address fund = makeAddr("fund");
    address creator = makeAddr("creator");
    address venue = makeAddr("venue");
    address aapl = makeAddr("tAAPL");
    address nvda = makeAddr("tNVDA");

    bytes32 ethNode;

    function setUp() public {
        ens = new MockENSRegistry();
        wrapper = new MockNameWrapper(ens);
        resolver = new MockPublicResolver(ens, wrapper);
        ethNode = ens.setSubnodeOwner(bytes32(0), keccak256("eth"), address(this));

        // Wrapped parent: inphinity.eth is held by the NameWrapper for parentOwner.
        bytes32 wrappedParent = ens.setSubnodeOwner(ethNode, keccak256("inphinity"), address(wrapper));
        wrapper.mockWrap(wrappedParent, parentOwner);
        wrappedPub = new FundNamePublisher(admin, address(ens), address(wrapper), address(resolver), "inphinity.eth");

        // Unwrapped parent: plainfunds.eth is owned directly in the registry.
        ens.setSubnodeOwner(ethNode, keccak256("plainfunds"), parentOwner);
        unwrappedPub = new FundNamePublisher(admin, address(ens), address(wrapper), address(resolver), "plainfunds.eth");

        vm.startPrank(parentOwner);
        wrapper.setApprovalForAll(address(wrappedPub), true);
        ens.setApprovalForAll(address(unwrappedPub), true);
        vm.stopPrank();

        vm.startPrank(admin);
        wrappedPub.setPublisher(relayer, true);
        unwrappedPub.setPublisher(relayer, true);
        vm.stopPrank();
    }

    function _record(string memory label, address fund_) internal view returns (FundNamePublisher.FundRecord memory r) {
        r.label = label;
        r.fund = fund_;
        r.creator = creator;
        r.venue = venue;
        r.name = "US Tech Leaders";
        r.symbol = "TECH";
        r.description = "Big US tech, equal-ish weights";
        r.feeBps = 150;
        r.createdAt = 1_762_400_000;
        r.holdings = new FundNamePublisher.Holding[](2);
        r.holdings[0] = FundNamePublisher.Holding(aapl, "tAAPL", 6000);
        r.holdings[1] = FundNamePublisher.Holding(nvda, "tNVDA", 4000);
    }

    function _expectedComposition() internal view returns (string memory) {
        return string.concat(
            '[{"symbol":"tAAPL","token":"', vm.toString(aapl), '","weightBps":6000},',
            '{"symbol":"tNVDA","token":"', vm.toString(nvda), '","weightBps":4000}]'
        );
    }

    function test_parentNodeMatchesNamehash() public view {
        assertEq(wrappedPub.parentNode(), vm.ensNamehash("inphinity.eth"));
        assertEq(unwrappedPub.parentNode(), vm.ensNamehash("plainfunds.eth"));
    }

    function test_publishUnderWrappedParent() public {
        vm.prank(relayer);
        bytes32 node = wrappedPub.publish(_record("tech", fund));

        assertEq(node, vm.ensNamehash("tech.inphinity.eth"));
        assertEq(ens.owner(node), address(wrapper));
        assertEq(wrapper.ownerOf(uint256(node)), address(wrappedPub));
        assertEq(ens.resolver(node), address(resolver));
        _assertRecords(wrappedPub, node);
        assertEq(wrappedPub.fullName("tech"), "tech.inphinity.eth");
    }

    function test_publishUnderUnwrappedParent() public {
        vm.prank(relayer);
        bytes32 node = unwrappedPub.publish(_record("tech", fund));

        assertEq(node, vm.ensNamehash("tech.plainfunds.eth"));
        assertEq(ens.owner(node), address(unwrappedPub));
        assertEq(ens.resolver(node), address(resolver));
        _assertRecords(unwrappedPub, node);
    }

    function _assertRecords(FundNamePublisher pub, bytes32 node) internal view {
        assertEq(resolver.addr(node, pub.ARC_COIN_TYPE()), abi.encodePacked(fund));
        assertEq(resolver.text(node, "name"), "US Tech Leaders");
        assertEq(resolver.text(node, "symbol"), "TECH");
        assertEq(resolver.text(node, "description"), "Big US tech, equal-ish weights");
        assertEq(resolver.text(node, "fund"), vm.toString(fund));
        assertEq(resolver.text(node, "creator"), vm.toString(creator));
        assertEq(resolver.text(node, "fee"), "150");
        assertEq(resolver.text(node, "composition"), _expectedComposition());
        assertEq(resolver.text(node, "venue"), vm.toString(venue));
        assertEq(resolver.text(node, "chain"), "eip155:5042002");
        assertEq(resolver.text(node, "created"), "1762400000");
        assertEq(pub.fundOf(node), fund);
        assertEq(pub.nodeOf(fund), node);
        assertTrue(pub.isPublished("tech"));
    }

    function test_emitsFundPublished() public {
        vm.expectEmit(address(wrappedPub));
        emit FundNamePublisher.FundPublished(vm.ensNamehash("tech.inphinity.eth"), fund, creator, "tech");
        vm.prank(relayer);
        wrappedPub.publish(_record("tech", fund));
    }

    function test_revertsForNonPublisher() public {
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        vm.expectRevert(abi.encodeWithSelector(FundNamePublisher.NotPublisher.selector, address(this)));
        wrappedPub.publish(r);
    }

    function test_revokedPublisherCannotPublish() public {
        vm.prank(admin);
        wrappedPub.setPublisher(relayer, false);
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(FundNamePublisher.NotPublisher.selector, relayer));
        wrappedPub.publish(r);
    }

    function test_revertsWhenParentOwnerDidNotApprove() public {
        vm.prank(parentOwner);
        wrapper.setApprovalForAll(address(wrappedPub), false);
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        vm.prank(relayer);
        vm.expectRevert(bytes("Unauthorised"));
        wrappedPub.publish(r);
    }

    function test_revertsOnDuplicateLabel() public {
        vm.startPrank(relayer);
        wrappedPub.publish(_record("tech", fund));
        FundNamePublisher.FundRecord memory r = _record("tech", makeAddr("otherFund"));
        vm.expectRevert(
            abi.encodeWithSelector(FundNamePublisher.NameTaken.selector, vm.ensNamehash("tech.inphinity.eth"))
        );
        wrappedPub.publish(r);
        vm.stopPrank();
    }

    function test_revertsOnDuplicateFund() public {
        vm.startPrank(relayer);
        wrappedPub.publish(_record("tech", fund));
        FundNamePublisher.FundRecord memory r = _record("tech2", fund);
        vm.expectRevert(abi.encodeWithSelector(FundNamePublisher.FundAlreadyPublished.selector, fund));
        wrappedPub.publish(r);
        vm.stopPrank();
    }

    function test_revertsWhenNameExistsOutsidePublisher() public {
        // parentOwner made "tech.plainfunds.eth" by hand before the fund existed.
        vm.prank(parentOwner);
        ens.setSubnodeOwner(vm.ensNamehash("plainfunds.eth"), keccak256("tech"), parentOwner);
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(FundNamePublisher.NameTaken.selector, vm.ensNamehash("tech.plainfunds.eth"))
        );
        unwrappedPub.publish(r);
    }

    function test_rejectsBadLabels() public {
        string[5] memory bad = ["ab", "Tech", "tech-fund", "averyveryverylonglabel", "te ch"];
        for (uint256 i; i < bad.length; ++i) {
            FundNamePublisher.FundRecord memory r = _record(bad[i], fund);
            vm.prank(relayer);
            vm.expectRevert(FundNamePublisher.InvalidLabel.selector);
            wrappedPub.publish(r);
        }
    }

    function test_rejectsWeightsNotSummingTo10000() public {
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        r.holdings[1].weightBps = 3999;
        vm.prank(relayer);
        vm.expectRevert(FundNamePublisher.InvalidHoldings.selector);
        wrappedPub.publish(r);
    }

    function test_rejectsDuplicateHolding() public {
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        r.holdings[1].token = aapl;
        vm.prank(relayer);
        vm.expectRevert(FundNamePublisher.InvalidHoldings.selector);
        wrappedPub.publish(r);
    }

    function test_rejectsSymbolThatWouldBreakJson() public {
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        r.holdings[0].symbol = 'tA"PL';
        vm.prank(relayer);
        vm.expectRevert(FundNamePublisher.InvalidHoldings.selector);
        wrappedPub.publish(r);
    }

    function test_rejectsTooManyHoldings() public {
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        r.holdings = new FundNamePublisher.Holding[](11);
        for (uint256 i; i < 11; ++i) {
            r.holdings[i] = FundNamePublisher.Holding(address(uint160(i + 1)), "tX", i == 0 ? 1000 : 900);
        }
        vm.prank(relayer);
        vm.expectRevert(FundNamePublisher.InvalidHoldings.selector);
        wrappedPub.publish(r);
    }

    function test_rejectsFeeAboveCap() public {
        FundNamePublisher.FundRecord memory r = _record("tech", fund);
        r.feeBps = 201;
        vm.prank(relayer);
        vm.expectRevert(FundNamePublisher.InvalidRecord.selector);
        wrappedPub.publish(r);
    }

    function test_updateTextByPublisherAndOwner() public {
        vm.prank(relayer);
        bytes32 node = wrappedPub.publish(_record("tech", fund));

        vm.prank(relayer);
        wrappedPub.updateText(node, "pool", "0x000000000000000000000000000000000000bEEF");
        assertEq(resolver.text(node, "pool"), "0x000000000000000000000000000000000000bEEF");

        vm.prank(admin);
        wrappedPub.updateText(node, "description", "Updated");
        assertEq(resolver.text(node, "description"), "Updated");
    }

    function test_updateTextRejectsStrangersAndUnknownNodes() public {
        vm.prank(relayer);
        bytes32 node = wrappedPub.publish(_record("tech", fund));

        vm.expectRevert(abi.encodeWithSelector(FundNamePublisher.NotPublisher.selector, address(this)));
        wrappedPub.updateText(node, "pool", "x");

        bytes32 unknown = vm.ensNamehash("nope.inphinity.eth");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FundNamePublisher.UnknownNode.selector, unknown));
        wrappedPub.updateText(unknown, "pool", "x");
    }

    function test_constructorRejectsMissingParent() public {
        vm.expectRevert(FundNamePublisher.InvalidConfiguration.selector);
        new FundNamePublisher(admin, address(ens), address(wrapper), address(resolver), "missing.eth");
    }

    function test_constructorRejectsMalformedParent() public {
        string[4] memory bad = ["", "Inphinity.eth", "inphinity..eth", ".eth"];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(FundNamePublisher.InvalidConfiguration.selector);
            new FundNamePublisher(admin, address(ens), address(wrapper), address(resolver), bad[i]);
        }
    }

    function test_onlyOwnerSetsPublishers() public {
        vm.expectRevert();
        wrappedPub.setPublisher(address(this), true);
    }
}

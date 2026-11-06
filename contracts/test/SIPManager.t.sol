// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArcBase} from "./Base.t.sol";
import {IndexFund} from "../IndexFund.sol";
import {SIPManager} from "../SIPManager.sol";

contract SIPManagerTest is ArcBase {
    event SIPCreated(
        uint256 indexed id, address indexed owner, address indexed fund, uint256 amount,
        uint32 interval, uint32 maxInstallments, uint64 nextDue
    );
    event SIPExecuted(uint256 indexed id, uint32 installment, uint256 amount, uint256 shares, uint64 nextDue);
    event SIPFailed(uint256 indexed id, uint8 consecutiveFailures);
    event SIPPaused(uint256 indexed id);
    event SIPCancelled(uint256 indexed id);

    SIPManager internal sip;
    uint256 internal constant AMT = 100e6;
    uint32 internal constant EVERY = 300;

    function setUp() public override {
        super.setUp();
        sip = new SIPManager(address(usdc), address(factory));
        vm.prank(alice);
        usdc.approve(address(sip), type(uint256).max);
    }

    // ------------------------------------------------------------ constructor

    function test_Constructor() public {
        assertEq(sip.usdc(), address(usdc));
        assertEq(sip.factory(), address(factory));
        vm.expectRevert(SIPManager.InvalidConfiguration.selector);
        new SIPManager(address(0), address(factory));
        vm.expectRevert(SIPManager.InvalidConfiguration.selector);
        new SIPManager(address(usdc), address(0));
        vm.expectRevert(SIPManager.InvalidConfiguration.selector);
        new SIPManager(address(aapl), address(factory)); // usdc mismatch
    }

    // ------------------------------------------------------------ create

    function test_CreateSIP_Deferred() public {
        vm.expectEmit(true, true, true, true, address(sip));
        emit SIPCreated(0, alice, address(fund), AMT, EVERY, 0, uint64(block.timestamp + EVERY));
        vm.prank(alice);
        uint256 id = sip.createSIP(address(fund), AMT, EVERY, 0, false);

        assertEq(id, 0);
        assertEq(sip.sipCount(), 1);
        assertEq(sip.activeSIPs(alice), 1);
        SIPManager.SIP memory s = sip.getSIP(0);
        assertEq(s.owner, alice);
        assertEq(s.fund, address(fund));
        assertEq(s.amount, AMT);
        assertEq(s.done, 0);
        assertEq(s.status, 0);
        assertEq(s.nextDue, block.timestamp + EVERY);
        assertEq(sip.sipsByOwner(alice).length, 1);
        assertFalse(sip.isDue(0));
        assertEq(fund.balanceOf(alice), 0);
    }

    function test_CreateSIP_StartNowInvestsImmediately() public {
        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        sip.createSIP(address(fund), AMT, EVERY, 0, true);
        assertEq(usdc.balanceOf(alice), usdcBefore - AMT);
        assertGt(fund.balanceOf(alice), 0);
        assertEq(fund.balanceOf(address(sip)), 0, "manager keeps no shares");
        assertEq(sip.getSIP(0).done, 1);
        assertEq(sip.getSIP(0).invested, AMT);
    }

    function test_CreateSIP_Reverts() public {
        vm.startPrank(alice);
        vm.expectRevert(SIPManager.InvalidSIP.selector);
        sip.createSIP(address(aapl), AMT, EVERY, 0, false);
        vm.expectRevert(SIPManager.InvalidAmount.selector);
        sip.createSIP(address(fund), 1e6 - 1, EVERY, 0, false);
        vm.expectRevert(SIPManager.InvalidInterval.selector);
        sip.createSIP(address(fund), AMT, 123, 0, false);
        for (uint256 i; i < 20; ++i) sip.createSIP(address(fund), AMT, EVERY, 0, false);
        vm.expectRevert(SIPManager.ActiveLimit.selector);
        sip.createSIP(address(fund), AMT, EVERY, 0, false);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ execute end to end

    function test_ExecuteSIP_InvestsAndForwardsLockedSharesToOwner() public {
        vm.prank(alice);
        uint256 id = sip.createSIP(address(fund), AMT, EVERY, 0, false);

        vm.expectRevert(SIPManager.NotDue.selector);
        sip.executeSIP(id);

        skip(EVERY);
        assertTrue(sip.isDue(id));
        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 expected = fund.previewInvest(AMT);

        vm.expectEmit(true, false, false, false, address(sip));
        emit SIPExecuted(id, 1, AMT, expected, 0);
        sip.executeSIP(id); // anyone may trigger

        assertEq(usdc.balanceOf(alice), usdcBefore - AMT);
        assertEq(fund.balanceOf(alice), expected);
        assertEq(fund.balanceOf(address(sip)), 0);
        assertEq(usdc.balanceOf(address(sip)), 0);
        assertEq(usdc.allowance(address(sip), address(fund)), 0);
        SIPManager.SIP memory s = sip.getSIP(id);
        assertEq(s.done, 1);
        assertEq(s.invested, AMT);
        assertEq(s.nextDue, block.timestamp + EVERY);
        assertFalse(sip.isDue(id));

        // lock moved with the forwarded shares
        assertEq(fund.lockedSharesOf(alice), expected);
        assertEq(fund.lockedSharesOf(address(sip)), 0);
        assertEq(fund.unlockTime(alice), block.timestamp + 60);

        vm.prank(alice);
        vm.expectPartialRevert(IndexFund.HoldActive.selector);
        fund.redeem(expected, 0);

        skip(60);
        vm.prank(alice);
        uint256 out = fund.redeem(expected, 0);
        assertGt(out, 0);
    }

    function test_ExecuteSIP_SecondInstallmentOnlyLocksNewShares() public {
        vm.prank(alice);
        uint256 id = sip.createSIP(address(fund), AMT, EVERY, 0, true);
        uint256 s1 = fund.balanceOf(alice);
        skip(EVERY);
        sip.executeSIP(id);
        uint256 s2 = fund.balanceOf(alice) - s1;
        assertEq(sip.getSIP(id).done, 2);
        assertEq(fund.lockedSharesOf(alice), s2, "first installment's shares are free by now");

        vm.prank(alice);
        fund.redeem(s1, 0);
    }

    function test_ExecuteSIP_CompletesAfterMaxInstallments() public {
        vm.prank(alice);
        uint256 id = sip.createSIP(address(fund), AMT, EVERY, 2, true);
        assertEq(sip.getSIP(id).status, 0);
        skip(EVERY);
        sip.executeSIP(id);
        assertEq(sip.getSIP(id).status, 3);
        assertEq(sip.activeSIPs(alice), 0);
        skip(EVERY);
        assertFalse(sip.isDue(id));
    }

    function test_ExecuteDue_Batch() public {
        vm.startPrank(alice);
        sip.createSIP(address(fund), AMT, EVERY, 0, false);
        sip.createSIP(address(fund), AMT, EVERY, 0, false);
        vm.stopPrank();
        skip(EVERY);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 0;
        ids[1] = 1;
        ids[2] = 99; // nonexistent ids are skipped
        sip.executeDue(ids);
        assertEq(sip.getSIP(0).done, 1);
        assertEq(sip.getSIP(1).done, 1);
    }

    // ------------------------------------------------------------ failures and lifecycle

    function test_ExecuteSIP_FailureRecordedAndPausesAfterThree() public {
        vm.prank(alice);
        usdc.approve(address(sip), 0); // revoke
        vm.prank(alice);
        uint256 id = sip.createSIP(address(fund), AMT, EVERY, 0, false);

        for (uint8 i = 1; i <= 3; ++i) {
            skip(EVERY);
            vm.expectEmit(true, false, false, true, address(sip));
            emit SIPFailed(id, i);
            sip.executeSIP(id);
            assertEq(sip.getSIP(id).failures, i);
            assertEq(sip.getSIP(id).done, 0);
        }
        assertEq(sip.getSIP(id).status, 1, "paused after 3 failures");
        assertEq(sip.activeSIPs(alice), 0);
    }

    function test_PauseResumeCancel_OwnerOnly() public {
        vm.prank(alice);
        uint256 id = sip.createSIP(address(fund), AMT, EVERY, 0, false);

        vm.prank(bob);
        vm.expectRevert(SIPManager.NotSIPOwner.selector);
        sip.pause(id);

        vm.startPrank(alice);
        sip.pause(id);
        assertEq(sip.getSIP(id).status, 1);
        assertEq(sip.activeSIPs(alice), 0);
        vm.expectRevert(SIPManager.InvalidStatus.selector);
        sip.pause(id);
        sip.resume(id);
        assertEq(sip.getSIP(id).status, 0);
        assertEq(sip.activeSIPs(alice), 1);
        sip.cancel(id);
        assertEq(sip.getSIP(id).status, 2);
        assertEq(sip.activeSIPs(alice), 0);
        vm.expectRevert(SIPManager.InvalidStatus.selector);
        sip.cancel(id);
        vm.stopPrank();

        skip(EVERY);
        assertFalse(sip.isDue(id));
    }

    function test_ExecuteInstallment_OnlySelf() public {
        vm.prank(alice);
        uint256 id = sip.createSIP(address(fund), AMT, EVERY, 0, false);
        vm.expectRevert(SIPManager.OnlySelf.selector);
        sip.executeInstallment(id);
    }
}

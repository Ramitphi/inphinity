// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ArcBase} from "./Base.t.sol";
import {IndexFund} from "../IndexFund.sol";

contract IndexFundLockTest is ArcBase {
    // ------------------------------------------------------------ basic lock

    function test_Lock_InvestLocksForHoldSeconds() public {
        uint256 shares = _invest(alice, fund, 1000e6);
        uint256 unlockAt = block.timestamp + exchange.holdSeconds();
        assertEq(exchange.holdSeconds(), 60);
        assertEq(fund.lockedSharesOf(alice), shares);
        assertEq(fund.unlockTime(alice), unlockAt);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IndexFund.HoldActive.selector, unlockAt));
        fund.redeem(shares, 0);

        skip(59);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IndexFund.HoldActive.selector, unlockAt));
        fund.redeem(shares, 0);

        skip(1);
        assertEq(fund.lockedSharesOf(alice), 0);
        vm.prank(alice);
        fund.redeem(shares, 0);
    }

    function test_Lock_DeadSharesNeverLockUserBalance() public {
        uint256 shares = _invest(alice, fund, 1000e6);
        assertEq(fund.lockedSharesOf(DEAD), 0);
        assertEq(fund.balanceOf(alice), shares);
    }

    function test_Lock_InKindSharesLockedForReceiver() public {
        _approveFund(alice, fund);
        vm.prank(alice);
        uint256 s = fund.investInKind(_two(), _pair(1e18, 2e18), 0, bob);
        assertEq(fund.lockedSharesOf(bob), s);
        vm.prank(bob);
        vm.expectPartialRevert(IndexFund.HoldActive.selector);
        fund.redeem(s, 0);
        skip(60);
        vm.prank(bob);
        fund.redeem(s, 0);
    }

    function test_Lock_ZeroHoldSecondsMeansNoLock() public {
        vm.prank(owner);
        exchange.setHoldSeconds(0);
        uint256 s = _invest(alice, fund, 1000e6);
        assertEq(fund.lockedSharesOf(alice), 0);
        vm.prank(alice);
        fund.redeem(s, 0);
    }

    function test_Lock_FeeSharesAreNotLocked() public {
        IndexFund f = _mkFund(_two(), _w5050(), 100);
        _invest(alice, f, 1000e6);
        skip(100 days);
        f.collectFee();
        assertGt(f.balanceOf(creator), 0);
        assertEq(f.lockedSharesOf(creator), 0);
    }

    // ------------------------------------------------------------ accumulation / expiry

    function test_Lock_ActiveLocksAccumulate() public {
        uint256 s1 = _invest(alice, fund, 1000e6);
        skip(30);
        uint256 s2 = _invest(alice, fund, 1000e6);
        assertEq(fund.lockedSharesOf(alice), s1 + s2);
        assertEq(fund.unlockTime(alice), block.timestamp + 60, "later expiry wins");
    }

    function test_Lock_ExpiredBucketIsReplacedNotRevived() public {
        uint256 s1 = _invest(alice, fund, 1000e6);
        skip(120);
        assertEq(fund.lockedSharesOf(alice), 0);
        uint256 s2 = _invest(alice, fund, 1000e6);
        assertEq(fund.lockedSharesOf(alice), s2, "only new shares locked");
        // free shares s1 redeemable
        vm.prank(alice);
        fund.redeem(s1, 0);
        // but not more than free
        vm.prank(alice);
        vm.expectPartialRevert(IndexFund.HoldActive.selector);
        fund.redeem(1, 0);
    }

    function test_Lock_FreeSharesRedeemableWhileNewSharesLocked() public {
        uint256 s1 = _invest(alice, fund, 1000e6);
        skip(60);
        uint256 s2 = _invest(alice, fund, 1000e6);
        assertEq(fund.lockedSharesOf(alice), s2);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IndexFund.HoldActive.selector, fund.unlockTime(alice)));
        fund.redeem(s1 + 1, 0);
        fund.redeem(s1, 0);
        vm.stopPrank();
        assertEq(fund.balanceOf(alice), s2);
    }

    // ------------------------------------------------------------ griefing resistance

    function test_Lock_DustTransferOfLockedSharesDoesNotLockFreeShares() public {
        uint256 sA = _invest(alice, fund, 1000e6);
        skip(60); // alice's shares are free
        uint256 sB = _invest(bob, fund, 1000e6); // bob's are locked

        vm.prank(bob);
        fund.transfer(alice, 1); // dust of locked shares

        assertEq(fund.balanceOf(alice), sA + 1);
        assertEq(fund.lockedSharesOf(alice), 1, "only the dust is locked");
        assertEq(fund.lockedSharesOf(bob), sB - 1);

        vm.prank(alice);
        fund.redeem(sA, 0); // free shares still redeemable
        assertEq(fund.balanceOf(alice), 1);
    }

    function test_Lock_DustCannotRedeemBeyondFree() public {
        uint256 sA = _invest(alice, fund, 1000e6);
        skip(60);
        _invest(bob, fund, 1000e6);
        vm.prank(bob);
        fund.transfer(alice, 1);
        vm.prank(alice);
        vm.expectPartialRevert(IndexFund.HoldActive.selector);
        fund.redeem(sA + 1, 0);
    }

    function test_Lock_UnsolicitedInvestInKindFromStrangerOnlyLocksNewShares() public {
        uint256 sA = _invest(alice, fund, 1000e6);
        skip(60);
        assertEq(fund.lockedSharesOf(alice), 0);

        _approveFund(bob, fund);
        vm.prank(bob);
        uint256 gift = fund.investInKind(_two(), _pair(1e18, 2e18), 0, alice);

        assertEq(fund.balanceOf(alice), sA + gift);
        assertEq(fund.lockedSharesOf(alice), gift, "only the new shares are locked");

        vm.prank(alice);
        fund.redeem(sA, 0);
        assertEq(fund.balanceOf(alice), gift);
        vm.prank(alice);
        vm.expectPartialRevert(IndexFund.HoldActive.selector);
        fund.redeem(1, 0);
    }

    // ------------------------------------------------------------ transfer semantics

    function test_Lock_TransferOfLockedSharesMovesLockToRecipient() public {
        uint256 s = _invest(alice, fund, 1000e6);
        uint256 until = fund.unlockTime(alice);

        vm.prank(alice);
        fund.transfer(bob, s);

        assertEq(fund.lockedSharesOf(bob), s);
        assertEq(fund.unlockTime(bob), until);
        assertEq(fund.lockedSharesOf(alice), 0);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IndexFund.HoldActive.selector, until));
        fund.redeem(s, 0);
        skip(60);
        vm.prank(bob);
        fund.redeem(s, 0);
    }

    function test_Lock_PartialTransferSpendsFreeSharesFirst() public {
        uint256 s1 = _invest(alice, fund, 1000e6);
        skip(60);
        uint256 s2 = _invest(alice, fund, 1000e6); // s1 free, s2 locked

        vm.prank(alice);
        fund.transfer(bob, s1); // consumes only free shares
        assertEq(fund.lockedSharesOf(alice), s2);
        assertEq(fund.lockedSharesOf(bob), 0);

        // give alice free shares back and move free + 10 locked
        vm.prank(bob);
        fund.transfer(alice, s1);
        vm.prank(alice);
        fund.transfer(bob, s1 + 10);
        assertEq(fund.lockedSharesOf(bob), 10);
        assertEq(fund.lockedSharesOf(alice), s2 - 10);
        assertEq(fund.balanceOf(alice), s2 - 10);
        assertEq(fund.unlockTime(bob), fund.unlockTime(alice));
    }

    function test_Lock_TransferExpiresWithTime() public {
        uint256 s = _invest(alice, fund, 1000e6);
        vm.prank(alice);
        fund.transfer(bob, s);
        skip(60);
        assertEq(fund.lockedSharesOf(bob), 0);
    }

    // ------------------------------------------------------------ unregistered-venue free path sanity

    function test_Lock_RedeemBurnsOnlyFreeShares_LockedRemainLocked() public {
        uint256 s1 = _invest(alice, fund, 1000e6);
        skip(60);
        uint256 s2 = _invest(alice, fund, 1000e6);
        vm.prank(alice);
        fund.redeem(s1 / 2, 0);
        assertEq(fund.lockedSharesOf(alice), s2);
        assertEq(fund.balanceOf(alice), s1 - s1 / 2 + s2);
    }
}

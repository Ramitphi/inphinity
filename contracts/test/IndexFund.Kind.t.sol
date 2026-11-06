// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcBase} from "./Base.t.sol";
import {IndexFund} from "../IndexFund.sol";

contract IndexFundKindTest is ArcBase {
    event InvestedInKind(
        address indexed investor, address indexed receiver, address[] tokens, uint256[] amounts, uint256 shares
    );

    function _arr1(uint256 a) internal pure returns (uint256[] memory x) {
        x = new uint256[](1);
        x[0] = a;
    }

    function _tok1(address t) internal pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = t;
    }

    // ------------------------------------------------------------ happy paths

    function test_InvestInKind_FirstDeposit_DeadLockAndMidPrice() public {
        _approveFund(alice, fund);
        uint256 supplyA = aapl.totalSupply();
        uint256[] memory amts = _pair(1e18, 2e18); // 200 + 200 = 400 USDC at mid
        uint256 expected = 400e6 * 1e12 - 1000;
        address[] memory toks = _two();

        vm.expectEmit(true, true, false, true, address(fund));
        emit InvestedInKind(alice, alice, toks, amts, expected);
        vm.prank(alice);
        uint256 shares = fund.investInKind(toks, amts, expected, alice);

        assertEq(shares, expected);
        assertEq(fund.balanceOf(alice), expected);
        assertEq(fund.balanceOf(DEAD), 1000, "1000 shares locked to DEAD");
        assertEq(fund.totalSupply(), 400e6 * 1e12);
        assertEq(fund.nav(), 400e6);
        assertEq(aapl.balanceOf(address(fund)), 1e18);
        assertEq(tsla.balanceOf(address(fund)), 2e18);
        assertEq(aapl.balanceOf(alice), 99e18);
        assertEq(aapl.totalSupply(), supplyA, "no minting");
        assertEq(fund.lockedSharesOf(alice), expected);
    }

    function test_InvestInKind_SecondDepositorGetsProportionalShares() public {
        uint256 s1 = _kind(alice, fund, _two(), _pair(1e18, 2e18), alice);
        uint256 supply = fund.totalSupply();
        // bob deposits half the value (200 USDC) -> half the supply
        uint256 s2 = _kind(bob, fund, _two(), _pair(0.5e18, 1e18), bob);
        assertEq(s2, supply / 2);
        assertEq(fund.balanceOf(bob), s2);
        assertEq(s1 + 1000, supply);
        // equal deposit -> shares equal to the pre-deposit total supply
        uint256 supply2 = fund.totalSupply();
        uint256 s3 = _kind(carol, fund, _two(), _pair(1.5e18, 3e18), carol);
        assertEq(s3, supply2);
    }

    function test_InvestInKind_ThreeConstituents() public {
        IndexFund f3 = _mkFund(_three(), _w433(), 0);
        address[] memory toks = _three();
        uint256[] memory amts = new uint256[](3);
        amts[0] = 1e18; // 200
        amts[1] = 2e18; // 200
        amts[2] = 4e18; // 200
        uint256 s1 = _kind(alice, f3, toks, amts, alice);
        assertEq(s1, 600e6 * 1e12 - 1000);
        assertEq(f3.nav(), 600e6);

        uint256 supply = f3.totalSupply();
        uint256 s2 = _kind(bob, f3, toks, amts, bob);
        assertEq(s2, supply, "equal-value second deposit doubles supply");
        assertEq(f3.totalSupply(), supply * 2);
        assertEq(f3.nav(), 1200e6);
    }

    function test_InvestInKind_SubsetOfConstituentsUsesPreDepositNav() public {
        _kind(alice, fund, _two(), _pair(1e18, 2e18), alice);
        uint256 supply = fund.totalSupply();
        uint256 assets = fund.nav();
        uint256 s = _kind(bob, fund, _tok1(address(aapl)), _arr1(1e18), bob); // 200 USDC
        assertEq(s, Math.mulDiv(200e6, supply, assets));
    }

    function test_InvestInKind_ReceiverDifferentFromSender() public {
        _approveFund(alice, fund);
        uint256 aliceAapl = aapl.balanceOf(alice);
        vm.prank(alice);
        uint256 shares = fund.investInKind(_two(), _pair(1e18, 2e18), 0, carol);

        assertEq(fund.balanceOf(alice), 0);
        assertEq(fund.balanceOf(carol), shares);
        assertEq(aapl.balanceOf(alice), aliceAapl - 1e18, "stocks pulled from msg.sender");
        assertEq(fund.lockedSharesOf(carol), shares, "lock applies to receiver");
        assertEq(fund.lockedSharesOf(alice), 0);
    }

    function test_InvestInKind_MatchesRedeemValue() public {
        uint256 s = _kind(alice, fund, _two(), _pair(1e18, 2e18), alice);
        skip(60);
        uint256 preview = fund.previewRedeem(s);
        vm.prank(alice);
        uint256 out = fund.redeem(s, 0);
        assertEq(out, preview);
        assertLt(out, 400e6, "sell spread");
        assertGt(out, 390e6);
    }

    // ------------------------------------------------------------ reverts

    function test_InvestInKind_SlippageReverts() public {
        _approveFund(alice, fund);
        uint256 exact = 400e6 * 1e12 - 1000;
        vm.prank(alice);
        vm.expectRevert(IndexFund.SlippageExceeded.selector);
        fund.investInKind(_two(), _pair(1e18, 2e18), exact + 1, alice);
    }

    function test_InvestInKind_NotConstituent() public {
        _approveFund(alice, fund);
        address[] memory t = new address[](2);
        t[0] = address(aapl);
        t[1] = address(msft); // listed on the venue but not in this fund
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IndexFund.NotConstituent.selector, address(msft)));
        fund.investInKind(t, _pair(1e18, 1e18), 0, alice);
    }

    function test_InvestInKind_DuplicateToken() public {
        _approveFund(alice, fund);
        address[] memory t = new address[](2);
        t[0] = address(aapl);
        t[1] = address(aapl);
        vm.prank(alice);
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.investInKind(t, _pair(1e18, 1e18), 0, alice);
    }

    function test_InvestInKind_ZeroAmount() public {
        _approveFund(alice, fund);
        vm.prank(alice);
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.investInKind(_two(), _pair(1e18, 0), 0, alice);
    }

    function test_InvestInKind_ZeroOrDeadReceiver() public {
        _approveFund(alice, fund);
        vm.startPrank(alice);
        vm.expectRevert(IndexFund.InvalidConfiguration.selector);
        fund.investInKind(_two(), _pair(1e18, 1e18), 0, address(0));
        vm.expectRevert(IndexFund.InvalidConfiguration.selector);
        fund.investInKind(_two(), _pair(1e18, 1e18), 0, DEAD);
        vm.stopPrank();
    }

    function test_InvestInKind_ArrayMismatchAndEmptyAndTooMany() public {
        _approveFund(alice, fund);
        vm.startPrank(alice);
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.investInKind(_two(), _arr1(1e18), 0, alice); // mismatch
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.investInKind(new address[](0), new uint256[](0), 0, alice); // empty
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.investInKind(_three(), new uint256[](3), 0, alice); // more tokens than the basket
        vm.stopPrank();
    }

    function test_InvestInKind_ValueBelowOneUsdc() public {
        _approveFund(alice, fund);
        vm.startPrank(alice);
        // 1e12 wei AAPL = 200 base units of USDC
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.investInKind(_tok1(address(aapl)), _arr1(1e12), 0, alice);
        // one wei short of 1 USDC (5e15 * 200e6 / 1e18 = 1e6)
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.investInKind(_tok1(address(aapl)), _arr1(5e15 - 1), 0, alice);
        // exactly 1 USDC works
        uint256 s = fund.investInKind(_tok1(address(aapl)), _arr1(5e15), 0, alice);
        assertEq(s, 1e6 * 1e12 - 1000);
        vm.stopPrank();
    }

    function test_InvestInKind_NeedsApprovalAndStalePriceReverts() public {
        vm.prank(alice); // not approved
        vm.expectRevert();
        fund.investInKind(_two(), _pair(1e18, 1e18), 0, alice);

        _approveFund(alice, fund);
        skip(96 hours + 1);
        vm.prank(alice);
        vm.expectRevert();
        fund.investInKind(_two(), _pair(1e18, 1e18), 0, alice);
    }

    // ------------------------------------------------------------ fee before NAV snapshot

    function test_InvestInKind_FeeAccruesBeforeNavSnapshot() public {
        IndexFund f = _mkFund(_two(), _w5050(), 100);
        _kind(alice, f, _two(), _pair(1e18, 2e18), alice);
        uint256 supply = f.totalSupply();
        assertEq(f.lastFeeAccrual(), block.timestamp);

        skip(30 days);
        _refreshPrices();
        uint256 feeShares = Math.mulDiv(supply, 100 * 30 days, 10000 * 365 days - 100 * 30 days);
        assertGt(feeShares, 0);

        uint256 s2 = _kind(bob, f, _two(), _pair(1e18, 2e18), bob);

        assertEq(f.balanceOf(creator), feeShares, "creator received dilution shares");
        // equal-value deposit against NAV 400 with supply+fee outstanding
        assertEq(s2, supply + feeShares, "snapshot supply already includes fee shares");
        assertEq(f.totalSupply(), 2 * supply + 2 * feeShares);
        assertEq(f.lastFeeAccrual(), block.timestamp);
    }
}

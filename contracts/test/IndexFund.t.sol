// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ArcBase} from "./Base.t.sol";
import {IndexFund} from "../IndexFund.sol";
import {StockExchange} from "../StockExchange.sol";

contract IndexFundTest is ArcBase {
    event Invested(address indexed investor, uint256 usdcIn, uint256 shares);
    event Redeemed(address indexed investor, uint256 shares, uint256 usdcOut);
    event FeeAccrued(address indexed creator, uint256 shares, uint256 timestamp);

    /// @dev mid value of a 50/50 AAPL/TSLA purchase of `usdcIn` through the venue (per-holding rounding)
    function _expectedValue(uint256 usdcIn) internal view returns (uint256 value, uint256 a, uint256 t) {
        uint256 alloc = usdcIn / 2;
        a = exchange.quoteBuy(address(aapl), alloc);
        t = exchange.quoteBuy(address(tsla), usdcIn - alloc);
        value = (a * AAPL_PX) / 1e18 + (t * TSLA_PX) / 1e18;
    }

    /// @dev Mirrors the fund's NAV delta (per-holding rounding) for a 50/50 purchase of `usdcIn`.
    function _delta(IndexFund f, uint256 usdcIn) internal view returns (uint256 v) {
        uint256 alloc = usdcIn / 2;
        uint256 a = exchange.quoteBuy(address(aapl), alloc);
        uint256 t = exchange.quoteBuy(address(tsla), usdcIn - alloc);
        uint256 ba = aapl.balanceOf(address(f));
        uint256 bt = tsla.balanceOf(address(f));
        v = Math.mulDiv(ba + a, AAPL_PX, 1e18) - Math.mulDiv(ba, AAPL_PX, 1e18)
            + Math.mulDiv(bt + t, TSLA_PX, 1e18) - Math.mulDiv(bt, TSLA_PX, 1e18);
    }

    // ------------------------------------------------------------ deployment

    function test_Deploy_State() public view {
        assertEq(fund.venue(), address(exchange));
        assertEq(fund.usdc(), address(usdc));
        assertEq(fund.creator(), creator);
        assertEq(fund.feeBps(), 0);
        assertEq(fund.getTokens().length, 2);
        assertEq(fund.getWeights()[0], 5000);
        assertEq(fund.totalSupply(), 0);
        assertEq(fund.navPerShare(), 1e6);
        assertEq(fund.decimals(), 18);
    }

    function test_Deploy_InvalidConfigReverts() public {
        address[] memory t = _two();
        uint16[] memory w = _w5050();
        // creator == DEAD
        vm.expectRevert(IndexFund.InvalidConfiguration.selector);
        new IndexFund("n", "s", address(exchange), address(usdc), DEAD, t, w, 0);
        // fee above 2%
        vm.expectRevert(IndexFund.InvalidConfiguration.selector);
        new IndexFund("n", "s", address(exchange), address(usdc), creator, t, w, 201);
        // venue/usdc mismatch
        vm.expectRevert(IndexFund.InvalidConfiguration.selector);
        new IndexFund("n", "s", address(exchange), address(aapl), creator, t, w, 0);
        // unlisted token
        t[1] = address(new MockUnlisted());
        vm.expectRevert(IndexFund.InvalidConfiguration.selector);
        new IndexFund("n", "s", address(exchange), address(usdc), creator, t, w, 0);
    }

    // ------------------------------------------------------------ invest

    function test_Invest_FirstDepositLocksDeadShares() public {
        (uint256 value, uint256 a, uint256 t) = _expectedValue(1000e6);
        uint256 expectedShares = value * 1e12 - 1000;
        _approveFund(alice, fund);
        uint256 aaplSupply = aapl.totalSupply();
        uint256 tslaSupply = tsla.totalSupply();
        uint256 aliceUsdc = usdc.balanceOf(alice);

        vm.expectEmit(true, false, false, true, address(fund));
        emit Invested(alice, 1000e6, expectedShares);
        vm.prank(alice);
        uint256 shares = fund.invest(1000e6, expectedShares);

        assertEq(shares, expectedShares);
        assertEq(fund.balanceOf(alice), expectedShares);
        assertEq(fund.balanceOf(DEAD), 1000);
        assertEq(fund.totalSupply(), expectedShares + 1000);
        assertEq(aapl.balanceOf(address(fund)), a);
        assertEq(tsla.balanceOf(address(fund)), t);
        assertEq(fund.idleUsdc(), 0);
        assertEq(fund.nav(), value);
        assertLt(value, 1000e6, "investor pays the execution spread");
        assertEq(usdc.balanceOf(alice), aliceUsdc - 1000e6);
        assertEq(aapl.totalSupply(), aaplSupply, "stocks come from venue inventory");
        assertEq(tsla.totalSupply(), tslaSupply);
        assertEq(aapl.allowance(address(fund), address(exchange)), 0);
        assertEq(usdc.allowance(address(fund), address(exchange)), 0);
    }

    function test_Invest_DeadSharesCannotMove() public {
        _invest(alice, fund, 1000e6);
        vm.prank(DEAD);
        vm.expectRevert(IndexFund.LockedShares.selector);
        fund.transfer(alice, 1);
        assertEq(fund.balanceOf(DEAD), 1000);
    }

    function test_Invest_SecondDepositorProportional() public {
        uint256 s1 = _invest(alice, fund, 1000e6);
        uint256 supply = fund.totalSupply();
        uint256 assets = fund.nav();
        uint256 value = _delta(fund, 1000e6);
        assertEq(fund.previewInvest(1000e6), Math.mulDiv(value, supply, assets));

        uint256 s2 = _invest(bob, fund, 1000e6);
        assertEq(s2, Math.mulDiv(value, supply, assets));
        // same prices -> same value (+-1 wei rounding) -> bob owns ~ the existing supply (incl. dead)
        assertApproxEqRel(s2, s1 + 1000, 1e10);
        assertEq(fund.balanceOf(DEAD), 1000, "dead shares minted only once");
    }

    function test_Invest_PreviewMatchesExecution() public {
        uint256 preview = fund.previewInvest(777e6);
        assertEq(_invest(alice, fund, 777e6), preview);
        uint256 preview2 = fund.previewInvest(333e6);
        assertEq(_invest(bob, fund, 333e6), preview2);
    }

    function test_Invest_Reverts() public {
        _approveFund(alice, fund);
        vm.startPrank(alice);
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.invest(1e6 - 1, 0);
        vm.expectRevert(IndexFund.SlippageExceeded.selector);
        fund.invest(1000e6, type(uint256).max);
        vm.stopPrank();
        vm.prank(carol); // no approval
        vm.expectRevert();
        fund.invest(1000e6, 0);
    }

    function test_Invest_RevertsOnStalePrice() public {
        skip(96 hours + 1);
        _approveFund(alice, fund);
        vm.prank(alice);
        vm.expectRevert();
        fund.invest(1000e6, 0);
    }

    // ------------------------------------------------------------ redeem

    function test_Redeem_SellsBackToVenueAndPaysUsdc() public {
        uint256 shares = _invest(alice, fund, 1000e6);
        skip(60);
        uint256 preview = fund.previewRedeem(shares);
        uint256 aliceUsdc = usdc.balanceOf(alice);
        uint256 invAapl = exchange.inventoryOf(address(aapl));
        uint256 fundAapl = aapl.balanceOf(address(fund));
        uint256 supplyBefore = fund.totalSupply();

        vm.expectEmit(true, false, false, true, address(fund));
        emit Redeemed(alice, shares, preview);
        vm.prank(alice);
        uint256 out = fund.redeem(shares, preview);

        assertEq(out, preview);
        assertEq(usdc.balanceOf(alice), aliceUsdc + out);
        assertEq(fund.balanceOf(alice), 0);
        assertEq(fund.totalSupply(), supplyBefore - shares);
        assertLt(out, 1000e6, "round trip pays both spreads");
        assertGt(out, 980e6);
        // stock went back into venue inventory (fund keeps only dead-share dust)
        assertGt(exchange.inventoryOf(address(aapl)), invAapl);
        assertLt(aapl.balanceOf(address(fund)), fundAapl);
        // fund's approval to the venue is cleaned up
        assertEq(aapl.allowance(address(fund), address(exchange)), 0);
        assertEq(tsla.allowance(address(fund), address(exchange)), 0);
        assertEq(fund.idleUsdc(), 0);
    }

    function test_Redeem_PartialRedeem() public {
        uint256 shares = _invest(alice, fund, 1000e6);
        skip(60);
        vm.prank(alice);
        uint256 out = fund.redeem(shares / 2, 0);
        assertGt(out, 0);
        assertEq(fund.balanceOf(alice), shares - shares / 2);
    }

    function test_Redeem_Reverts() public {
        uint256 shares = _invest(alice, fund, 1000e6);
        skip(60);
        vm.startPrank(alice);
        vm.expectRevert(IndexFund.InvalidAmount.selector);
        fund.redeem(0, 0);
        vm.expectRevert(abi.encodeWithSelector(IndexFund.HoldActive.selector, fund.unlockTime(alice)));
        fund.redeem(shares + 1, 0);
        vm.expectRevert(IndexFund.SlippageExceeded.selector);
        fund.redeem(shares, type(uint256).max);
        vm.stopPrank();
        vm.prank(bob); // no shares
        vm.expectRevert();
        fund.redeem(1, 0);
    }

    function test_Redeem_VenueReserveShortfallReverts() public {
        uint256 shares = _invest(alice, fund, 1000e6);
        skip(60);
        uint256 reserve = exchange.reserveBalance();
        vm.prank(owner);
        exchange.withdrawReserve(reserve, owner);
        vm.prank(alice);
        vm.expectRevert();
        fund.redeem(shares, 0);
    }

    // ------------------------------------------------------------ registered vs unregistered fund

    function test_Redeem_UnregisteredFundHitsVenueHold_RegisteredDoesNot() public {
        // Unregistered fund deployed directly (not via the factory).
        IndexFund raw = new IndexFund("Raw", "RAW", address(exchange), address(usdc), creator, _two(), _w5050(), 0);
        assertFalse(exchange.registeredFunds(address(raw)));
        assertTrue(exchange.registeredFunds(address(fund)));

        uint256 rawShares = _invest(alice, raw, 1000e6);
        uint256 regShares = _invest(alice, fund, 1000e6);
        skip(60);
        // A second buyer touches the unregistered fund, restarting the venue hold on the fund address.
        _invest(bob, raw, 1000e6);
        _invest(bob, fund, 1000e6);

        vm.prank(alice);
        vm.expectRevert(); // StockExchange.HoldActive bubbled from venue.sell
        raw.redeem(rawShares, 0);

        vm.prank(alice);
        uint256 out = fund.redeem(regShares, 0); // registered fund is exempt
        assertGt(out, 0);

        skip(60);
        vm.prank(alice);
        raw.redeem(rawShares, 0); // venue hold elapsed
    }

    function test_Redeem_UnregisteredFundVenueHoldRevertSelector() public {
        IndexFund raw = new IndexFund("Raw", "RAW", address(exchange), address(usdc), creator, _two(), _w5050(), 0);
        uint256 rawShares = _invest(alice, raw, 1000e6);
        skip(60);
        _invest(bob, raw, 1000e6);
        uint256 unlockAt = block.timestamp + 60;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.HoldActive.selector, unlockAt));
        raw.redeem(rawShares, 0);
    }

    // ------------------------------------------------------------ fees

    function test_Fee_AccruesAsCreatorDilutionShares() public {
        IndexFund f = _mkFund(_two(), _w5050(), 100); // 1%/yr
        _invest(alice, f, 1000e6);
        uint256 supply = f.totalSupply();
        assertEq(f.balanceOf(creator), 0);

        skip(365 days);
        uint256 expected = Math.mulDiv(supply, 100 * 365 days, 10000 * 365 days - 100 * 365 days);
        assertEq(expected, supply / 99);
        vm.expectEmit(true, false, false, true, address(f));
        emit FeeAccrued(creator, expected, block.timestamp);
        f.collectFee(); // permissionless
        assertEq(f.balanceOf(creator), expected);
        assertEq(f.totalSupply(), supply + expected);

        // immediately again: nothing more accrues
        f.collectFee();
        assertEq(f.balanceOf(creator), expected);
    }

    function test_Fee_ZeroFeeFundMintsNothing() public {
        _invest(alice, fund, 1000e6);
        skip(365 days);
        uint256 supply = fund.totalSupply();
        fund.collectFee();
        assertEq(fund.totalSupply(), supply);
        assertEq(fund.balanceOf(creator), 0);
    }

    function test_Fee_AccruedBeforeNavSnapshotOnInvest() public {
        IndexFund f = _mkFund(_two(), _w5050(), 100);
        _invest(alice, f, 1000e6);
        skip(30 days);
        _refreshPrices();
        uint256 supply = f.totalSupply();
        uint256 assets = f.nav();
        uint256 el = 30 days;
        uint256 feeShares = Math.mulDiv(supply, 100 * el, 10000 * 365 days - 100 * el);
        uint256 value = _delta(f, 1000e6);

        uint256 preview = f.previewInvest(1000e6);
        uint256 s2 = _invest(bob, f, 1000e6);

        assertEq(f.balanceOf(creator), feeShares, "fee minted during invest");
        assertEq(s2, Math.mulDiv(value, supply + feeShares, assets), "NAV snapshot includes fee dilution");
        assertEq(s2, preview);
    }

    function test_Fee_PeriodTooLongReverts() public {
        IndexFund f = _mkFund(_two(), _w5050(), 200);
        _invest(alice, f, 1000e6);
        skip(50 * 365 days);
        vm.expectRevert(IndexFund.FeePeriodTooLong.selector);
        f.collectFee();
    }

    function test_Fee_RedeemAccruesFeeFirst() public {
        IndexFund f = _mkFund(_two(), _w5050(), 100);
        uint256 shares = _invest(alice, f, 1000e6);
        skip(30 days);
        _refreshPrices();
        vm.prank(alice);
        f.redeem(shares, 0);
        assertGt(f.balanceOf(creator), 0);
    }

    // ------------------------------------------------------------ views

    function test_Views_HoldingsAndNav() public {
        _invest(alice, fund, 1000e6);
        (address[] memory t, uint256[] memory bal, uint16[] memory w) = fund.holdings();
        assertEq(t.length, 2);
        assertEq(bal[0], aapl.balanceOf(address(fund)));
        assertEq(w[1], 5000);
        assertEq(fund.navPerShare(), Math.mulDiv(fund.nav(), 1e18, fund.totalSupply()));
        // idle USDC donated to the fund counts in NAV
        uint256 navBefore = fund.nav();
        usdc.mint(address(fund), 5e6);
        assertEq(fund.nav(), navBefore + 5e6);
    }
}

contract MockUnlisted {
    function decimals() external pure returns (uint8) { return 18; }
}

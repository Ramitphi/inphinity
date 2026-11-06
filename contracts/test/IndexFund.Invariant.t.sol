// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ArcBase} from "./Base.t.sol";
import {IndexFund} from "../IndexFund.sol";

/// @dev Bounded action surface for the invariant fuzzer.
contract FundHandler is Test {
    IndexFund public fund;
    address[3] public actors;

    constructor(IndexFund fund_, address[3] memory actors_) {
        fund = fund_;
        actors = actors_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function invest(uint256 seed, uint256 amount, uint256 dt) external {
        skip(bound(dt, 0, 120));
        address a = _actor(seed);
        amount = bound(amount, 1e6, 20_000e6);
        vm.prank(a);
        fund.invest(amount, 0);
    }

    function redeem(uint256 seed, uint256 shares, uint256 dt) external {
        skip(bound(dt, 0, 120));
        address a = _actor(seed);
        uint256 free = fund.balanceOf(a) - fund.lockedSharesOf(a);
        if (free == 0) return;
        shares = bound(shares, 1, free);
        vm.prank(a);
        fund.redeem(shares, 0);
    }

    function transferShares(uint256 seed, uint256 to, uint256 amount) external {
        address a = _actor(seed);
        uint256 bal = fund.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        fund.transfer(_actor(to), amount);
    }
}

contract IndexFundInvariantTest is ArcBase {
    FundHandler internal handler;
    address[3] internal actors;
    uint256 internal aaplSupply;
    uint256 internal tslaSupply;
    uint256 internal usdcSupply;

    function setUp() public override {
        super.setUp();
        actors = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) _approveFund(actors[i], fund);
        handler = new FundHandler(fund, actors);
        aaplSupply = aapl.totalSupply();
        tslaSupply = tsla.totalSupply();
        usdcSupply = usdc.totalSupply();
        targetContract(address(handler));
        // handler acts as msg.sender via vm.prank on actors
    }

    /// shares are conserved: supply == sum of known holders (actors + DEAD + creator)
    function invariant_SupplyEqualsSumOfBalances() public view {
        uint256 sum = fund.balanceOf(DEAD) + fund.balanceOf(creator);
        for (uint256 i; i < 3; ++i) sum += fund.balanceOf(actors[i]);
        assertEq(fund.totalSupply(), sum);
    }

    /// stock and USDC are only moved, never minted/burned by the venue or fund
    function invariant_TokenSupplyConserved() public view {
        assertEq(aapl.totalSupply(), aaplSupply);
        assertEq(tsla.totalSupply(), tslaSupply);
        assertEq(usdc.totalSupply(), usdcSupply);
        uint256 aaplSum = aapl.balanceOf(address(exchange)) + aapl.balanceOf(address(fund));
        uint256 tslaSum = tsla.balanceOf(address(exchange)) + tsla.balanceOf(address(fund));
        for (uint256 i; i < 3; ++i) {
            aaplSum += aapl.balanceOf(actors[i]);
            tslaSum += tsla.balanceOf(actors[i]);
        }
        aaplSum += aapl.balanceOf(creator) + aapl.balanceOf(owner);
        tslaSum += tsla.balanceOf(creator) + tsla.balanceOf(owner);
        assertEq(aaplSum, aaplSupply);
        assertEq(tslaSum, tslaSupply);
    }

    /// dead shares are permanent once minted
    function invariant_DeadSharesPermanent() public view {
        if (fund.totalSupply() != 0) assertEq(fund.balanceOf(DEAD), 1000);
    }

    /// the fund never keeps idle USDC or dangling venue approvals after any action
    function invariant_NoDanglingApprovalsOrIdleUsdc() public view {
        assertEq(fund.idleUsdc(), 0);
        assertEq(aapl.allowance(address(fund), address(exchange)), 0);
        assertEq(tsla.allowance(address(fund), address(exchange)), 0);
        assertEq(usdc.allowance(address(fund), address(exchange)), 0);
    }

    /// no locked quantity can ever exceed the holder's balance as reported
    function invariant_LockedNeverExceedsBalance() public view {
        for (uint256 i; i < 3; ++i) {
            assertLe(fund.lockedSharesOf(actors[i]), fund.balanceOf(actors[i]));
        }
    }
}

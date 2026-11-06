// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcBase} from "./Base.t.sol";
import {StockExchange} from "../StockExchange.sol";

contract StockExchangeTradingTest is ArcBase {
    event Bought(address indexed buyer, address indexed token, uint256 usdcIn, uint256 tokensOut);
    event Sold(address indexed seller, address indexed token, uint256 tokensIn, uint256 usdcOut);
    event InventoryWithdrawn(address indexed token, uint256 amount, address indexed to);
    event ReserveWithdrawn(uint256 amount, address indexed to);
    event FundRegistered(address indexed fund);

    function setUp() public override {
        super.setUp();
        _approveExchange(alice);
        _approveExchange(bob);
    }

    // ------------------------------------------------------------ prices

    function test_SpreadPrices() public view {
        assertEq(exchange.midPrice(address(aapl)), 200e6);
        assertEq(exchange.buyPrice(address(aapl)), 201e6); // +0.5%
        assertEq(exchange.sellPrice(address(aapl)), 199e6); // -0.5%
        assertEq(exchange.quoteBuy(address(aapl), 201e6), 1e18);
        assertEq(exchange.quoteSell(address(aapl), 1e18), 199e6);
    }

    // ------------------------------------------------------------ buy

    function test_Buy_FromInventoryAtBuyPrice() public {
        uint256 supplyBefore = aapl.totalSupply();
        uint256 invBefore = exchange.inventoryOf(address(aapl));
        uint256 expected = uint256(1000e6) * 1e18 / 201e6;
        uint256 aliceUsdc = usdc.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(exchange));
        emit Bought(alice, address(aapl), 1000e6, expected);
        vm.prank(alice);
        uint256 out = exchange.buy(address(aapl), 1000e6, expected);

        assertEq(out, expected);
        assertEq(aapl.balanceOf(alice), 100e18 + expected);
        assertEq(usdc.balanceOf(alice), aliceUsdc - 1000e6);
        assertEq(exchange.inventoryOf(address(aapl)), invBefore - expected);
        assertEq(usdc.balanceOf(address(exchange)), RESERVE + 1000e6);
        assertEq(exchange.reserveBalance(), RESERVE + 1000e6);
        assertEq(aapl.totalSupply(), supplyBefore, "stock must come from inventory, not minted");
        assertEq(exchange.lastBuyTime(alice, address(aapl)), block.timestamp);
    }

    function test_Buy_InsufficientInventory() public {
        uint256 usdcIn = 300_000e6;
        uint256 required = exchange.quoteBuy(address(aapl), usdcIn);
        assertGt(required, INVENTORY);
        usdc.mint(alice, usdcIn);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.InsufficientInventory.selector, INVENTORY, required));
        exchange.buy(address(aapl), usdcIn, 0);
    }

    function test_Buy_SlippageReverts() public {
        uint256 q = exchange.quoteBuy(address(aapl), 1000e6);
        vm.prank(alice);
        vm.expectRevert(StockExchange.SlippageExceeded.selector);
        exchange.buy(address(aapl), 1000e6, q + 1);
    }

    function test_Buy_ZeroAmountAndUnlisted() public {
        vm.startPrank(alice);
        vm.expectRevert(StockExchange.InvalidAmount.selector);
        exchange.buy(address(aapl), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.UnlistedStock.selector, address(usdc)));
        exchange.buy(address(usdc), 1e6, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ sell

    function test_Sell_PullsStockAndPaysUsdcAtSellPrice() public {
        uint256 invBefore = exchange.inventoryOf(address(aapl));
        uint256 bobUsdc = usdc.balanceOf(bob);
        uint256 supplyBefore = aapl.totalSupply();

        vm.expectEmit(true, true, false, true, address(exchange));
        emit Sold(bob, address(aapl), 10e18, 1990e6);
        vm.prank(bob);
        uint256 out = exchange.sell(address(aapl), 10e18, 1990e6);

        assertEq(out, 1990e6);
        assertEq(usdc.balanceOf(bob), bobUsdc + 1990e6);
        assertEq(aapl.balanceOf(bob), 90e18);
        assertEq(exchange.inventoryOf(address(aapl)), invBefore + 10e18);
        assertEq(exchange.reserveBalance(), RESERVE - 1990e6);
        assertEq(aapl.totalSupply(), supplyBefore);
    }

    function test_Sell_RequiresApproval() public {
        vm.prank(carol); // never approved
        vm.expectRevert();
        exchange.sell(address(aapl), 1e18, 0);
    }

    function test_Sell_SlippageAndZero() public {
        vm.startPrank(bob);
        vm.expectRevert(StockExchange.SlippageExceeded.selector);
        exchange.sell(address(aapl), 1e18, 199e6 + 1);
        vm.expectRevert(StockExchange.InvalidAmount.selector);
        exchange.sell(address(aapl), 0, 0);
        vm.stopPrank();
    }

    function test_Sell_InsufficientReserve() public {
        vm.prank(owner);
        exchange.withdrawReserve(RESERVE - 100e6, owner);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.InsufficientReserve.selector, 100e6, 1990e6));
        exchange.sell(address(aapl), 10e18, 0);
    }

    // ------------------------------------------------------------ hold period

    function test_Sell_HoldActiveThenSucceedsAfterWarp() public {
        assertEq(exchange.holdSeconds(), 60);
        vm.prank(alice);
        exchange.buy(address(aapl), 1000e6, 0);
        uint256 unlockAt = block.timestamp + 60;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.HoldActive.selector, unlockAt));
        exchange.sell(address(aapl), 1e18, 0);

        skip(59);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.HoldActive.selector, unlockAt));
        exchange.sell(address(aapl), 1e18, 0);

        skip(1);
        vm.prank(alice);
        exchange.sell(address(aapl), 1e18, 0);
    }

    function test_Sell_HoldIsPerToken() public {
        vm.prank(alice);
        exchange.buy(address(aapl), 1000e6, 0);
        vm.prank(alice);
        exchange.sell(address(tsla), 1e18, 0); // never bought TSLA via venue
    }

    function test_Sell_HoldDisabledWhenZeroSeconds() public {
        vm.prank(owner);
        exchange.setHoldSeconds(0);
        vm.prank(alice);
        exchange.buy(address(aapl), 1000e6, 0);
        vm.prank(alice);
        exchange.sell(address(aapl), 1e18, 0);
    }

    function test_RegisteredFund_ExemptFromHold() public {
        address fundish = makeAddr("fundish");
        vm.etch(fundish, hex"00"); // any code so registerFund accepts it
        vm.expectEmit(true, false, false, false, address(exchange));
        emit FundRegistered(fundish);
        vm.prank(address(factory));
        exchange.registerFund(fundish);
        assertTrue(exchange.registeredFunds(fundish));

        usdc.mint(fundish, 1000e6);
        vm.startPrank(fundish);
        usdc.approve(address(exchange), type(uint256).max);
        aapl.approve(address(exchange), type(uint256).max);
        exchange.buy(address(aapl), 1000e6, 0);
        exchange.sell(address(aapl), 1e18, 0); // immediate, no HoldActive
        vm.stopPrank();
    }

    function test_RegisterFund_AccessAndValidation() public {
        vm.prank(alice);
        vm.expectRevert(StockExchange.OnlyTrustedFactory.selector);
        exchange.registerFund(address(fund));

        vm.startPrank(address(factory));
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.registerFund(address(0));
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.registerFund(makeAddr("eoa"));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ inventory / reserve admin

    function test_InventoryOf() public {
        assertEq(exchange.inventoryOf(address(aapl)), INVENTORY);
        aapl.mint(address(exchange), 5e18); // direct transfers count
        assertEq(exchange.inventoryOf(address(aapl)), INVENTORY + 5e18);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.UnlistedStock.selector, address(usdc)));
        exchange.inventoryOf(address(usdc));
    }

    function test_WithdrawInventory_HappyPath() public {
        address dest = makeAddr("dest");
        vm.expectEmit(true, true, false, true, address(exchange));
        emit InventoryWithdrawn(address(aapl), 10e18, dest);
        vm.prank(owner);
        exchange.withdrawInventory(address(aapl), 10e18, dest);
        assertEq(aapl.balanceOf(dest), 10e18);
        assertEq(exchange.inventoryOf(address(aapl)), INVENTORY - 10e18);
    }

    function test_WithdrawInventory_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.withdrawInventory(address(aapl), 1e18, alice);

        vm.startPrank(owner);
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.withdrawInventory(address(aapl), 1e18, address(0));
        vm.expectRevert(StockExchange.InvalidAmount.selector);
        exchange.withdrawInventory(address(aapl), 0, owner);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.UnlistedStock.selector, address(usdc)));
        exchange.withdrawInventory(address(usdc), 1, owner);
        vm.stopPrank();
    }

    function test_WithdrawReserve_HappyPath() public {
        address dest = makeAddr("dest");
        vm.expectEmit(true, false, false, true, address(exchange));
        emit ReserveWithdrawn(500e6, dest);
        vm.prank(owner);
        exchange.withdrawReserve(500e6, dest);
        assertEq(usdc.balanceOf(dest), 500e6);
        assertEq(exchange.reserveBalance(), RESERVE - 500e6);
    }

    function test_WithdrawReserve_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.withdrawReserve(1, alice);

        vm.startPrank(owner);
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.withdrawReserve(1, address(0));
        vm.expectRevert(StockExchange.InvalidAmount.selector);
        exchange.withdrawReserve(0, owner);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_BuyThenSell_NeverProfitable(uint256 usdcIn) public {
        usdcIn = bound(usdcIn, 1e6, 100_000e6);
        vm.prank(alice);
        uint256 out = exchange.buy(address(aapl), usdcIn, 0);
        skip(60);
        vm.prank(alice);
        uint256 back = exchange.sell(address(aapl), out, 0);
        assertLe(back, usdcIn, "round trip must not profit");
    }
}

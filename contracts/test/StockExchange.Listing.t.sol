// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcBase} from "./Base.t.sol";
import {MockERC20} from "./Mocks.t.sol";
import {StockExchange} from "../StockExchange.sol";

contract StockExchangeListingTest is ArcBase {
    event StockListed(address indexed token, string name, string symbol, uint256 initialPrice);

    function _new18(string memory sym) internal returns (MockERC20) {
        return new MockERC20(sym, sym, 18);
    }

    // ------------------------------------------------------------ constructor

    function test_Constructor_SetsState() public view {
        assertEq(exchange.usdc(), address(usdc));
        assertEq(exchange.owner(), owner);
        assertEq(exchange.getForwarderAddress(), forwarder);
        assertEq(exchange.holdSeconds(), 60);
        assertEq(exchange.spreadBps(), 50);
        assertEq(exchange.maxMoveBps(), 500);
        assertEq(exchange.maxPriceAge(), 96 hours);
        assertEq(uint8(exchange.priceSource()), 0);
    }

    function test_Constructor_RevertsOnBadUsdc() public {
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        new StockExchange(owner, address(0), forwarder);
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        new StockExchange(owner, makeAddr("eoa"), forwarder);
    }

    // ------------------------------------------------------------ listing

    function test_ListExternalStock_HappyPath() public {
        MockERC20 nvda = _new18("NVDA");
        vm.expectEmit(true, false, false, true, address(exchange));
        emit StockListed(address(nvda), "Nvidia", "NVDA", 120e6);
        vm.prank(owner);
        exchange.listExternalStock(address(nvda), "Nvidia", "NVDA", 120e6);

        assertTrue(exchange.isListed(address(nvda)));
        assertEq(exchange.stockCount(), 4);
        assertEq(exchange.stockAt(3), address(nvda));
        assertEq(exchange.price(address(nvda)), 120e6);
        assertEq(exchange.rawPrice(address(nvda)), 120e6);
        assertEq(exchange.lastUpdated(address(nvda)), block.timestamp);
        StockExchange.StockInfo[] memory infos = exchange.getStocks();
        assertEq(infos.length, 4);
        assertEq(infos[3].symbol, "NVDA");
        assertEq(infos[3].name, "Nvidia");
        assertEq(infos[3].token, address(nvda));
    }

    function test_ListExternalStock_OnlyOwner() public {
        MockERC20 nvda = _new18("NVDA");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.listExternalStock(address(nvda), "Nvidia", "NVDA", 120e6);
    }

    function test_ListExternalStock_ZeroPrice() public {
        MockERC20 nvda = _new18("NVDA");
        vm.prank(owner);
        vm.expectRevert(StockExchange.InvalidPrice.selector);
        exchange.listExternalStock(address(nvda), "Nvidia", "NVDA", 0);
    }

    function test_ListExternalStock_DuplicateSymbol() public {
        MockERC20 other = _new18("AAPL2");
        vm.prank(owner);
        vm.expectRevert(StockExchange.DuplicateSymbol.selector);
        exchange.listExternalStock(address(other), "Apple Two", "AAPL", 10e6);
    }

    function test_ListExternalStock_AlreadyListed() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.AlreadyListed.selector, address(aapl)));
        exchange.listExternalStock(address(aapl), "Apple", "AAPLX", 10e6);
    }

    function test_ListExternalStock_StockLimit50() public {
        vm.startPrank(owner);
        for (uint256 i = 3; i < 50; ++i) {
            MockERC20 t = _new18("T");
            exchange.listExternalStock(address(t), "Tok", string.concat("S", vm.toString(i)), 10e6);
        }
        assertEq(exchange.stockCount(), 50);
        MockERC20 extra = _new18("X");
        vm.expectRevert(StockExchange.StockLimit.selector);
        exchange.listExternalStock(address(extra), "Extra", "EXTRA", 10e6);
        vm.stopPrank();
    }

    function test_ListExternalStock_RejectsNon18Decimals() public {
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        vm.prank(owner);
        vm.expectRevert(StockExchange.InvalidDecimals.selector);
        exchange.listExternalStock(address(six), "Six", "SIX", 10e6);
    }

    function test_ListExternalStock_RejectsContractWithoutDecimals() public {
        vm.prank(owner);
        vm.expectRevert(StockExchange.InvalidDecimals.selector);
        exchange.listExternalStock(address(this), "Me", "ME", 10e6);
    }

    function test_ListExternalStock_RejectsNoCodeAndZero() public {
        vm.startPrank(owner);
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.listExternalStock(makeAddr("eoa"), "Eoa", "EOA", 10e6);
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.listExternalStock(address(0), "Zero", "ZERO", 10e6);
        vm.stopPrank();
    }

    function test_ListExternalStock_RejectsUsdc() public {
        vm.prank(owner);
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.listExternalStock(address(usdc), "USDC", "USDC", 1e6);
    }

    function test_ListExternalStock_InvalidSymbolOrName() public {
        MockERC20 nvda = _new18("NVDA");
        vm.startPrank(owner);
        vm.expectRevert(StockExchange.InvalidSymbol.selector);
        exchange.listExternalStock(address(nvda), "Nvidia", "", 10e6);
        vm.expectRevert(StockExchange.InvalidSymbol.selector);
        exchange.listExternalStock(address(nvda), "Nvidia", "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFG", 10e6);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ config setters

    function test_Setters_HappyAndBounds() public {
        vm.startPrank(owner);
        exchange.setSpreadBps(200);
        assertEq(exchange.spreadBps(), 200);
        vm.expectRevert(StockExchange.InvalidConfiguration.selector);
        exchange.setSpreadBps(201);

        exchange.setHoldSeconds(3600);
        assertEq(exchange.holdSeconds(), 3600);
        vm.expectRevert(StockExchange.InvalidConfiguration.selector);
        exchange.setHoldSeconds(3601);

        exchange.setMaxMoveBps(5000);
        assertEq(exchange.maxMoveBps(), 5000);
        vm.expectRevert(StockExchange.InvalidConfiguration.selector);
        exchange.setMaxMoveBps(5001);

        exchange.setMaxPriceAge(1 hours);
        assertEq(exchange.maxPriceAge(), 1 hours);
        vm.expectRevert(StockExchange.InvalidConfiguration.selector);
        exchange.setMaxPriceAge(1 hours - 1);
        vm.stopPrank();
    }

    function test_Setters_OnlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(err);
        exchange.setSpreadBps(1);
        vm.expectRevert(err);
        exchange.setHoldSeconds(1);
        vm.expectRevert(err);
        exchange.setMaxMoveBps(1);
        vm.expectRevert(err);
        exchange.setMaxPriceAge(1 hours);
        vm.expectRevert(err);
        exchange.setTrustedFactory(address(factory));
        vm.stopPrank();
    }

    function test_SetTrustedFactory_RejectsNoCode_AllowsZero() public {
        vm.startPrank(owner);
        vm.expectRevert(StockExchange.InvalidAddress.selector);
        exchange.setTrustedFactory(makeAddr("eoa"));
        exchange.setTrustedFactory(address(0));
        assertEq(exchange.trustedFactory(), address(0));
        vm.stopPrank();
    }

    function test_Constructor_ZeroForwarderReverts() public {
        vm.expectRevert();
        new StockExchange(owner, address(usdc), address(0));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcBase} from "./Base.t.sol";
import {StockExchange} from "../StockExchange.sol";
import {ReceiverTemplate} from "../ReceiverTemplate.sol";

contract StockExchangePricingTest is ArcBase {
    event PricesUpdated(address[] tokens, uint256[] prices, uint64 timestamp);
    event PriceSourceUpdated(StockExchange.PriceSource source);
    event ReportIgnored();

    address internal author = makeAddr("workflowAuthor");

    function _meta(address a) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes10(0), a);
    }

    function _report(address t, uint256 p, uint64 ts) internal pure returns (bytes memory) {
        address[] memory ts_ = new address[](1);
        uint256[] memory ps = new uint256[](1);
        ts_[0] = t;
        ps[0] = p;
        return abi.encode(ts_, ps, ts);
    }

    function _toFeed() internal {
        vm.startPrank(owner);
        exchange.setExpectedAuthor(author);
        exchange.setPriceSource(StockExchange.PriceSource.Feed);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ admin prices

    function test_SetPrice_WithinCap() public {
        address[] memory ts = new address[](1);
        uint256[] memory ps = new uint256[](1);
        ts[0] = address(aapl);
        ps[0] = 210e6;
        vm.expectEmit(false, false, false, true, address(exchange));
        emit PricesUpdated(ts, ps, uint64(block.timestamp));
        vm.prank(owner);
        exchange.setPrice(address(aapl), 210e6); // exactly +5%
        assertEq(exchange.price(address(aapl)), 210e6);

        vm.prank(owner);
        exchange.setPrice(address(tsla), 95e6); // exactly -5%
        assertEq(exchange.price(address(tsla)), 95e6);
    }

    function test_SetPrice_MoveCapExceeded() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(StockExchange.PriceMoveExceeded.selector, address(aapl), 200e6, 210e6 + 1)
        );
        exchange.setPrice(address(aapl), 210e6 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(StockExchange.PriceMoveExceeded.selector, address(aapl), 200e6, 190e6 - 1)
        );
        exchange.setPrice(address(aapl), 190e6 - 1);
        vm.stopPrank();
    }

    function test_SetPrice_WiderCapAfterConfig() public {
        vm.startPrank(owner);
        exchange.setMaxMoveBps(2000);
        exchange.setPrice(address(aapl), 240e6);
        vm.stopPrank();
        assertEq(exchange.price(address(aapl)), 240e6);
    }

    function test_SetPrice_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.setPrice(address(aapl), 200e6);

        vm.startPrank(owner);
        vm.expectRevert(StockExchange.InvalidPrice.selector);
        exchange.setPrice(address(aapl), 0);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.UnlistedStock.selector, address(usdc)));
        exchange.setPrice(address(usdc), 1e6);
        vm.stopPrank();
    }

    function test_SetPrices_BatchAndValidation() public {
        address[] memory ts = new address[](2);
        uint256[] memory ps = new uint256[](2);
        ts[0] = address(aapl);
        ts[1] = address(tsla);
        ps[0] = 205e6;
        ps[1] = 102e6;
        vm.prank(owner);
        exchange.setPrices(ts, ps);
        assertEq(exchange.price(address(aapl)), 205e6);
        assertEq(exchange.price(address(tsla)), 102e6);

        // mismatch
        uint256[] memory one = new uint256[](1);
        one[0] = 1e6;
        vm.prank(owner);
        vm.expectRevert(StockExchange.InvalidArrayLength.selector);
        exchange.setPrices(ts, one);

        // empty
        vm.prank(owner);
        vm.expectRevert(StockExchange.InvalidArrayLength.selector);
        exchange.setPrices(new address[](0), new uint256[](0));

        // duplicate tokens
        ts[1] = address(aapl);
        vm.prank(owner);
        vm.expectRevert(StockExchange.InvalidArrayLength.selector);
        exchange.setPrices(ts, ps);

        // non-owner
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.setPrices(ts, ps);
    }

    function test_SetPrices_IsAtomic() public {
        address[] memory ts = new address[](2);
        uint256[] memory ps = new uint256[](2);
        ts[0] = address(aapl);
        ts[1] = address(tsla);
        ps[0] = 205e6;
        ps[1] = 500e6; // violates cap
        vm.prank(owner);
        vm.expectRevert();
        exchange.setPrices(ts, ps);
        assertEq(exchange.price(address(aapl)), 200e6);
    }

    // ------------------------------------------------------------ staleness

    function test_StalePrice_RevertsAfterMaxAgeAndRefreshWorks() public {
        uint256 listedAt = exchange.lastUpdated(address(aapl));
        skip(96 hours); // exactly at the limit is still fresh
        assertEq(exchange.price(address(aapl)), 200e6);
        skip(1);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.StalePrice.selector, address(aapl), listedAt));
        exchange.price(address(aapl));
        vm.expectRevert(abi.encodeWithSelector(StockExchange.StalePrice.selector, address(aapl), listedAt));
        exchange.quoteBuy(address(aapl), 1e6);

        _approveExchange(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.StalePrice.selector, address(aapl), listedAt));
        exchange.buy(address(aapl), 1e6, 0);
        // raw price and registry remain readable
        assertEq(exchange.rawPrice(address(aapl)), 200e6);

        vm.prank(owner);
        exchange.setPrice(address(aapl), 200e6);
        assertEq(exchange.price(address(aapl)), 200e6);
    }

    function test_StalePrice_ShorterMaxAge() public {
        vm.prank(owner);
        exchange.setMaxPriceAge(2 hours);
        skip(2 hours + 1);
        vm.expectRevert();
        exchange.price(address(tsla));
    }

    // ------------------------------------------------------------ price source

    function test_SetPriceSource_FeedNeedsIdentity() public {
        vm.startPrank(owner);
        vm.expectRevert(StockExchange.WorkflowIdentityRequired.selector);
        exchange.setPriceSource(StockExchange.PriceSource.Feed);

        exchange.setExpectedAuthor(author);
        vm.expectEmit(false, false, false, true, address(exchange));
        emit PriceSourceUpdated(StockExchange.PriceSource.Feed);
        exchange.setPriceSource(StockExchange.PriceSource.Feed);
        assertEq(uint8(exchange.priceSource()), 1);

        exchange.setPriceSource(StockExchange.PriceSource.Admin);
        assertEq(uint8(exchange.priceSource()), 0);
        vm.stopPrank();
    }

    function test_SetPriceSource_FeedWithWorkflowIdAlsoOk() public {
        vm.startPrank(owner);
        exchange.setExpectedWorkflowId(bytes32(uint256(7)));
        exchange.setPriceSource(StockExchange.PriceSource.Feed);
        vm.stopPrank();
        assertEq(uint8(exchange.priceSource()), 1);
    }

    function test_SetPriceSource_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.setPriceSource(StockExchange.PriceSource.Admin);
    }

    function test_FeedMode_AdminSettersRevert() public {
        _toFeed();
        vm.startPrank(owner);
        vm.expectRevert(StockExchange.WrongPriceSource.selector);
        exchange.setPrice(address(aapl), 200e6);
        vm.expectRevert(StockExchange.WrongPriceSource.selector);
        exchange.setPrices(new address[](1), new uint256[](1));
        vm.stopPrank();
    }

    function test_FeedMode_CannotClearIdentity() public {
        _toFeed();
        vm.prank(owner);
        vm.expectRevert(StockExchange.WorkflowIdentityRequired.selector);
        exchange.setExpectedAuthor(address(0));
    }

    // ------------------------------------------------------------ onReport

    function test_OnReport_FeedMode_UpdatesPrices() public {
        _toFeed();
        skip(1 hours);
        uint64 ts = uint64(block.timestamp);
        address[] memory tokens = new address[](2);
        uint256[] memory prices = new uint256[](2);
        tokens[0] = address(aapl);
        tokens[1] = address(tsla);
        prices[0] = 204e6;
        prices[1] = 97e6;

        vm.expectEmit(false, false, false, true, address(exchange));
        emit PricesUpdated(tokens, prices, ts);
        vm.prank(forwarder);
        exchange.onReport(_meta(author), abi.encode(tokens, prices, ts));

        assertEq(exchange.price(address(aapl)), 204e6);
        assertEq(exchange.price(address(tsla)), 97e6);
        assertEq(exchange.lastUpdated(address(aapl)), ts);
        assertEq(exchange.lastReportAt(), block.timestamp);
        assertEq(exchange.price(address(msft)), 50e6); // untouched
    }

    function test_OnReport_NonForwarderReverts() public {
        _toFeed();
        skip(1 hours);
        bytes memory rep = _report(address(aapl), 204e6, uint64(block.timestamp));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, alice, forwarder));
        exchange.onReport(_meta(author), rep);
        // owner is not the forwarder either
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, owner, forwarder));
        exchange.onReport(_meta(author), rep);
        assertEq(exchange.price(address(aapl)), 200e6);
    }

    function test_OnReport_NonForwarderReverts_AdminMode() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, alice, forwarder));
        exchange.onReport("", _report(address(aapl), 204e6, uint64(block.timestamp)));
    }

    function test_OnReport_AdminMode_IgnoresReports() public {
        skip(1 hours);
        vm.expectEmit(false, false, false, false, address(exchange));
        emit ReportIgnored();
        vm.prank(forwarder);
        exchange.onReport("", _report(address(aapl), 204e6, uint64(block.timestamp)));
        assertEq(exchange.price(address(aapl)), 200e6);
        assertEq(exchange.lastReportAt(), 0);
    }

    function test_OnReport_WrongAuthorOrBadMetadata() public {
        _toFeed();
        skip(1 hours);
        bytes memory rep = _report(address(aapl), 204e6, uint64(block.timestamp));
        address bad = makeAddr("bad");
        vm.startPrank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidAuthor.selector, bad, author));
        exchange.onReport(_meta(bad), rep);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidMetadataLength.selector, 3));
        exchange.onReport(hex"010203", rep);
        vm.stopPrank();
    }

    function test_OnReport_FeedMode_MoveCapStillApplies() public {
        _toFeed();
        skip(1 hours);
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(StockExchange.PriceMoveExceeded.selector, address(aapl), 200e6, 300e6)
        );
        exchange.onReport(_meta(author), _report(address(aapl), 300e6, uint64(block.timestamp)));
    }

    function test_OnReport_FeedMode_TimestampRules() public {
        _toFeed();
        skip(1 hours);
        vm.startPrank(forwarder);
        // future timestamp
        vm.expectRevert(StockExchange.InvalidTimestamp.selector);
        exchange.onReport(_meta(author), _report(address(aapl), 204e6, uint64(block.timestamp + 1)));
        // not newer than the stored one (listing time)
        vm.expectRevert(StockExchange.InvalidTimestamp.selector);
        exchange.onReport(_meta(author), _report(address(aapl), 204e6, uint64(START)));
        // valid, then replay of same timestamp rejected
        exchange.onReport(_meta(author), _report(address(aapl), 204e6, uint64(block.timestamp)));
        vm.expectRevert(StockExchange.InvalidTimestamp.selector);
        exchange.onReport(_meta(author), _report(address(aapl), 204e6, uint64(block.timestamp)));
        vm.stopPrank();
    }

    function test_OnReport_FeedMode_UnlistedAndZeroPrice() public {
        _toFeed();
        skip(1 hours);
        vm.startPrank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(StockExchange.UnlistedStock.selector, address(usdc)));
        exchange.onReport(_meta(author), _report(address(usdc), 1e6, uint64(block.timestamp)));
        vm.expectRevert(StockExchange.InvalidPrice.selector);
        exchange.onReport(_meta(author), _report(address(aapl), 0, uint64(block.timestamp)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ Ownable2Step

    function test_TransferOwnership_TwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        exchange.transferOwnership(newOwner);
        assertEq(exchange.owner(), owner, "owner unchanged until accepted");
        assertEq(exchange.pendingOwner(), newOwner);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.acceptOwnership();

        vm.prank(newOwner);
        exchange.acceptOwnership();
        assertEq(exchange.owner(), newOwner);
        assertEq(exchange.pendingOwner(), address(0));

        // old owner lost privileges
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        exchange.setSpreadBps(10);
    }

    function test_TransferOwnership_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        exchange.transferOwnership(alice);
    }
}

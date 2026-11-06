// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./Mocks.t.sol";
import {StockExchange} from "../StockExchange.sol";
import {IndexFund} from "../IndexFund.sol";
import {IndexFactory} from "../IndexFactory.sol";

/// @dev Shared fixture: USDC(6), AAPL/TSLA/MSFT(18), exchange stocked with inventory + reserve,
/// factory trusted by the exchange, and a 50/50 AAPL/TSLA zero-fee fund created via the factory.
abstract contract ArcBase is Test {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant START = 1_700_000_000;

    address internal owner = makeAddr("owner");
    address internal forwarder = makeAddr("forwarder");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MockERC20 internal usdc;
    MockERC20 internal aapl;
    MockERC20 internal tsla;
    MockERC20 internal msft;
    StockExchange internal exchange;
    IndexFactory internal factory;
    IndexFund internal fund;

    uint256 internal constant AAPL_PX = 200e6;
    uint256 internal constant TSLA_PX = 100e6;
    uint256 internal constant MSFT_PX = 50e6;
    uint256 internal constant INVENTORY = 1_000e18;
    uint256 internal constant RESERVE = 1_000_000e6;

    function setUp() public virtual {
        vm.warp(START);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aapl = new MockERC20("Apple", "AAPL", 18);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        msft = new MockERC20("Microsoft", "MSFT", 18);

        exchange = new StockExchange(owner, address(usdc), forwarder);
        vm.startPrank(owner);
        exchange.listExternalStock(address(aapl), "Apple", "AAPL", AAPL_PX);
        exchange.listExternalStock(address(tsla), "Tesla", "TSLA", TSLA_PX);
        exchange.listExternalStock(address(msft), "Microsoft", "MSFT", MSFT_PX);
        vm.stopPrank();

        // Inventory + reserve are plain transfers/mints into the venue.
        aapl.mint(address(exchange), INVENTORY);
        tsla.mint(address(exchange), INVENTORY);
        msft.mint(address(exchange), INVENTORY);
        usdc.mint(address(exchange), RESERVE);

        factory = new IndexFactory(owner, address(exchange), address(usdc), address(0));
        vm.prank(owner);
        exchange.setTrustedFactory(address(factory));

        fund = _mkFund(_two(), _w5050(), 0);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            usdc.mint(users[i], 1_000_000e6);
            aapl.mint(users[i], 100e18);
            tsla.mint(users[i], 100e18);
            msft.mint(users[i], 100e18);
        }
    }

    // ---------------------------------------------------------------- helpers

    function _two() internal view returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(aapl);
        t[1] = address(tsla);
    }

    function _three() internal view returns (address[] memory t) {
        t = new address[](3);
        t[0] = address(aapl);
        t[1] = address(tsla);
        t[2] = address(msft);
    }

    function _w5050() internal pure returns (uint16[] memory w) {
        w = new uint16[](2);
        w[0] = 5000;
        w[1] = 5000;
    }

    function _w433() internal pure returns (uint16[] memory w) {
        w = new uint16[](3);
        w[0] = 4000;
        w[1] = 3000;
        w[2] = 3000;
    }

    function _mkFund(address[] memory t, uint16[] memory w, uint16 fee) internal returns (IndexFund f) {
        vm.prank(creator);
        f = IndexFund(factory.createIndex("Fund", "FND", "", t, w, fee, ""));
    }

    function _approveFund(address user, IndexFund f) internal {
        vm.startPrank(user);
        usdc.approve(address(f), type(uint256).max);
        aapl.approve(address(f), type(uint256).max);
        tsla.approve(address(f), type(uint256).max);
        msft.approve(address(f), type(uint256).max);
        vm.stopPrank();
    }

    function _approveExchange(address user) internal {
        vm.startPrank(user);
        usdc.approve(address(exchange), type(uint256).max);
        aapl.approve(address(exchange), type(uint256).max);
        tsla.approve(address(exchange), type(uint256).max);
        msft.approve(address(exchange), type(uint256).max);
        vm.stopPrank();
    }

    function _invest(address user, IndexFund f, uint256 amt) internal returns (uint256 shares) {
        _approveFund(user, f);
        vm.prank(user);
        shares = f.invest(amt, 0);
    }

    function _kind(address user, IndexFund f, address[] memory t, uint256[] memory a, address receiver)
        internal
        returns (uint256 shares)
    {
        _approveFund(user, f);
        vm.prank(user);
        shares = f.investInKind(t, a, 0, receiver);
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }

    /// @dev Refresh every listed price at its current value (resets staleness; zero move).
    function _refreshPrices() internal {
        vm.startPrank(owner);
        exchange.setPrice(address(aapl), exchange.rawPrice(address(aapl)));
        exchange.setPrice(address(tsla), exchange.rawPrice(address(tsla)));
        exchange.setPrice(address(msft), exchange.rawPrice(address(msft)));
        vm.stopPrank();
    }
}

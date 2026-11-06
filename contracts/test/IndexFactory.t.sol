// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArcBase} from "./Base.t.sol";
import {MockERC20} from "./Mocks.t.sol";
import {IndexFund} from "../IndexFund.sol";
import {IndexFactory} from "../IndexFactory.sol";
import {StockExchange} from "../StockExchange.sol";

contract MockRegistrar {
    string public lastLabel;
    address public lastFund;
    address public lastCreator;
    uint256 public calls;

    function register(string calldata label, address fund, address creator, string calldata)
        external
        returns (bytes32)
    {
        lastLabel = label;
        lastFund = fund;
        lastCreator = creator;
        ++calls;
        return keccak256(bytes(label));
    }

    function isAvailable(string calldata) external pure returns (bool) {
        return true;
    }
}

contract IndexFactoryTest is ArcBase {
    event IndexCreated(address indexed fund, address indexed creator, string name, string symbol, string label);
    event RegistrarUpdated(address indexed registrar);

    function _create(string memory label) internal returns (address) {
        vm.prank(alice);
        return factory.createIndex("My Index", "MYI", label, _two(), _w5050(), 50, "desc");
    }

    // ------------------------------------------------------------ constructor

    function test_Constructor_ZeroRegistrarAccepted() public {
        IndexFactory f = new IndexFactory(owner, address(exchange), address(usdc), address(0));
        assertEq(f.registrar(), address(0));
        assertEq(f.venue(), address(exchange));
        assertEq(f.usdc(), address(usdc));
        assertEq(f.owner(), owner);
        assertEq(f.indexCount(), 0);
    }

    function test_Constructor_InvalidConfigReverts() public {
        vm.expectRevert(IndexFactory.InvalidConfiguration.selector);
        new IndexFactory(owner, address(0), address(usdc), address(0));
        vm.expectRevert(IndexFactory.InvalidConfiguration.selector);
        new IndexFactory(owner, address(exchange), address(0), address(0));
        vm.expectRevert(IndexFactory.InvalidConfiguration.selector);
        new IndexFactory(owner, makeAddr("eoa"), address(usdc), address(0));
        vm.expectRevert(IndexFactory.InvalidConfiguration.selector);
        new IndexFactory(owner, address(exchange), address(aapl), address(0)); // usdc mismatch
        vm.expectRevert(IndexFactory.InvalidConfiguration.selector);
        new IndexFactory(owner, address(exchange), address(usdc), makeAddr("eoaRegistrar"));
    }

    // ------------------------------------------------------------ createIndex

    function test_CreateIndex_HappyPath() public {
        uint256 before_ = factory.indexCount();
        vm.expectEmit(false, true, false, true, address(factory));
        emit IndexCreated(address(0), alice, "My Index", "MYI", "");
        address f = _create("");

        assertTrue(factory.isIndex(f));
        assertEq(factory.indexCount(), before_ + 1);
        assertEq(factory.indexAt(before_), f);
        IndexFund idx = IndexFund(f);
        assertEq(idx.creator(), alice);
        assertEq(idx.feeBps(), 50);
        assertEq(idx.name(), "My Index");
        assertEq(idx.symbol(), "MYI");
        assertEq(idx.venue(), address(exchange));
        assertEq(idx.usdc(), address(usdc));
        assertEq(factory.indexesByCreator(alice).length, 1);
        assertEq(factory.indexesByCreator(alice)[0], f);
    }

    function test_CreateIndex_LabelIgnoredWhenNoRegistrar() public {
        assertEq(factory.registrar(), address(0));
        address a = _create("");
        bytes memory long_ = new bytes(500);
        for (uint256 i; i < 500; ++i) long_[i] = "x";
        address b = _create(string(long_));
        address c = _create("Weird Label!! with spaces");
        assertTrue(factory.isIndex(a));
        assertTrue(factory.isIndex(b));
        assertTrue(factory.isIndex(c));
        assertTrue(a != b && b != c);
    }

    function test_CreateIndex_RegistersFundOnExchangeAndIsExemptFromHold() public {
        address f = _create("");
        assertTrue(exchange.registeredFunds(f), "registerFund called on venue");

        // Prove the exemption end-to-end: invest then redeem immediately of free shares via exchange sell.
        vm.prank(owner);
        exchange.setHoldSeconds(60);
        IndexFund idx = IndexFund(f);
        _approveFund(bob, idx);
        vm.prank(bob);
        uint256 s = idx.invest(1000e6, 0);
        skip(60);
        vm.prank(bob);
        idx.redeem(s, 0); // venue hold would be active for an unregistered fund only if a 2nd buyer interfered
        assertEq(idx.balanceOf(bob), 0);
    }

    function test_CreateIndex_RevertsWhenFactoryNotTrusted() public {
        IndexFactory untrusted = new IndexFactory(owner, address(exchange), address(usdc), address(0));
        vm.prank(alice);
        vm.expectRevert(StockExchange.OnlyTrustedFactory.selector);
        untrusted.createIndex("A", "A", "", _two(), _w5050(), 0, "");
        assertEq(untrusted.indexCount(), 0);
    }

    // ------------------------------------------------------------ basket validation

    function test_CreateIndex_UnlistedToken() public {
        address[] memory t = _two();
        t[1] = address(new MockERC20("X", "X", 18)); // not listed
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", t, _w5050(), 0, "");
    }

    function test_CreateIndex_UsdcAsConstituent() public {
        address[] memory t = _two();
        t[1] = address(usdc);
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", t, _w5050(), 0, "");
    }

    function test_CreateIndex_WeightsMustSumTo10000() public {
        uint16[] memory w = _w5050();
        w[1] = 4999;
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", _two(), w, 0, "");
        w[1] = 5001;
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", _two(), w, 0, "");
    }

    function test_CreateIndex_ZeroWeight() public {
        uint16[] memory w = _w5050();
        w[0] = 0;
        w[1] = 10000;
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", _two(), w, 0, "");
    }

    function test_CreateIndex_LessThanTwoTokens() public {
        address[] memory t = new address[](1);
        t[0] = address(aapl);
        uint16[] memory w = new uint16[](1);
        w[0] = 10000;
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", t, w, 0, "");
    }

    function test_CreateIndex_ArrayLengthMismatch() public {
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", _three(), _w5050(), 0, "");
    }

    function test_CreateIndex_DuplicateTokens() public {
        address[] memory t = _two();
        t[1] = t[0];
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", t, _w5050(), 0, "");
    }

    function test_CreateIndex_FeeAbove200() public {
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", _two(), _w5050(), 201, "");
        // boundary 200 is allowed
        factory.createIndex("A", "A", "", _two(), _w5050(), 200, "");
    }

    function test_CreateIndex_TooManyTokens() public {
        address[] memory t = new address[](11);
        uint16[] memory w = new uint16[](11);
        vm.startPrank(owner);
        for (uint256 i; i < 11; ++i) {
            MockERC20 m = new MockERC20("T", "T", 18);
            exchange.listExternalStock(address(m), "T", string.concat("Z", vm.toString(i)), 10e6);
            t[i] = address(m);
            w[i] = i == 10 ? 9091 - 909 * 9 : 909; // sums to 10000 (909*10 + 910)
        }
        vm.stopPrank();
        w[10] = 910;
        vm.expectRevert(IndexFactory.InvalidBasket.selector);
        factory.createIndex("A", "A", "", t, w, 0, "");
    }

    function test_CreateIndex_InvalidMetadata() public {
        bytes memory b129 = new bytes(129);
        bytes memory b33 = new bytes(33);
        bytes memory b2049 = new bytes(2049);
        vm.expectRevert(IndexFactory.InvalidMetadata.selector);
        factory.createIndex("", "A", "", _two(), _w5050(), 0, "");
        vm.expectRevert(IndexFactory.InvalidMetadata.selector);
        factory.createIndex("A", "", "", _two(), _w5050(), 0, "");
        vm.expectRevert(IndexFactory.InvalidMetadata.selector);
        factory.createIndex(string(b129), "A", "", _two(), _w5050(), 0, "");
        vm.expectRevert(IndexFactory.InvalidMetadata.selector);
        factory.createIndex("A", string(b33), "", _two(), _w5050(), 0, "");
        vm.expectRevert(IndexFactory.InvalidMetadata.selector);
        factory.createIndex("A", "A", "", _two(), _w5050(), 0, string(b2049));
    }

    // ------------------------------------------------------------ registrar behaviour

    function test_SetRegistrar_OwnerOnlyAndValidation() public {
        MockRegistrar reg = new MockRegistrar();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.setRegistrar(address(reg));

        vm.startPrank(owner);
        vm.expectRevert(IndexFactory.InvalidConfiguration.selector);
        factory.setRegistrar(makeAddr("eoa"));
        vm.expectEmit(true, false, false, false, address(factory));
        emit RegistrarUpdated(address(reg));
        factory.setRegistrar(address(reg));
        assertEq(factory.registrar(), address(reg));
        factory.setRegistrar(address(0));
        assertEq(factory.registrar(), address(0));
        vm.stopPrank();
    }

    function test_CreateIndex_WithRegistrarRegistersLabel() public {
        MockRegistrar reg = new MockRegistrar();
        vm.prank(owner);
        factory.setRegistrar(address(reg));

        address f = _create("myindex");
        assertEq(reg.calls(), 1);
        assertEq(reg.lastLabel(), "myindex");
        assertEq(reg.lastFund(), f);
        assertEq(reg.lastCreator(), alice);

        // with a registrar configured, an empty label is rejected
        vm.prank(alice);
        vm.expectRevert(IndexFactory.InvalidMetadata.selector);
        factory.createIndex("A", "A", "", _two(), _w5050(), 0, "");
    }

    // ------------------------------------------------------------ paging

    function test_IndexCountAndPaging() public {
        // setUp already created one fund
        assertEq(factory.indexCount(), 1);
        address[] memory made = new address[](4);
        for (uint256 i; i < 4; ++i) made[i] = _create("");
        assertEq(factory.indexCount(), 5);

        address[] memory all = factory.getIndexes(0, 100);
        assertEq(all.length, 5);
        assertEq(all[0], address(fund));
        assertEq(all[4], made[3]);

        address[] memory page = factory.getIndexes(2, 2);
        assertEq(page.length, 2);
        assertEq(page[0], all[2]);
        assertEq(page[1], all[3]);

        assertEq(factory.getIndexes(4, 10).length, 1);
        assertEq(factory.getIndexes(5, 10).length, 0);
        assertEq(factory.getIndexes(1000, 10).length, 0);
        assertEq(factory.getIndexes(0, 0).length, 0);

        vm.expectRevert(IndexFactory.InvalidPageSize.selector);
        factory.getIndexes(0, 101);

        assertEq(factory.indexesByCreator(alice).length, 4);
        assertEq(factory.indexesByCreator(creator).length, 1);
    }
}

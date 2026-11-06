// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IndexFactory} from "../IndexFactory.sol";

contract MockUSDC is ERC20("USD Coin", "USDC") {
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @dev Only the venue calls IndexFactory and IndexFund make during creation.
contract MockVenue {
    address public immutable usdc;
    mapping(address => bool) public isListed;
    mapping(address => bool) public registeredFunds;
    constructor(address usdc_) { usdc = usdc_; }
    function list(address token) external { isListed[token] = true; }
    function registerFund(address fund) external { registeredFunds[fund] = true; }
}

contract IndexFactoryLabelsTest is Test {
    IndexFactory factory;
    MockVenue venue;
    address[] tokens;
    uint16[] weights;

    event IndexCreated(
        address indexed fund, address indexed creator, string name, string symbol, string label, string description
    );

    function setUp() public {
        MockUSDC usdc = new MockUSDC();
        venue = new MockVenue(address(usdc));
        factory = new IndexFactory(address(this), address(venue), address(usdc), address(0));
        tokens.push(makeAddr("tAAPL"));
        tokens.push(makeAddr("tNVDA"));
        venue.list(tokens[0]);
        venue.list(tokens[1]);
        weights.push(6000);
        weights.push(4000);
    }

    function _create(string memory label) internal returns (address) {
        return factory.createIndex("US Tech", "TECH", label, tokens, weights, 100, "desc");
    }

    function test_storesLabelAndEmitsDescription() public {
        vm.expectEmit(false, true, false, true, address(factory));
        emit IndexCreated(address(0), address(this), "US Tech", "TECH", "tech", "desc");
        address fund = _create("tech");
        assertEq(factory.fundByLabel(keccak256("tech")), fund);
        assertFalse(factory.isLabelAvailable("tech"));
        assertTrue(factory.isLabelAvailable("tech2"));
    }

    function test_rejectsDuplicateLabel() public {
        _create("tech");
        vm.expectRevert(abi.encodeWithSelector(IndexFactory.LabelTaken.selector, "tech"));
        _create("tech");
    }

    function test_rejectsInvalidLabels() public {
        string[5] memory bad = ["", "ab", "Tech", "tech-fund", "averyveryverylonglabel"];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(IndexFactory.InvalidLabel.selector);
            _create(bad[i]);
            assertFalse(factory.isLabelAvailable(bad[i]));
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock stock with immutable exchange-only issuance and burning.
contract StockToken is ERC20 {
    address public immutable exchange;
    error InvalidExchange();
    error OnlyExchange();

    constructor(string memory name, string memory symbol, address exchange_) ERC20(name, symbol) {
        if (exchange_ == address(0)) revert InvalidExchange();
        exchange = exchange_;
    }

    /// @notice Mints stock to an account; only the exchange may call.
    function mint(address to, uint256 amount) external {
        if (msg.sender != exchange) revert OnlyExchange();
        _mint(to, amount);
    }

    /// @notice Burns stock without an allowance; only the exchange may call.
    function burn(address from, uint256 amount) external {
        if (msg.sender != exchange) revert OnlyExchange();
        _burn(from, amount);
    }
}

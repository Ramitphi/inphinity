// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Trading and checked pricing boundary for stock venues.
interface IStockVenue {
    /// @notice Returns the six-decimal settlement token.
    function usdc() external view returns (address);
    /// @notice Pulls USDC and transfers stock tokens from venue inventory to the caller.
    function buy(address token, uint256 usdcIn, uint256 minTokensOut) external returns (uint256 tokensOut);
    /// @notice Pulls approved stock tokens from the caller into venue inventory and pays USDC.
    function sell(address token, uint256 tokenIn, uint256 minUsdcOut) external returns (uint256 usdcOut);
    /// @notice Returns mid-price USDC units per 1e18 stocks; rejects unlisted or stale prices.
    function price(address token) external view returns (uint256);
    /// @notice Returns the checked mid price, without spread.
    function midPrice(address token) external view returns (uint256);
    /// @notice Returns the checked buy price, rounded up in favor of the venue.
    function buyPrice(address token) external view returns (uint256);
    /// @notice Returns the checked sell price, rounded down in favor of the venue.
    function sellPrice(address token) external view returns (uint256);
    /// @notice Returns stock output after the buy spread, rounded down.
    function quoteBuy(address token, uint256 usdcIn) external view returns (uint256);
    /// @notice Returns USDC output after the sell spread, rounded down.
    function quoteSell(address token, uint256 tokenIn) external view returns (uint256);
    /// @notice Returns the holding period applied to new investments.
    function holdSeconds() external view returns (uint256);
    /// @notice Registers a fund for exchange hold exemption; trusted factory only.
    function registerFund(address fund) external;
    /// @notice Returns the stock's price timestamp.
    function lastUpdated(address token) external view returns (uint256);
    /// @notice Returns whether the token is permanently listed.
    function isListed(address token) external view returns (bool);
}

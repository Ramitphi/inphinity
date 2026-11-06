// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReceiverTemplate} from "./ReceiverTemplate.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IStockVenue} from "./interfaces/IStockVenue.sol";

/// @notice Curated mock stock venue with funded USDC redemptions and authenticated CRE pricing.
contract StockExchange is IStockVenue, ReceiverTemplate, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Stock {
        address token;
        string name;
        string symbol;
        uint256 price;
        uint64 updatedAt;
        bool listed;
    }
    struct StockInfo {
        address token;
        string name;
        string symbol;
        uint256 price;
        uint256 updatedAt;
    }
    enum PriceSource { Admin, Feed }

    address public immutable override usdc;
    PriceSource public priceSource;
    uint256 public maxPriceAge = 96 hours;
    uint256 public maxMoveBps = 500;
    uint256 public spreadBps = 50;
    uint256 public override holdSeconds = 600;
    address public trustedFactory;
    mapping(address => bool) public registeredFunds;
    mapping(address => mapping(address => uint256)) public lastBuyTime;
    /// @notice Block time at which the most recent valid feed report was accepted.
    uint256 public lastReportAt;
    address[] private _tokens;
    mapping(address => Stock) private _stocks;
    mapping(bytes32 => bool) private _symbols;

    error InvalidAddress();
    error InvalidArrayLength();
    error InvalidPrice();
    error InvalidSymbol();
    error DuplicateSymbol();
    error StockLimit();
    error UnlistedStock(address token);
    error StalePrice(address token, uint256 updatedAt);
    error PriceMoveExceeded(address token, uint256 previousPrice, uint256 nextPrice);
    error WrongPriceSource();
    error WorkflowIdentityRequired();
    error InvalidTimestamp();
    error InvalidConfiguration();
    error InvalidAmount();
    error SlippageExceeded();
    error InsufficientReserve(uint256 available, uint256 required);
    error HoldActive(uint256 unlockAt);
    error OnlyTrustedFactory();

    event StockListed(address indexed token, string name, string symbol, uint256 initialPrice);
    event PricesUpdated(address[] tokens, uint256[] prices, uint64 timestamp);
    event ReportIgnored();
    event PriceSourceUpdated(PriceSource source);
    event MaxPriceAgeUpdated(uint256 age);
    event MaxMoveBpsUpdated(uint256 bps);
    event SpreadBpsUpdated(uint256 bps);
    event HoldSecondsUpdated(uint256 seconds_);
    event TrustedFactoryUpdated(address indexed factory);
    event FundRegistered(address indexed fund);
    event Bought(address indexed buyer, address indexed token, uint256 usdcIn, uint256 tokensOut);
    event Sold(address indexed seller, address indexed token, uint256 tokensIn, uint256 usdcOut);

    constructor(address initialOwner, address usdc_, address forwarder)
        ReceiverTemplate(initialOwner, forwarder)
    {
        if (usdc_ == address(0) || usdc_.code.length == 0) revert InvalidAddress();
        usdc = usdc_;
    }

    /// @dev Ownership transfers are two-step (propose, then accept by the new owner).
    function transferOwnership(address newOwner) public virtual override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }

    /// @notice Permanently lists a newly deployed mock stock (at most 50 total).
    function listStock(string calldata name, string calldata symbol, uint256 initialPrice)
        external onlyOwner returns (address)
    {
        return _listStock(name, symbol, initialPrice);
    }

    function _listStock(string memory name, string memory symbol, uint256 initialPrice)
        private returns (address token)
    {
        if (_tokens.length >= 50) revert StockLimit();
        if (initialPrice == 0) revert InvalidPrice();
        if (bytes(symbol).length == 0 || bytes(symbol).length > 32 || bytes(name).length > 128) {
            revert InvalidSymbol();
        }
        bytes32 key = keccak256(bytes(symbol));
        if (_symbols[key]) revert DuplicateSymbol();
        _symbols[key] = true;
        token = address(new StockToken(name, symbol, address(this)));
        _stocks[token] = Stock(token, name, symbol, initialPrice, uint64(block.timestamp), true);
        _tokens.push(token);
        emit StockListed(token, name, symbol, initialPrice);
    }

    /// @notice Switches between owner prices and authenticated feed reports.
    function setPriceSource(PriceSource source) external onlyOwner {
        if (source == PriceSource.Feed && !_hasWorkflowIdentity()) revert WorkflowIdentityRequired();
        priceSource = source;
        emit PriceSourceUpdated(source);
    }

    function _afterIdentityChange() internal view override {
        if (priceSource == PriceSource.Feed && !_hasWorkflowIdentity()) revert WorkflowIdentityRequired();
    }

    /// @notice Sets the allowed per-update price movement, default 5%, at most 50%.
    function setMaxMoveBps(uint256 bps) external onlyOwner {
        if (bps > 5000) revert InvalidConfiguration();
        maxMoveBps = bps;
        emit MaxMoveBpsUpdated(bps);
    }

    /// @notice Sets the execution spread, at most 2%; spread USDC remains in the reserve.
    function setSpreadBps(uint256 bps) external onlyOwner {
        if (bps > 200) revert InvalidConfiguration();
        spreadBps = bps;
        emit SpreadBpsUpdated(bps);
    }

    /// @notice Sets the holding period, at most one hour.
    function setHoldSeconds(uint256 seconds_) external onlyOwner {
        if (seconds_ > 3600) revert InvalidConfiguration();
        holdSeconds = seconds_;
        emit HoldSecondsUpdated(seconds_);
    }

    /// @notice Authorizes the factory to exempt its funds from the exchange holding period.
    function setTrustedFactory(address factory) external onlyOwner {
        if (factory != address(0) && factory.code.length == 0) revert InvalidAddress();
        trustedFactory = factory;
        emit TrustedFactoryUpdated(factory);
    }

    /// @inheritdoc IStockVenue
    function registerFund(address fund) external override {
        if (msg.sender != trustedFactory) revert OnlyTrustedFactory();
        if (fund == address(0) || fund.code.length == 0) revert InvalidAddress();
        registeredFunds[fund] = true;
        emit FundRegistered(fund);
    }

    /// @notice Sets the price lifetime, at least one hour.
    function setMaxPriceAge(uint256 age) external onlyOwner {
        if (age < 1 hours) revert InvalidConfiguration();
        maxPriceAge = age;
        emit MaxPriceAgeUpdated(age);
    }

    /// @notice Updates or refreshes one price in Admin mode, subject to the move cap.
    function setPrice(address token, uint256 nextPrice) external onlyOwner {
        if (priceSource != PriceSource.Admin) revert WrongPriceSource();
        _updatePrice(token, nextPrice, uint64(block.timestamp), false);
        address[] memory tokens = new address[](1);
        uint256[] memory prices = new uint256[](1);
        tokens[0] = token;
        prices[0] = nextPrice;
        emit PricesUpdated(tokens, prices, uint64(block.timestamp));
    }

    /// @notice Atomically updates up to 50 distinct stock prices in Admin mode.
    function setPrices(address[] calldata tokens, uint256[] calldata prices) external onlyOwner {
        if (priceSource != PriceSource.Admin) revert WrongPriceSource();
        _validateBatch(tokens, prices);
        for (uint256 i; i < tokens.length; ++i) {
            _updatePrice(tokens[i], prices[i], uint64(block.timestamp), false);
        }
        emit PricesUpdated(tokens, prices, uint64(block.timestamp));
    }

    function _validateBatch(address[] memory tokens, uint256[] memory prices) private pure {
        if (tokens.length == 0 || tokens.length > 50 || tokens.length != prices.length) {
            revert InvalidArrayLength();
        }
        // A duplicate could otherwise compound the move cap in a single batch.
        for (uint256 i; i < tokens.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (tokens[i] == tokens[j]) revert InvalidArrayLength();
            }
        }
    }

    function _updatePrice(address token, uint256 nextPrice, uint64 timestamp, bool feed) private {
        Stock storage stock = _stocks[token];
        if (!stock.listed) revert UnlistedStock(token);
        if (nextPrice == 0) revert InvalidPrice();
        if (feed && (timestamp <= stock.updatedAt || timestamp > block.timestamp)) revert InvalidTimestamp();
        uint256 difference = nextPrice > stock.price ? nextPrice - stock.price : stock.price - nextPrice;
        if (difference > Math.mulDiv(stock.price, maxMoveBps, 10000)) {
            revert PriceMoveExceeded(token, stock.price, nextPrice);
        }
        stock.price = nextPrice;
        stock.updatedAt = timestamp;
    }

    function _processReport(bytes calldata report) internal override {
        if (priceSource == PriceSource.Admin) {
            emit ReportIgnored();
            return;
        }
        // Maximum canonical ABI size for two 50-entry arrays and the timestamp.
        if (report.length > 3360) revert InvalidArrayLength();
        (address[] memory tokens, uint256[] memory prices, uint64 timestamp) =
            abi.decode(report, (address[], uint256[], uint64));
        _validateBatch(tokens, prices);
        for (uint256 i; i < tokens.length; ++i) _updatePrice(tokens[i], prices[i], timestamp, true);
        lastReportAt = block.timestamp;
        emit PricesUpdated(tokens, prices, timestamp);
    }

    /// @inheritdoc IStockVenue
    function price(address token) public view override returns (uint256) {
        Stock storage stock = _stocks[token];
        if (!stock.listed) revert UnlistedStock(token);
        if (block.timestamp - stock.updatedAt > maxPriceAge) revert StalePrice(token, stock.updatedAt);
        return stock.price;
    }

    /// @inheritdoc IStockVenue
    function midPrice(address token) public view override returns (uint256) {
        return price(token);
    }

    /// @inheritdoc IStockVenue
    function buyPrice(address token) public view override returns (uint256) {
        return Math.mulDiv(price(token), 10000 + spreadBps, 10000, Math.Rounding.Ceil);
    }

    /// @inheritdoc IStockVenue
    function sellPrice(address token) public view override returns (uint256) {
        return Math.mulDiv(price(token), 10000 - spreadBps, 10000);
    }

    /// @notice Quotes stock output, rounded down; rejects stale prices.
    function quoteBuy(address token, uint256 usdcIn) public view override returns (uint256) {
        return Math.mulDiv(usdcIn, 1e18, buyPrice(token));
    }

    /// @notice Quotes USDC output, rounded down; rejects stale prices.
    function quoteSell(address token, uint256 tokenIn) public view override returns (uint256) {
        return Math.mulDiv(tokenIn, sellPrice(token), 1e18);
    }

    /// @inheritdoc IStockVenue
    function buy(address token, uint256 usdcIn, uint256 minTokensOut)
        external override nonReentrant returns (uint256 tokensOut)
    {
        if (usdcIn == 0) revert InvalidAmount();
        tokensOut = quoteBuy(token, usdcIn);
        if (tokensOut == 0 || tokensOut < minTokensOut) revert SlippageExceeded();
        lastBuyTime[msg.sender][token] = block.timestamp;
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcIn);
        StockToken(token).mint(msg.sender, tokensOut);
        emit Bought(msg.sender, token, usdcIn, tokensOut);
    }

    /// @inheritdoc IStockVenue
    function sell(address token, uint256 tokenIn, uint256 minUsdcOut)
        external override nonReentrant returns (uint256 usdcOut)
    {
        if (tokenIn == 0) revert InvalidAmount();
        // Address-local only: transferring stocks to a fresh address can bypass this hold.
        // Spread, move cap and holds reduce observable-update arbitrage, not eliminate it.
        uint256 boughtAt = lastBuyTime[msg.sender][token];
        uint256 unlockAt = boughtAt + holdSeconds;
        if (!registeredFunds[msg.sender] && boughtAt != 0 && block.timestamp < unlockAt) {
            revert HoldActive(unlockAt);
        }
        usdcOut = quoteSell(token, tokenIn);
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
        uint256 available = reserveBalance();
        if (available < usdcOut) revert InsufficientReserve(available, usdcOut);
        StockToken(token).burn(msg.sender, tokenIn);
        IERC20(usdc).safeTransfer(msg.sender, usdcOut);
        emit Sold(msg.sender, token, tokenIn, usdcOut);
    }

    /// @notice Returns the permanent registry length.
    function stockCount() external view returns (uint256) { return _tokens.length; }
    /// @notice Returns the token at the given registry index.
    function stockAt(uint256 index) external view returns (address) { return _tokens[index]; }
    /// @notice Returns raw prices and timestamps, even when stale.
    function getStocks() external view returns (StockInfo[] memory result) {
        result = new StockInfo[](_tokens.length);
        for (uint256 i; i < result.length; ++i) {
            Stock storage s = _stocks[_tokens[i]];
            result[i] = StockInfo(s.token, s.name, s.symbol, s.price, s.updatedAt);
        }
    }
    /// @notice Returns an unchecked-for-staleness price; unlisted stocks revert.
    function rawPrice(address token) external view returns (uint256) {
        if (!_stocks[token].listed) revert UnlistedStock(token);
        return _stocks[token].price;
    }
    /// @inheritdoc IStockVenue
    function isListed(address token) external view override returns (bool) { return _stocks[token].listed; }
    /// @inheritdoc IStockVenue
    function lastUpdated(address token) external view override returns (uint256) { return _stocks[token].updatedAt; }
    /// @notice Returns USDC available to pay redemptions; transfers can top this up directly.
    function reserveBalance() public view returns (uint256) { return IERC20(usdc).balanceOf(address(this)); }
}

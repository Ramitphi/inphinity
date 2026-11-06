// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStockVenue} from "./interfaces/IStockVenue.sol";

/// @notice Fixed-composition stock fund. USDC has six decimals; shares and stocks have 18.
/// @dev Stocks are wrapped CrossChainTokens held via exchange inventory.
/// Assumes a trusted venue with exact-transfer, non-rebasing settlement and stock tokens.
contract IndexFund is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable creator;
    uint16 public immutable feeBps;
    address public immutable venue;
    address public immutable usdc;
    address[] public tokens;
    uint16[] public weightsBps;
    uint256 public lastFeeAccrual;
    /// @notice Timestamp when an account's locked share bucket becomes redeemable.
    mapping(address => uint256) public unlockTime;
    /// @notice Stored locked quantity; use lockedSharesOf for the currently active lock.
    mapping(address => uint256) public lockedAmount;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant LOCKED_SHARES = 1000;
    uint256 private constant FEE_DENOMINATOR = 10000 * 365 days;

    error InvalidConfiguration();
    error InvalidAmount();
    error SlippageExceeded();
    error ZeroNAV();
    error FeePeriodTooLong();
    error LockedShares();
    error HoldActive(uint256 unlockAt);
    error NotConstituent(address token);

    event Invested(address indexed investor, uint256 usdcIn, uint256 shares);
    event InvestedInKind(
        address indexed investor, address indexed receiver, address[] tokens, uint256[] amounts, uint256 shares
    );
    event Redeemed(address indexed investor, uint256 shares, uint256 usdcOut);
    event FeeAccrued(address indexed creator, uint256 shares, uint256 timestamp);

    constructor(
        string memory name, string memory symbol, address venue_, address usdc_, address creator_,
        address[] memory tokens_, uint16[] memory weightsBps_, uint16 feeBps_
    ) ERC20(name, symbol) {
        if (venue_ == address(0) || usdc_ == address(0) || creator_ == address(0)
            || creator_ == DEAD || venue_.code.length == 0 || usdc_.code.length == 0
            || IStockVenue(venue_).usdc() != usdc_ || feeBps_ > 200
            || tokens_.length < 2 || tokens_.length > 10 || tokens_.length != weightsBps_.length) {
            revert InvalidConfiguration();
        }
        uint256 sum;
        for (uint256 i; i < tokens_.length; ++i) {
            if (weightsBps_[i] == 0 || !IStockVenue(venue_).isListed(tokens_[i]) || tokens_[i] == usdc_) {
                revert InvalidConfiguration();
            }
            for (uint256 j; j < i; ++j) {
                if (tokens_[i] == tokens_[j]) revert InvalidConfiguration();
            }
            sum += weightsBps_[i];
        }
        if (sum != 10000) revert InvalidConfiguration();
        venue = venue_;
        usdc = usdc_;
        creator = creator_;
        feeBps = feeBps_;
        tokens = tokens_;
        weightsBps = weightsBps_;
        lastFeeAccrual = block.timestamp;
    }

    /// @notice Buys the fixed-weight basket, then mints for net mid-price value at pre-deposit NAV.
    /// @dev First deposit mints receivedValue*1e12 total shares, with 1000 permanently locked.
    /// Only the investor's newly minted shares enter the timed lock bucket.
    function invest(uint256 usdcIn, uint256 minShares) external nonReentrant returns (uint256 shares) {
        if (usdcIn < 1e6) revert InvalidAmount();
        _accrueFee();
        uint256 supply = totalSupply();
        uint256 assets = nav(); // Checks every constituent price before accepting funds.
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcIn);
        uint256 allocated;
        for (uint256 i; i < tokens.length; ++i) {
            uint256 allocation = i == tokens.length - 1
                ? usdcIn - allocated : Math.mulDiv(usdcIn, weightsBps[i], 10000);
            allocated += allocation;
            IERC20(usdc).forceApprove(venue, allocation);
            IStockVenue(venue).buy(tokens[i], allocation, 0);
            IERC20(usdc).forceApprove(venue, 0);
        }
        // The mid-NAV increase includes only stocks received and any added idle cash,
        // so the investor, not existing holders, pays the execution spread.
        shares = _investmentShares(nav() - assets, supply, assets);
        if (shares == 0 || shares < minShares) revert SlippageExceeded();
        _addLock(msg.sender, shares, block.timestamp + IStockVenue(venue).holdSeconds());
        if (supply == 0) _mint(DEAD, LOCKED_SHARES);
        _mint(msg.sender, shares);
        emit Invested(msg.sender, usdcIn, shares);
    }

    /// @notice Deposits approved wrapped stocks at mid-NAV and mints shares to the receiver.
    /// @dev Accepts a subset of constituents; does not rebalance the basket to its target weights.
    /// Only newly minted shares are locked; the receiver's existing free shares stay free.
    function investInKind(address[] calldata tokens_, uint256[] calldata amounts, uint256 minShares, address receiver)
        external nonReentrant returns (uint256 shares)
    {
        if (receiver == address(0) || receiver == DEAD) revert InvalidConfiguration();
        if (tokens_.length == 0 || tokens_.length != amounts.length || tokens_.length > tokens.length) {
            revert InvalidAmount();
        }
        for (uint256 i; i < tokens_.length; ++i) {
            if (amounts[i] == 0) revert InvalidAmount();
            bool constituent;
            for (uint256 j; j < tokens.length; ++j) {
                if (tokens_[i] == tokens[j]) {
                    constituent = true;
                    break;
                }
            }
            if (!constituent) revert NotConstituent(tokens_[i]);
            for (uint256 j; j < i; ++j) {
                if (tokens_[i] == tokens_[j]) revert InvalidAmount();
            }
        }
        _accrueFee();
        uint256 supply = totalSupply();
        uint256 assets = nav(); // Checks every constituent price before accepting stocks.
        for (uint256 i; i < tokens_.length; ++i) {
            IERC20 token = IERC20(tokens_[i]);
            uint256 beforeBalance = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amounts[i]);
            uint256 afterBalance = token.balanceOf(address(this));
            if (afterBalance < beforeBalance || afterBalance - beforeBalance != amounts[i]) revert InvalidAmount();
        }
        // Match nav() rounding per holding rather than rounding each deposited amount in isolation.
        uint256 value = nav() - assets;
        if (value < 1e6) revert InvalidAmount();
        shares = _investmentShares(value, supply, assets);
        if (shares == 0 || shares < minShares) revert SlippageExceeded();
        _addLock(receiver, shares, block.timestamp + IStockVenue(venue).holdSeconds());
        if (supply == 0) _mint(DEAD, LOCKED_SHARES);
        _mint(receiver, shares);
        emit InvestedInKind(msg.sender, receiver, tokens_, amounts, shares);
    }

    /// @notice Burns free shares after fee accrual, sells the pro-rata basket and pays its idle cash slice.
    function redeem(uint256 shares, uint256 minUsdcOut) external nonReentrant returns (uint256 usdcOut) {
        if (shares == 0) revert InvalidAmount();
        uint256 free = balanceOf(msg.sender) - lockedSharesOf(msg.sender);
        if (shares > free) revert HoldActive(unlockTime[msg.sender]);
        _accrueFee();
        // Validate the full basket, even where the pro-rata quantity rounds to zero.
        nav();
        uint256 supply = totalSupply();
        usdcOut = Math.mulDiv(idleUsdc(), shares, supply);
        _burn(msg.sender, shares);
        for (uint256 i; i < tokens.length; ++i) {
            uint256 amount = Math.mulDiv(IERC20(tokens[i]).balanceOf(address(this)), shares, supply);
            if (amount != 0) {
                IERC20(tokens[i]).forceApprove(venue, amount);
                usdcOut += IStockVenue(venue).sell(tokens[i], amount, 0);
                IERC20(tokens[i]).forceApprove(venue, 0);
            }
        }
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
        IERC20(usdc).safeTransfer(msg.sender, usdcOut);
        emit Redeemed(msg.sender, shares, usdcOut);
    }

    /// @notice Permissionlessly settles the management fee as creator dilution shares.
    function collectFee() external nonReentrant { _accrueFee(); }

    function _pendingFee(uint256 supply) private view returns (uint256) {
        if (supply == 0 || feeBps == 0) return 0;
        uint256 elapsed = block.timestamp - lastFeeAccrual;
        uint256 numerator = uint256(feeBps) * elapsed;
        // The requested linear fraction formula is defined only for f < 1.
        if (numerator >= FEE_DENOMINATOR) revert FeePeriodTooLong();
        return Math.mulDiv(supply, numerator, FEE_DENOMINATOR - numerator);
    }

    function _accrueFee() private {
        uint256 supply = totalSupply();
        uint256 feeShares = _pendingFee(supply);
        // Do not let repeated calls erase sub-wei fee accrual.
        if (feeShares == 0 && supply != 0 && feeBps != 0) return;
        lastFeeAccrual = block.timestamp;
        if (feeShares != 0) {
            _mint(creator, feeShares);
            emit FeeAccrued(creator, feeShares, block.timestamp);
        }
    }

    function _investmentShares(uint256 amount, uint256 supply, uint256 assets) private pure returns (uint256) {
        if (supply == 0) return amount * 1e12 - LOCKED_SHARES;
        if (assets == 0) revert ZeroNAV();
        return Math.mulDiv(amount, supply, assets);
    }

    /// @notice Returns checked NAV in USDC base units, including idle USDC.
    function nav() public view returns (uint256 assets) {
        assets = idleUsdc();
        for (uint256 i; i < tokens.length; ++i) {
            assets += Math.mulDiv(IERC20(tokens[i]).balanceOf(address(this)), IStockVenue(venue).price(tokens[i]), 1e18);
        }
    }

    /// @notice Returns checked NAV per 1e18 outstanding shares; zero supply returns 1e6.
    /// @dev Uses actual supply; preview functions additionally account for pending fee shares.
    function navPerShare() external view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? 1e6 : Math.mulDiv(nav(), 1e18, supply);
    }

    /// @notice Estimates user shares at current checked NAV, including pending fees and the first-deposit lock.
    function previewInvest(uint256 usdcIn) external view returns (uint256 shares) {
        if (usdcIn < 1e6) revert InvalidAmount();
        uint256 supply = totalSupply();
        uint256 assets = nav();
        uint256 allocated;
        uint256 receivedValue;
        for (uint256 i; i < tokens.length; ++i) {
            uint256 allocation = i == tokens.length - 1
                ? usdcIn - allocated : Math.mulDiv(usdcIn, weightsBps[i], 10000);
            allocated += allocation;
            uint256 tokensOut = IStockVenue(venue).quoteBuy(tokens[i], allocation);
            if (tokensOut == 0) revert SlippageExceeded();
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            uint256 mid = IStockVenue(venue).price(tokens[i]);
            // Match the executed NAV delta, including per-holding valuation rounding.
            receivedValue += Math.mulDiv(balance + tokensOut, mid, 1e18)
                - Math.mulDiv(balance, mid, 1e18);
        }
        receivedValue += usdcIn - allocated;
        return _investmentShares(receivedValue, supply + _pendingFee(supply), assets);
    }

    /// @notice Estimates a rounded-down pro-rata liquidation at sell prices, including pending fees.
    /// @dev Does not check caller free shares or guarantee venue liquidity or future execution prices.
    function previewRedeem(uint256 shares) external view returns (uint256 usdcOut) {
        uint256 supply = totalSupply();
        supply += _pendingFee(supply);
        if (shares == 0 || shares > supply) revert InvalidAmount();
        usdcOut = Math.mulDiv(idleUsdc(), shares, supply);
        for (uint256 i; i < tokens.length; ++i) {
            uint256 amount = Math.mulDiv(IERC20(tokens[i]).balanceOf(address(this)), shares, supply);
            usdcOut += IStockVenue(venue).quoteSell(tokens[i], amount);
        }
    }

    /// @notice Returns the immutable basket with current raw balances.
    function holdings() external view returns (address[] memory, uint256[] memory balances, uint16[] memory) {
        balances = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) balances[i] = IERC20(tokens[i]).balanceOf(address(this));
        return (tokens, balances, weightsBps);
    }
    /// @notice Returns idle six-decimal USDC.
    function idleUsdc() public view returns (uint256) { return IERC20(usdc).balanceOf(address(this)); }
    /// @notice Returns the immutable token list.
    function getTokens() external view returns (address[] memory) { return tokens; }
    /// @notice Returns the immutable weights in basis points.
    function getWeights() external view returns (uint16[] memory) { return weightsBps; }

    /// @notice Returns the account's currently locked shares, capped at its balance.
    function lockedSharesOf(address a) public view returns (uint256) {
        return block.timestamp < unlockTime[a] ? Math.min(lockedAmount[a], balanceOf(a)) : 0;
    }

    /// @dev Adds only the supplied quantity; expired buckets are replaced, not revived.
    /// Active locked quantities share the later expiry without locking any free shares.
    function _addLock(address a, uint256 amount, uint256 until) private {
        if (amount == 0 || until <= block.timestamp) return;
        if (block.timestamp >= unlockTime[a]) {
            lockedAmount[a] = amount;
            unlockTime[a] = until;
        } else {
            lockedAmount[a] += amount;
            unlockTime[a] = Math.max(unlockTime[a], until);
        }
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == DEAD) revert LockedShares();
        // Spend free shares first; locked shares remain transferable, including SIP forwarding.
        // Move only their locked quantity using pre-transfer balances. Mints and burns skip this.
        if (amount != 0 && from != address(0) && to != address(0)) {
            uint256 locked = lockedSharesOf(from);
            uint256 free = balanceOf(from) - locked;
            uint256 moved = amount > free ? amount - free : 0;
            if (moved != 0) {
                if (block.timestamp < unlockTime[from]) {
                    lockedAmount[from] -= Math.min(lockedAmount[from], moved);
                }
                _addLock(to, moved, unlockTime[from]);
            }
        }
        super._update(from, to, amount);
    }
}

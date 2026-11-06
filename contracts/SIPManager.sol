// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IndexFactory} from "./IndexFactory.sol";
import {IndexFund} from "./IndexFund.sol";

/// @notice Pull-funded recurring investments. No keeper or prefunded custody is provided.
contract SIPManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SIP {
        address owner;
        address fund;
        uint256 amount;
        uint32 interval;
        uint32 maxInstallments;
        uint32 done;
        uint64 nextDue;
        uint8 failures;
        uint8 status;
        uint256 invested;
    }
    address public immutable usdc;
    address public immutable factory;
    SIP[] private _sips;
    mapping(address => uint256[]) private _byOwner;
    mapping(address => uint256) public activeSIPs;
    uint256 private constant MAX_BATCH = 50;
    /// @dev Minimum gas guaranteed to each isolated installment by the EIP-150 budget check.
    uint256 private constant INSTALLMENT_GAS = 3_000_000;

    error InvalidConfiguration();
    error InvalidSIP();
    error InvalidAmount();
    error InvalidInterval();
    error ActiveLimit();
    error NotSIPOwner();
    error InvalidStatus();
    error NotDue();
    error OnlySelf();
    error BatchTooLarge();
    error NoSharesReceived();
    error InsufficientGas();

    event SIPCreated(uint256 indexed id, address indexed owner, address indexed fund, uint256 amount,
        uint32 interval, uint32 maxInstallments, uint64 nextDue);
    event SIPExecuted(uint256 indexed id, uint32 installment, uint256 amount, uint256 shares, uint64 nextDue);
    event SIPFailed(uint256 indexed id, uint8 consecutiveFailures);
    event SIPPaused(uint256 indexed id);
    event SIPResumed(uint256 indexed id, uint64 nextDue);
    event SIPCancelled(uint256 indexed id);

    constructor(address usdc_, address factory_) {
        if (usdc_ == address(0) || factory_ == address(0) || usdc_.code.length == 0
            || factory_.code.length == 0 || IndexFactory(factory_).usdc() != usdc_) revert InvalidConfiguration();
        usdc = usdc_;
        factory = factory_;
    }

    /// @notice Creates a SIP; maxInstallments=0 is open-ended. An immediate installment must succeed.
    function createSIP(address fund, uint256 amount, uint32 interval, uint32 maxInstallments, bool startNow)
        external nonReentrant returns (uint256 id)
    {
        if (!IndexFactory(factory).isIndex(fund)) revert InvalidSIP();
        if (amount < 1e6) revert InvalidAmount();
        if (interval != 300 && interval != 86400 && interval != 604800 && interval != 2592000) {
            revert InvalidInterval();
        }
        if (activeSIPs[msg.sender] >= 20) revert ActiveLimit();
        id = _sips.length;
        uint64 due = uint64(block.timestamp + (startNow ? 0 : interval));
        _sips.push(SIP(msg.sender, fund, amount, interval, maxInstallments, 0, due, 0, 0, 0));
        _byOwner[msg.sender].push(id);
        ++activeSIPs[msg.sender];
        emit SIPCreated(id, msg.sender, fund, amount, interval, maxInstallments, due);
        if (startNow) _run(id);
    }

    /// @notice Attempts one due installment. Investment failures are recorded rather than propagated.
    function executeSIP(uint256 id) external nonReentrant {
        if (gasleft() < (INSTALLMENT_GAS * 64) / 63 + 100_000) revert InsufficientGas();
        _requireDue(id);
        _attempt(id);
    }

    /// @notice Attempts up to 50 SIPs, skipping invalid/not-due IDs and isolating investment failures.
    function executeDue(uint256[] calldata ids) external nonReentrant {
        if (ids.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < ids.length; ++i) {
            if (gasleft() < (INSTALLMENT_GAS * 64) / 63 + 100_000) revert InsufficientGas();
            if (isDue(ids[i])) _attempt(ids[i]);
        }
    }

    function _attempt(uint256 id) private {
        if (gasleft() < (INSTALLMENT_GAS * 64) / 63 + 100_000) revert InsufficientGas();
        try this.executeInstallment(id) {} catch {
            SIP storage sip = _sips[id];
            ++sip.failures;
            // Rate-limit failures: anyone can execute, so immediate retries must not force a pause.
            sip.nextDue = uint64(block.timestamp + sip.interval);
            emit SIPFailed(id, sip.failures);
            if (sip.failures >= 3) {
                sip.status = 1;
                --activeSIPs[sip.owner];
                emit SIPPaused(id);
            }
        }
    }

    /// @notice Isolated batch execution entry point; only the guarded outer functions may invoke it.
    /// @dev Intentionally not nonReentrant: it runs within the outer function's guard.
    function executeInstallment(uint256 id) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _run(id);
    }

    function _run(uint256 id) private {
        _requireDue(id);
        SIP storage sip = _sips[id];
        ++sip.done;
        sip.invested += sip.amount;
        sip.failures = 0;
        sip.nextDue = uint64(block.timestamp + sip.interval);
        if ((sip.maxInstallments != 0 && sip.done >= sip.maxInstallments) || sip.done == type(uint32).max) {
            sip.status = 3;
            --activeSIPs[sip.owner];
        }
        uint256 beforeShares = IERC20(sip.fund).balanceOf(address(this));
        IERC20(usdc).safeTransferFrom(sip.owner, address(this), sip.amount);
        IERC20(usdc).forceApprove(sip.fund, sip.amount);
        IndexFund(sip.fund).invest(sip.amount, 0);
        IERC20(usdc).forceApprove(sip.fund, 0);
        uint256 shares = IERC20(sip.fund).balanceOf(address(this)) - beforeShares;
        if (shares == 0) revert NoSharesReceived();
        IERC20(sip.fund).safeTransfer(sip.owner, shares);
        emit SIPExecuted(id, sip.done, sip.amount, shares, sip.nextDue);
    }

    /// @notice Pauses an active SIP; only its owner may call.
    function pause(uint256 id) external nonReentrant {
        SIP storage sip = _owned(id);
        if (sip.status != 0) revert InvalidStatus();
        sip.status = 1;
        --activeSIPs[sip.owner];
        emit SIPPaused(id);
    }

    /// @notice Resumes a paused SIP, resetting failures and scheduling the next run one interval from now.
    function resume(uint256 id) external nonReentrant {
        SIP storage sip = _owned(id);
        if (sip.status != 1) revert InvalidStatus();
        if (activeSIPs[sip.owner] >= 20) revert ActiveLimit();
        sip.status = 0;
        sip.failures = 0;
        sip.nextDue = uint64(block.timestamp + sip.interval);
        ++activeSIPs[sip.owner];
        emit SIPResumed(id, sip.nextDue);
    }

    /// @notice Permanently cancels an active or paused SIP; token allowance can be revoked separately.
    function cancel(uint256 id) external nonReentrant {
        SIP storage sip = _owned(id);
        if (sip.status > 1) revert InvalidStatus();
        if (sip.status == 0) --activeSIPs[sip.owner];
        sip.status = 2;
        emit SIPCancelled(id);
    }

    function _owned(uint256 id) private view returns (SIP storage sip) {
        if (id >= _sips.length) revert InvalidSIP();
        sip = _sips[id];
        if (sip.owner != msg.sender) revert NotSIPOwner();
    }

    function _requireDue(uint256 id) private view {
        if (id >= _sips.length) revert InvalidSIP();
        if (!isDue(id)) revert NotDue();
    }

    /// @notice Returns SIP details; status 0=Active, 1=Paused, 2=Cancelled, 3=Completed.
    function getSIP(uint256 id) external view returns (SIP memory) {
        if (id >= _sips.length) revert InvalidSIP();
        return _sips[id];
    }
    /// @notice Returns the total number of SIPs ever created (IDs start at zero).
    function sipCount() external view returns (uint256) { return _sips.length; }
    /// @notice Returns all historical IDs for an owner; intended for offchain reads.
    function sipsByOwner(address owner) external view returns (uint256[] memory) { return _byOwner[owner]; }
    /// @notice Returns false for nonexistent or nonactive SIPs, otherwise checks their schedule.
    function isDue(uint256 id) public view returns (bool) {
        if (id >= _sips.length) return false;
        SIP storage sip = _sips[id];
        return sip.status == 0 && block.timestamp >= sip.nextDue;
    }
}

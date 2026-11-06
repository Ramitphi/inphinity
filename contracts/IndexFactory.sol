// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStockVenue} from "./interfaces/IStockVenue.sol";
import {IIndexRegistrar} from "./interfaces/IIndexRegistrar.sol";
import {IndexFund} from "./IndexFund.sol";

/// @notice Permissionless immutable fund creation with optional atomic name registration.
contract IndexFactory is Ownable, ReentrancyGuard {
    address public immutable venue;
    address public immutable usdc;
    address public registrar;
    address[] private _indexes;
    mapping(address => address[]) private _byCreator;
    mapping(address => bool) public isIndex;
    /// @notice ENS label => fund. Labels are unique on Arc so the Sepolia name can never clash.
    mapping(bytes32 => address) public fundByLabel;
    uint256 private constant MAX_PAGE = 100;

    error InvalidConfiguration();
    error InvalidBasket();
    error InvalidMetadata();
    error InvalidPageSize();
    error InvalidLabel();
    error LabelTaken(string label);
    event RegistrarUpdated(address indexed registrar);
    /// @dev The ENS relayer watches this event and publishes `<label>.<parent>` on Sepolia.
    event IndexCreated(
        address indexed fund, address indexed creator, string name, string symbol, string label, string description
    );

    constructor(address initialOwner, address venue_, address usdc_, address registrar_) Ownable(initialOwner) {
        if (venue_ == address(0) || usdc_ == address(0) || venue_.code.length == 0
            || usdc_.code.length == 0 || IStockVenue(venue_).usdc() != usdc_
            || (registrar_ != address(0) && registrar_.code.length == 0)) revert InvalidConfiguration();
        venue = venue_;
        usdc = usdc_;
        registrar = registrar_;
    }

    /// @notice Creates a validated fund; configured registrar failures roll back the whole transaction.
    /// @dev The label is the fund's ENS subname: 3 to 20 characters of a-z and 0-9, unique per factory.
    /// Metadata lengths are bounded.
    function createIndex(
        string memory name, string memory symbol, string memory label,
        address[] memory tokens, uint16[] memory weightsBps, uint16 feeBps, string memory description
    ) public nonReentrant returns (address fund) {
        _validateBasket(tokens, weightsBps, feeBps);
        if (bytes(name).length == 0 || bytes(name).length > 128
            || bytes(symbol).length == 0 || bytes(symbol).length > 32
            || bytes(description).length > 2048) revert InvalidMetadata();
        if (!isValidLabel(label)) revert InvalidLabel();
        bytes32 labelKey = keccak256(bytes(label));
        if (fundByLabel[labelKey] != address(0)) revert LabelTaken(label);
        address naming = registrar;
        fund = address(new IndexFund(name, symbol, venue, usdc, msg.sender, tokens, weightsBps, feeBps));
        IStockVenue(venue).registerFund(fund);
        isIndex[fund] = true;
        fundByLabel[labelKey] = fund;
        _indexes.push(fund);
        _byCreator[msg.sender].push(fund);
        if (naming != address(0)) IIndexRegistrar(naming).register(label, fund, msg.sender, description);
        emit IndexCreated(fund, msg.sender, name, symbol, label, description);
    }

    /// @notice Same rule as the ENS publisher on Sepolia: 3 to 20 characters, lowercase a-z and 0-9.
    function isValidLabel(string memory label) public pure returns (bool) {
        bytes memory value = bytes(label);
        if (value.length < 3 || value.length > 20) return false;
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39))) return false;
        }
        return true;
    }

    /// @notice True when the label is well-formed and no fund uses it yet.
    function isLabelAvailable(string memory label) external view returns (bool) {
        return isValidLabel(label) && fundByLabel[keccak256(bytes(label))] == address(0);
    }

    function _validateBasket(address[] memory tokens, uint16[] memory weights, uint16 fee) private view {
        if (tokens.length < 2 || tokens.length > 10 || tokens.length != weights.length || fee > 200) {
            revert InvalidBasket();
        }
        uint256 sum;
        for (uint256 i; i < tokens.length; ++i) {
            if (weights[i] == 0 || tokens[i] == usdc || !IStockVenue(venue).isListed(tokens[i])) {
                revert InvalidBasket();
            }
            for (uint256 j; j < i; ++j) if (tokens[i] == tokens[j]) revert InvalidBasket();
            sum += weights[i];
        }
        if (sum != 10000) revert InvalidBasket();
    }

    /// @notice Sets the registrar for future funds; zero disables naming.
    function setRegistrar(address registrar_) external onlyOwner nonReentrant {
        if (registrar_ != address(0) && registrar_.code.length == 0) revert InvalidConfiguration();
        registrar = registrar_;
        emit RegistrarUpdated(registrar_);
    }
    /// @notice Returns the number of registered funds.
    function indexCount() external view returns (uint256) { return _indexes.length; }
    /// @notice Returns the fund at the registry index.
    function indexAt(uint256 index) external view returns (address) { return _indexes[index]; }
    /// @notice Returns up to 100 funds; out-of-range offsets return an empty array.
    function getIndexes(uint256 offset, uint256 limit) external view returns (address[] memory result) {
        if (limit > MAX_PAGE) revert InvalidPageSize();
        uint256 count = offset >= _indexes.length ? 0 : _indexes.length - offset;
        if (count > limit) count = limit;
        result = new address[](count);
        for (uint256 i; i < count; ++i) result[i] = _indexes[offset + i];
    }
    /// @notice Returns all funds of a creator; intended for offchain reads, response size grows with usage.
    function indexesByCreator(address creator) external view returns (address[] memory) { return _byCreator[creator]; }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

/// @dev Test doubles that follow the authorization rules of ENSRegistry, NameWrapper and
/// PublicResolver (ensdomains/ens-contracts, staging) for the calls FundNamePublisher makes.
contract MockENSRegistry {
    struct Record { address owner; address resolver; uint64 ttl; }
    mapping(bytes32 => Record) internal records;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    constructor() { records[bytes32(0)].owner = msg.sender; }

    modifier authorised(bytes32 node) {
        address o = records[node].owner;
        require(o == msg.sender || isApprovedForAll[o][msg.sender], "ENS: unauthorised");
        _;
    }

    function owner(bytes32 node) external view returns (address) { return records[node].owner; }
    function resolver(bytes32 node) external view returns (address) { return records[node].resolver; }
    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }
    function setSubnodeOwner(bytes32 node, bytes32 label, address owner_) public authorised(node) returns (bytes32 sub) {
        sub = keccak256(abi.encodePacked(node, label));
        records[sub].owner = owner_;
    }
    function setSubnodeRecord(bytes32 node, bytes32 label, address owner_, address resolver_, uint64 ttl)
        external
    {
        bytes32 sub = setSubnodeOwner(node, label, owner_);
        records[sub].resolver = resolver_;
        records[sub].ttl = ttl;
    }
}

contract MockNameWrapper {
    MockENSRegistry public immutable ens;
    mapping(uint256 => address) internal owners;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    constructor(MockENSRegistry ens_) { ens = ens_; }

    function ownerOf(uint256 id) external view returns (address) { return owners[id]; }
    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }
    /// @dev Test helper standing in for wrapping a name the wrapper already owns in the registry.
    function mockWrap(bytes32 node, address owner_) external {
        require(ens.owner(node) == address(this), "wrapper must own node");
        owners[uint256(node)] = owner_;
    }
    function setSubnodeRecord(
        bytes32 parentNode, string calldata label, address owner_, address resolver_,
        uint64 ttl, uint32, uint64
    ) external returns (bytes32 node) {
        address parentOwner = owners[uint256(parentNode)];
        require(parentOwner == msg.sender || isApprovedForAll[parentOwner][msg.sender], "Unauthorised");
        bytes32 labelhash = keccak256(bytes(label));
        node = keccak256(abi.encodePacked(parentNode, labelhash));
        ens.setSubnodeRecord(parentNode, labelhash, address(this), resolver_, ttl);
        owners[uint256(node)] = owner_;
        if (owner_.code.length > 0) {
            bytes4 ret = IERC1155Receiver(owner_).onERC1155Received(msg.sender, address(0), uint256(node), 1, "");
            require(ret == IERC1155Receiver.onERC1155Received.selector, "ERC1155: rejected");
        }
    }
}

contract MockPublicResolver {
    MockENSRegistry public immutable ens;
    MockNameWrapper public immutable nameWrapper;
    mapping(bytes32 => mapping(string => string)) internal texts;
    mapping(bytes32 => mapping(uint256 => bytes)) internal addrs;

    constructor(MockENSRegistry ens_, MockNameWrapper wrapper_) { ens = ens_; nameWrapper = wrapper_; }

    modifier authorised(bytes32 node) {
        address o = ens.owner(node);
        if (o == address(nameWrapper)) o = nameWrapper.ownerOf(uint256(node));
        require(o == msg.sender, "Resolver: unauthorised");
        _;
    }

    function setText(bytes32 node, string calldata key, string calldata value) external authorised(node) {
        texts[node][key] = value;
    }
    function setAddr(bytes32 node, uint256 coinType, bytes calldata a) external authorised(node) {
        addrs[node][coinType] = a;
    }
    function text(bytes32 node, string calldata key) external view returns (string memory) { return texts[node][key]; }
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) { return addrs[node][coinType]; }

    function multicallWithNodeCheck(bytes32 nodehash, bytes[] calldata data) external returns (bytes[] memory results) {
        results = new bytes[](data.length);
        for (uint256 i; i < data.length; ++i) {
            require(bytes32(data[i][4:36]) == nodehash, "multicall: All records must have a matching namehash");
            (bool ok, bytes memory res) = address(this).delegatecall(data[i]);
            require(ok, "multicall: call failed");
            results[i] = res;
        }
    }
}

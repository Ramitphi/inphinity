// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Label rules shared by both sides of the CCIP bridge. Mirrors ens/src/lib.ts sanitizeLabel:
/// lowercase a-z, 0-9 and '-', 3 to 32 bytes, no leading/trailing '-', no "xx--" prefix.
library FundNameLib {
    /// @notice The CCIP message from Arc to Sepolia.
    struct FundMessage {
        string label; // already sanitized on Arc; the receiver re-checks and dedupes
        address fund;
        address creator;
        string name;
        string symbol;
        uint16 feeBps;
        string weights; // "tAAPL:3000,tMSFT:2500"
        string tokens; // checksummed addresses joined by ","
        uint256 index; // position in IndexFactory
    }

    /// @notice Returns a valid label from free text, or "" if none can be made.
    function sanitize(string memory input) internal pure returns (string memory) {
        bytes memory src = bytes(input);
        bytes memory out = new bytes(src.length);
        uint256 n;
        bool lastDash = true; // drops leading dashes
        for (uint256 i; i < src.length && n < 32; ++i) {
            bytes1 c = src[i];
            if (c >= "A" && c <= "Z") c = bytes1(uint8(c) + 32);
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
            if (ok) {
                out[n++] = c;
                lastDash = false;
            } else if (!lastDash) {
                out[n++] = "-";
                lastDash = true;
            }
        }
        while (n > 0 && out[n - 1] == "-") --n; // trailing dashes
        if (n < 3) return ""; // dashes are collapsed above, so an "xx--" prefix cannot occur
        assembly {
            mstore(out, n)
        }
        return string(out);
    }

    function isValid(string memory label) internal pure returns (bool) {
        return bytes(label).length > 0 && keccak256(bytes(sanitize(label))) == keccak256(bytes(label));
    }

    /// @notice `label` with "-n" appended (n >= 2), trimmed so the result stays within 32 bytes.
    function withSuffix(string memory label, uint256 n) internal pure returns (string memory) {
        if (n <= 1) return label;
        bytes memory suffix = abi.encodePacked("-", _toString(n));
        bytes memory b = bytes(label);
        uint256 keep = b.length + suffix.length > 32 ? 32 - suffix.length : b.length;
        while (keep > 0 && b[keep - 1] == "-") --keep;
        bytes memory head = new bytes(keep);
        for (uint256 i; i < keep; ++i) head[i] = b[i];
        return string(abi.encodePacked(head, suffix));
    }

    /// @notice DNS wire format of "<label>.<parent>.eth".
    function dnsName(string memory label, string memory parent) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(bytes(label).length), label, uint8(bytes(parent).length), parent, uint8(3), "eth", uint8(0)
        );
    }

    /// @notice namehash("<label>.<parent>.eth").
    function node(string memory label, string memory parent) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode(parent), keccak256(bytes(label))));
    }

    function parentNode(string memory parent) internal pure returns (bytes32) {
        bytes32 eth = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        return keccak256(abi.encodePacked(eth, keccak256(bytes(parent))));
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }
}

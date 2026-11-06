// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Payload carried by the CCIP message, and the label rules shared by sender and receiver.
/// @dev The label rules mirror ens/src/lib.ts `sanitizeLabel` so CCIP names and relayer names match:
///      lowercase a-z0-9 and '-', runs of other characters become one '-', no leading/trailing '-',
///      3 to 32 characters, never a reserved label. Non-ASCII input is treated as a separator
///      (the relayer NFKD-normalises first, so "é" may differ; fund symbols are ASCII in practice).
library FundLabel {
    /// @dev Everything the receiver needs, already formatted on Arc, so the Sepolia contract stays
    ///      small and cheap: it only registers `label` and writes `texts` verbatim.
    struct Payload {
        string label; // base label, sanitised (the receiver adds -2, -3, ... on collisions)
        string symbolLabel; // sanitised symbol for the <symbol>.inphinity.eth link, or ""
        address fund; // written as the Arc (ENSIP-11 coin type 2152525650) address record
        address creator; // owner of the name token
        uint32 index; // position in IndexFactory.indexAt(); orders latest.inphinity.eth
        Text[] texts; // the relayer's text records, same keys and formatting
    }

    struct Text {
        string key;
        string value;
    }

    uint256 internal constant MAX_LEN = 32;
    uint256 internal constant MIN_LEN = 3;

    /// @return out the sanitised label, or "" if `input` cannot become a valid label.
    function sanitize(string memory input) internal pure returns (string memory) {
        bytes memory b = bytes(input);
        bytes memory out = new bytes(b.length);
        uint256 n;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5a) c = bytes1(uint8(c) + 32); // A-Z -> a-z
            bool alnum = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
            if (alnum) {
                out[n++] = c;
            } else if (n > 0 && out[n - 1] != "-") {
                out[n++] = "-"; // any other run (including '-') collapses to one '-'; leading ones are dropped
            }
        }
        if (n > MAX_LEN) n = MAX_LEN;
        while (n > 0 && out[n - 1] == "-") --n;
        if (n < MIN_LEN) return "";
        if (n >= 4 && out[2] == "-" && out[3] == "-") return ""; // "xn--" style prefix (cannot happen after collapsing)
        assembly { mstore(out, n) }
        if (isReserved(out)) return "";
        return string(out);
    }

    /// @notice Labels the registry keeps as reserved entries (ens/src/lib.ts RESERVED_LABELS).
    function isReserved(bytes memory l) internal pure returns (bool) {
        bytes32 h = keccak256(l);
        return h == keccak256("latest") || h == keccak256("www") || h == keccak256("app")
            || h == keccak256("admin") || h == keccak256("official") || h == keccak256("support");
    }

    /// @notice `base` with a dedupe suffix (n = 1 -> no suffix, else "-n"), still at most 32 chars.
    function withSuffix(string memory base, uint256 n) internal pure returns (string memory) {
        if (n <= 1) return base;
        bytes memory suffix = abi.encodePacked("-", _uintToString(n));
        bytes memory b = bytes(base);
        uint256 keep = b.length;
        if (keep + suffix.length > MAX_LEN) keep = MAX_LEN - suffix.length;
        while (keep > 0 && b[keep - 1] == "-") --keep;
        bytes memory out = new bytes(keep);
        for (uint256 i; i < keep; ++i) out[i] = b[i];
        return string(abi.encodePacked(out, suffix));
    }

    function _uintToString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory buf = new bytes(78);
        uint256 i = buf.length;
        while (v != 0) {
            buf[--i] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        bytes memory out = new bytes(buf.length - i);
        for (uint256 j; j < out.length; ++j) out[j] = buf[i + j];
        return string(out);
    }
}

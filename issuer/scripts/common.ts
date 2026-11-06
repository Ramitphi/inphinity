// Shared setup for the issuer scripts: clients, CCTP addresses and the CrossChainTokenService ABI.
import { createPublicClient, createWalletClient, encodePacked, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, baseSepolia } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is not set (testnet-only deployer key)");
export const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// Circle CCTP for non-USDC assets: same CrossChainTokenService address on every testnet.
export const CCTS = "0x63753E722bd2C2A5DF6EE19C5106662208B81077" as const;
export const IRIS = "https://iris-api-sandbox.circle.com";
export const BASE_DOMAIN = 6; // home chain: the issuer's chain
export const ARC_DOMAIN = 26; // where Inphinity's funds live
export const FINALITY = 2000; // standard transfer

export const base = createPublicClient({ chain: baseSepolia, transport: http() });
export const baseWallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
export const arc = createPublicClient({ chain: arcTestnet, transport: http() });

export const ownerBytes = encodePacked(["address"], [account.address]);

// The mock issuer's stocks (US tickers, matching Arc Studio's plan). 18 decimals, like the Arc contracts expect.
export const STOCKS = [
  { name: "Mock Apple", symbol: "tAAPL" },
  { name: "Mock Microsoft", symbol: "tMSFT" },
  { name: "Mock NVIDIA", symbol: "tNVDA" },
  { name: "Mock Tesla", symbol: "tTSLA" },
  { name: "Mock Amazon", symbol: "tAMZN" },
  { name: "Mock Alphabet", symbol: "tGOOGL" },
  { name: "Mock Meta Platforms", symbol: "tMETA" },
  { name: "Mock SPDR S&P 500 ETF", symbol: "tSPY" },
] as const;
export const DECIMALS = 18;

const STATE = new URL("../deployments.json", import.meta.url);
export type TokenRecord = { symbol: string; name: string; tokenId: `0x${string}`; baseToken: `0x${string}`; arcToken: `0x${string}`; remoteSent?: boolean };
export function loadState(): Record<string, TokenRecord> {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
}
export function saveState(s: Record<string, TokenRecord>) {
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ask Circle's Iris API for a signed FORWARD quote, so Circle relays the message to the destination.
export async function forwardQuote(tokenId: string, from: number, to: number, body: object) {
  const res = await fetch(`${IRIS}/v2/quote/cctpx/${tokenId}/${from}/${to}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Iris quote failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { signedQuote: `0x${string}`; feeTotalAmount: string };
}

const params = [
  { name: "tokenManagerType", type: "uint8" },
  { name: "tokenManagerOwner", type: "bytes" },
  { name: "tokenManagerOperator", type: "bytes" },
  { name: "tokenOwner", type: "bytes" },
  { name: "tokenMinter", type: "bytes" },
  { name: "tokenManagerSettings", type: "tuple", components: [
    { name: "rateLimit", type: "uint256" },
    { name: "maxTransferAmount", type: "uint256" },
  ] },
] as const;
const claim = [
  { name: "signedQuote", type: "bytes" },
  { name: "refundAddress", type: "address" },
] as const;

export const cctsAbi = [
  { type: "event", name: "CrossChainTokenIdClaimed", inputs: [
    { name: "tokenId", type: "bytes32", indexed: true },
    { name: "tokenAddress", type: "address", indexed: true },
    { name: "deployer", type: "address", indexed: false },
    { name: "salt", type: "bytes32", indexed: false },
  ] },
  { name: "resolveTokenAddress", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }], outputs: [{ type: "address" }] },
  { name: "resolveTokenManager", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "bytes32" }], outputs: [{ type: "address" }] },
  { name: "deployCrossChainToken", type: "function", stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" }, { name: "name", type: "string" },
      { name: "symbol", type: "string" }, { name: "decimals", type: "uint8" },
      { name: "params", type: "tuple", components: params },
    ], outputs: [{ name: "tokenId", type: "bytes32" }] },
  { name: "deployRemoteCrossChainToken", type: "function", stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" }, { name: "destinationDomain", type: "uint32" },
      { name: "name", type: "string" }, { name: "symbol", type: "string" },
      { name: "decimals", type: "uint8" },
      { name: "params", type: "tuple", components: params },
      { name: "claim", type: "tuple", components: claim },
    ], outputs: [] },
  { name: "crossChainTransfer", type: "function", stateMutability: "payable",
    inputs: [
      { name: "tokenId", type: "bytes32" }, { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" }, { name: "destinationAddress", type: "bytes" },
      { name: "destinationCaller", type: "bytes32" }, { name: "minFinalityThreshold", type: "uint32" },
      { name: "claim", type: "tuple", components: claim },
      { name: "autoExecuteHookData", type: "bool" }, { name: "hookData", type: "bytes" },
    ], outputs: [] },
] as const;

export const erc20Abi = [
  { name: "mint", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

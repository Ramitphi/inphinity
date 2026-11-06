// Shared configuration for the Inphinity ENSv2 scripts.
//
// ENSv2 Sepolia addresses: github.com/ensdomains/contracts-v2, branch deploy/mainnet-v2-20261002,
// contracts/deployments/sepolia. This is the deployment the Universal Resolver 0xeEeE...EeEe and
// sepolia.app.ens.domains use today (checked onchain: the proxy's ROOT_REGISTRY is 0xB458...C43f).
// Older tags in that repo (sepolia-deployment-2026-06-29 / -09-15) are NOT live; do not use them.
// Arc addresses: contracts/contract-metadata/deployments.arc-testnet.json.
import { createPublicClient, createWalletClient, http, type Account, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";

export const PARENT_LABEL = process.env.ENS_PARENT_LABEL ?? "inphinity";
export const PARENT_NAME = `${PARENT_LABEL}.eth`;

/** ENSv2 on Sepolia (live deployment). */
export const ENS = {
  rootRegistry: "0xb458d6a3a77919449d03e7a6903c26827c1ec43f",
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  ethRegistrar: "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3",
  verifiableFactory: "0xda70306c98e97ece36f997a21368e53298572991",
  userRegistryImpl: "0x9bd8a88719068d09ecee662f36c0e3856708366a",
  permissionedResolverImpl: "0x115eb53f0c60696633855f90b138178fb40b2b2c",
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
} as const satisfies Record<string, Address>;

/** Stablecoins to try for the .eth registration, in order. register-parent.ts checks each onchain. */
export const PAYMENT_TOKENS: { name: string; address: Address }[] = [
  { name: "Circle Sepolia USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { name: "ENS MockUSDC (anyone can mint)", address: "0x240b0316df57887dbbe58b586508b19e633a14aa" },
  { name: "ENS MockDAI (anyone can mint)", address: "0xf6fac8a58a0be13b9197f27c41b73162fe32572b" },
];
/** ENS's Sepolia MockUSDC has a public mint(); used when no other token has enough balance. */
export const MINTABLE_USDC: Address = "0x240b0316df57887dbbe58b586508b19e633a14aa";

/** Inphinity on Arc Testnet. */
export const ARC = {
  chainId: 5042002,
  indexFactory: "0x9fa4034efb237a7c154adea20b1ccfa0cd538b11",
} as const;

/** ENSIP-11 coin type for Arc Testnet: 0x80000000 | 5042002. Coin type 60 is deliberately never set. */
export const ARC_COIN_TYPE = 0x80000000n | BigInt(ARC.chainId); // 2152525650n

export const TEAM_WALLET: Address = "0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93";

export const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
export const ARC_RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

/**
 * Where scripts remember what they deployed (committed to git). Re-runs read chain state first,
 * so this file is a convenience, not the source of truth.
 * ENS_STATE_FILE overrides it (the local fork test uses this so it never touches the real file).
 */
export const STATE_FILE = process.env.ENS_STATE_FILE ?? new URL("../deployments.sepolia.json", import.meta.url);

export const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

const transport = (url: string) => http(url, { timeout: 60_000, retryCount: 3 });
export const sepoliaClient = createPublicClient({ chain: sepolia, transport: transport(SEPOLIA_RPC_URL) });
export const arcClient = createPublicClient({ chain: arcTestnet, transport: transport(ARC_RPC_URL) });

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(SEPOLIA_RPC_URL);

/**
 * The signer. Normally a local account from PRIVATE_KEY.
 * FORK_IMPERSONATE=0x... (only with a localhost RPC) uses an impersonated node account instead,
 * so the fork test can act as the real team wallet without its key.
 * Returns null when neither is set (only allowed with --dry-run).
 */
export function loadAccount(): Account | Address | null {
  if (process.env.FORK_IMPERSONATE) {
    if (!isLocal) throw new Error("FORK_IMPERSONATE only works with a localhost SEPOLIA_RPC_URL.");
    return process.env.FORK_IMPERSONATE as Address;
  }
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    if (DRY_RUN) return null;
    throw new Error("PRIVATE_KEY is not set. Export it, or pass --dry-run to only simulate.");
  }
  return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
}

export function walletFor(account: Account | Address) {
  return createWalletClient({ account, chain: sepolia, transport: transport(SEPOLIA_RPC_URL) });
}

/** The address scripts read and simulate as: the signer if present, else the team wallet. */
export function actingAddress(account: Account | Address | null): Address {
  if (!account) return TEAM_WALLET;
  return typeof account === "string" ? account : account.address;
}

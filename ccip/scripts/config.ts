// Shared config for the Inphinity CCIP scripts (Arc Testnet -> Ethereum Sepolia).
//
// Every CCIP constant below was checked on 2026-11-06 against the CCIP Directory API
// (https://docs.chain.link/api/ccip/v1/chains and /lanes, environment=testnet) and onchain:
// Arc Router.typeAndVersion() = "Router 1.2.0", isChainSupported(Sepolia) = true,
// getOnRamp(Sepolia) = 0x0409822AC30A1A74fCE849E6163a86cF18fe1863 ("OnRamp 2.0.0").
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";

export const CCIP = {
  arc: {
    chainSelector: 3034092155422581607n,
    router: "0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8" as Address,
    onRamp: "0x0409822AC30A1A74fCE849E6163a86cF18fe1863" as Address,
  },
  sepolia: {
    chainSelector: 16015286601757825753n,
    router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59" as Address,
    // Router.getOffRamps() for Arc on Sepolia: OffRamp 2.0.0 (+ an older 1.6 OffRamp 0x0820...cE0).
    offRamp: "0xc6A246A9AcdAaE651708706494720F79C3E5d0A1" as Address,
  },
  api: "https://api.ccip.chain.link/v2",
  explorer: "https://ccip.chain.link/msg/",
} as const;

/** Inphinity on Arc (contracts/contract-metadata/deployments.arc-testnet.json). Not modified by us. */
export const ARC = { chainId: 5042002, indexFactory: "0x9fa4034efb237a7c154adea20b1ccfa0cd538b11" as Address } as const;

/** Inphinity ENSv2 on Sepolia (ens/deployments.sepolia.json, ens/src/config.ts). */
export const ENS = {
  parentLabel: "inphinity",
  ethRegistry: "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4" as Address,
  userRegistry: "0xefC414eb999907620AbdA991decD2BD22aBb9Ac1" as Address,
  resolver: "0x26E1611FD97133dfaef7b562D88528e8C1649ae2" as Address,
  universalResolver: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" as Address,
} as const;

export const TEAM_WALLET: Address = "0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93";

/**
 * Destination gas limit for ccipReceive on Sepolia. Measured with LIVE Sepolia gas pricing
 * (test/live-gas.ts, 2026-11-06): 3 tokens ~4.48M, 5 tokens ~5.03M, 10 tokens ~6.38M, worst case
 * (10 tokens, 128-char name, 32-char symbol) ~7.49M. A local Hardhat fork reports ~3x less, because
 * live Sepolia prices new storage at ~111k gas per slot. 10M leaves 33% headroom over the worst case;
 * the Arc -> Sepolia lane accepts up to ~14.36M, and the fee is ~0.53 USDC at 10M (0.51 at <=3M).
 */
export const DEFAULT_GAS_LIMIT = Number(process.env.CCIP_GAS_LIMIT ?? 10_000_000);

export const ARC_RPC_URL = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
export const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
export const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

const transport = (url: string) => http(url, { timeout: 60_000, retryCount: 3 });
export const arc = createPublicClient({ chain: arcTestnet, transport: transport(ARC_RPC_URL) }) as PublicClient;
export const sep = createPublicClient({ chain: sepolia, transport: transport(SEPOLIA_RPC_URL) }) as PublicClient;

// ---------------------------------------------------------------------------
// Artifacts and state
// ---------------------------------------------------------------------------

export function artifact(name: "FundNameSender" | "FundNameReceiver"): { abi: Abi; bytecode: Hex } {
  const p = new URL(`../out/${name}.json`, import.meta.url);
  if (!existsSync(p)) throw new Error(`out/${name}.json missing: run \`bun run build\` first.`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export type Deployments = {
  arc?: { sender?: Address; senderTx?: Hex };
  sepolia?: { receiver?: Address; receiverTx?: Hex; receiverSender?: Address };
};
/** CCIP_STATE_FILE overrides it (the fork test uses this so it never touches the real file). */
export const STATE_FILE = process.env.CCIP_STATE_FILE ?? new URL("../deployments.json", import.meta.url);
export const loadState = (): Deployments => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
export function saveState(s: Deployments) {
  if (!DRY_RUN) writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Signer: PRIVATE_KEY, or FORK_IMPERSONATE=0x... against a localhost fork. Null only in --dry-run.
// ---------------------------------------------------------------------------

const isLocal = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url);

export type Signer = { account: Account | Address | null; from: Address; wallet: ReturnType<typeof createWalletClient> | null; client: PublicClient; chain: Chain };

export function signerFor(which: "arc" | "sepolia"): Signer {
  const chain = which === "arc" ? arcTestnet : sepolia;
  const url = which === "arc" ? ARC_RPC_URL : SEPOLIA_RPC_URL;
  const client = which === "arc" ? arc : sep;
  let account: Account | Address | null = null;
  if (process.env.FORK_IMPERSONATE) {
    if (!isLocal(url)) throw new Error(`FORK_IMPERSONATE only works with a localhost ${which} RPC URL.`);
    account = process.env.FORK_IMPERSONATE as Address;
  } else if (process.env.PRIVATE_KEY) {
    const pk = process.env.PRIVATE_KEY;
    account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
  } else if (!DRY_RUN) {
    throw new Error("PRIVATE_KEY is not set. Export it, or pass --dry-run to only simulate.");
  }
  const from = !account ? TEAM_WALLET : typeof account === "string" ? account : account.address;
  const wallet = account ? createWalletClient({ account, chain, transport: transport(url) }) : null;
  return { account, from, wallet, client, chain };
}

/** Simulates as `from`, then (unless dry-run) sends and waits. Returns the receipt and simulated result. */
export async function send(
  s: Signer,
  what: string,
  req: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint },
) {
  let result: unknown;
  try {
    const sim = await s.client.simulateContract({ ...(req as any), account: s.account ?? s.from });
    result = sim.result;
  } catch (e) {
    const msg = explain(e);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${what}: simulation reverted: ${msg}`);
      return { result: undefined, hash: undefined, receipt: undefined };
    }
    throw new Error(`${what}: simulation reverted: ${msg}`);
  }
  if (DRY_RUN || !s.wallet) {
    console.log(`  [dry-run] ${what}: would call ${req.functionName} on ${req.address} (simulation ok)`);
    return { result, hash: undefined, receipt: undefined };
  }
  const hash = await s.wallet.writeContract({ ...(req as any), account: s.account!, chain: s.chain });
  const receipt = await s.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what}: tx ${hash} reverted`);
  console.log(`  ${what}: ${hash} (gas ${receipt.gasUsed})`);
  return { result, hash, receipt };
}

/** Deploys a contract (dry-run: estimates gas only). */
export async function deploy(s: Signer, name: "FundNameSender" | "FundNameReceiver", args: readonly unknown[]) {
  const { abi, bytecode } = artifact(name);
  if (DRY_RUN || !s.wallet) {
    const { encodeDeployData } = await import("viem");
    const data = encodeDeployData({ abi, bytecode, args });
    const gas = await s.client.estimateGas({ account: s.from, data }).catch((e) => `estimate failed: ${explain(e)}`);
    console.log(`  [dry-run] would deploy ${name} (${typeof gas === "bigint" ? `~${gas} gas` : gas})`);
    return { address: undefined as Address | undefined, hash: undefined as Hex | undefined };
  }
  const hash = await s.wallet.deployContract({ abi, bytecode, args, account: s.account!, chain: s.chain });
  const rc = await s.client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`deploy ${name}: tx ${hash} failed`);
  console.log(`  deployed ${name} at ${rc.contractAddress}: ${hash} (gas ${rc.gasUsed})`);
  return { address: rc.contractAddress, hash };
}

export async function hasCode(client: PublicClient, a?: Address) {
  if (!a) return false;
  const code = await client.getCode({ address: a });
  return !!code && code !== "0x";
}

export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const n = rev.data?.errorName;
      if (n) return `${n}(${(rev.data?.args ?? []).map(String).join(", ")})`;
      if (rev.signature) return `custom error ${rev.signature}`;
    }
    return e.shortMessage;
  }
  return String(e);
}

/** `--name value` or `--name=value` from argv. */
export function arg(name: string): string | undefined {
  const a = process.argv;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === `--${name}`) return a[i + 1];
    if (a[i].startsWith(`--${name}=`)) return a[i].slice(name.length + 3);
  }
  return undefined;
}

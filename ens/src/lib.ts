// Shared helpers: ENSv2 role bitmaps, DNS encoding, state file and a dry-run aware tx sender.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  BaseError,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  ContractFunctionRevertedError,
  bytesToHex,
  labelhash,
  stringToBytes,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
} from "viem";
import { DRY_RUN, STATE_FILE, loadAccount, walletFor, publicFor, actingAddress, type ChainName } from "./config";

// ---------------------------------------------------------------------------
// ENSv2 Enhanced Access Control role bitmaps.
// Copied from contracts-v2 RegistryRolesLib.sol and PermissionedResolverLib.sol.
// Each role is one nybble; its admin role sits 128 bits higher.
// ---------------------------------------------------------------------------
const admin = (r: bigint) => r << 128n;

export const RegistryRoles = {
  REGISTRAR: 1n << 0n,
  REGISTER_RESERVED: 1n << 4n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  CAN_TRANSFER_ADMIN: admin(1n << 28n),
  SET_URI: 1n << 36n,
  UPGRADE: 1n << 124n,
} as const;

/** Live PermissionedResolverLib (deploy/mainnet-v2-20261002). */
export const ResolverRoles = {
  SET_ADDRESS: 1n << 0n,
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  SET_ABI: 1n << 12n,
  SET_INTERFACE: 1n << 16n,
  SET_NAME: 1n << 20n,
  SET_DATA: 1n << 24n,
  LINK: 1n << 28n,
  UPGRADE: 1n << 124n,
} as const;

const withAdmins = (roles: bigint[]) => roles.reduce((acc, r) => acc | r | admin(r), 0n);

/**
 * Roles the team wallet holds on the ROOT_RESOURCE of the fund UserRegistry.
 * It is the operator: it registers fund names, renews them, can unregister a scam fund and can
 * repoint a name's resolver. Holding these root roles keeps the registry "unemancipated" in ENSv2
 * terms, which is deliberate: the registry is a curated index, not a marketplace.
 */
export const REGISTRY_OPERATOR_ROLES = withAdmins([
  RegistryRoles.REGISTRAR,
  RegistryRoles.REGISTER_RESERVED,
  RegistryRoles.SET_PARENT,
  RegistryRoles.UNREGISTER,
  RegistryRoles.RENEW,
  RegistryRoles.SET_SUBREGISTRY,
  RegistryRoles.SET_RESOLVER,
  RegistryRoles.SET_URI,
  RegistryRoles.UPGRADE,
]);

/**
 * Roles a fund creator gets on their own name token. Deliberately minimal:
 *  - no ROLE_SET_RESOLVER       -> cannot point the name at a resolver that lies about the fund address
 *  - no ROLE_SET_SUBREGISTRY    -> cannot hang look-alike names (official.<fund>.inphinity.eth) under it
 *  - no ROLE_CAN_TRANSFER_ADMIN -> the token cannot be transferred, so the ENS owner always equals
 *                                  the onchain IndexFund.creator()
 *  - ROLE_RENEW                 -> the one thing they can do is extend it
 */
export const CREATOR_TOKEN_ROLES = RegistryRoles.RENEW;

/**
 * Roles the team wallet holds on the ROOT_RESOURCE of the shared Permissioned Resolver.
 * Nobody else gets resolver roles: a role there is scoped to a record key or coin type, not to a
 * name, so a creator holding ROLE_SET_TEXT for "description" could edit every fund's description.
 */
export const RESOLVER_ADMIN_ROLES = withAdmins([
  ResolverRoles.SET_ADDRESS,
  ResolverRoles.SET_TEXT,
  ResolverRoles.SET_CONTENTHASH,
  ResolverRoles.SET_ABI,
  ResolverRoles.SET_INTERFACE,
  ResolverRoles.SET_NAME,
  ResolverRoles.SET_DATA,
  ResolverRoles.LINK,
  ResolverRoles.UPGRADE,
]);

/**
 * Minimal roles for a key that runs the CCIP fallback (src/fallback.ts), i.e. relayer.ts processFund:
 *  - UserRegistry ROLE_REGISTRAR: register(label, creator, ...). Labels the relayer picks are never
 *    reserved, so no REGISTER_RESERVED; it never renews, unregisters or changes a resolver.
 *  - Resolver SET_ADDRESS + SET_TEXT: the record multicall (Arc coin type + text records).
 *  - Resolver LINK: linkToNode (symbol and `latest` links) and linkToRecord (detach a symbol link).
 * No admin bits (role << 128), so the key cannot grant roles to anyone. Same set as the CCIP receiver.
 * receiver.retry(messageId) is permissionless and needs no role.
 */
export const FALLBACK_REGISTRY_ROLES = RegistryRoles.REGISTRAR;
export const FALLBACK_RESOLVER_ROLES = ResolverRoles.SET_ADDRESS | ResolverRoles.SET_TEXT | ResolverRoles.LINK;

/** Resolver EAC resource for a setter argument: keccak256(key) for text, keccak256(uint256) for coin types. */
export const textKeyResource = (key: string) => BigInt(keccak256(stringToHex(key)));
export const coinTypeResource = (coinType: bigint) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }], [coinType])));

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** DNS wire-format encoding (RFC 1035) used by ENSv2 for `bytes name` arguments. */
export function dnsEncode(name: string): Hex {
  if (name === "") return "0x00";
  const parts = name.split(".").map((l) => stringToBytes(l));
  const out: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 255) throw new Error(`invalid label in ${name}`);
    out.push(p.length, ...p);
  }
  out.push(0);
  return bytesToHex(Uint8Array.from(out));
}

/** The registry id ("anyId") ENSv2 accepts for a label: uint256(labelhash). */
export const labelId = (label: string) => BigInt(labelhash(label));

export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

/** Labels the relayer never assigns to a fund. They are reserved entries in the UserRegistry. */
export const RESERVED_LABELS = ["latest", "www", "app", "admin", "official", "support"] as const;

/**
 * Turns user input (event label or fund symbol) into a valid label: lowercase a-z0-9 and '-',
 * 3 to 32 chars, no leading/trailing '-', no "xx--" punycode prefix. Returns null if impossible.
 */
export function sanitizeLabel(input: string): string | null {
  let s = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 32) s = s.slice(0, 32).replace(/-+$/g, "");
  if (s.length < 3) return null;
  if (s.slice(2, 4) === "--") return null;
  if ((RESERVED_LABELS as readonly string[]).includes(s)) return null;
  return LABEL_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// State file (addresses this project deployed on Sepolia)
// ---------------------------------------------------------------------------

export type State = {
  parentName?: string;
  parentRegisteredTx?: Hex;
  pendingCommit?: { commitment: Hex; secret: Hex; duration: string; paymentToken: Address; committedAt: number };
  userRegistry?: Address;
  userRegistrySalt?: string;
  resolver?: Address;
  resolverSalt?: string;
  funds?: Record<string, { label: string; fund: Address; creator: Address; tx?: Hex }>;
  /** Chainlink CCIP bridge (ccip-setup.ts). */
  arcEnsRegistrar?: Address;
  ensReceiver?: Address;
};

export function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}

export function saveState(s: State) {
  if (DRY_RUN) return;
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export function signer() {
  const account = loadAccount();
  return {
    account,
    from: actingAddress(account),
    wallet: account ? walletFor(account) : null,
    arcWallet: account ? walletFor(account, "arc") : null,
  };
}

/**
 * Simulates the call as `from`, then (unless dry-run) sends it and waits for the receipt.
 * In dry-run mode a failed simulation is reported but not thrown, so the rest of the plan prints.
 */
export async function send<
  const abi extends Abi,
  fn extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(
  s: ReturnType<typeof signer>,
  what: string,
  req: {
    address: Address;
    abi: abi;
    functionName: fn;
    args: ContractFunctionArgs<abi, "nonpayable" | "payable", fn>;
    value?: bigint;
  },
  chain: ChainName = "sepolia",
): Promise<{ hash?: Hex; result?: unknown }> {
  const client = publicFor(chain);
  const wallet = chain === "arc" ? s.arcWallet : s.wallet;
  let result: unknown;
  try {
    const sim = await client.simulateContract({ ...(req as any), account: s.account ?? s.from });
    result = sim.result;
  } catch (e) {
    const msg = explain(e);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${what}: simulation reverted: ${msg}`);
      return {};
    }
    throw new Error(`${what}: simulation reverted: ${msg}`);
  }
  if (DRY_RUN || !wallet) {
    console.log(`  [dry-run] ${what}: would send ${String(req.functionName)} to ${req.address} on ${chain} (simulation ok)`);
    return { result };
  }
  const hash = await wallet.writeContract(req as any);
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${what}: tx ${hash} reverted`);
  console.log(`  ${what}: ${hash} (gas ${rc.gasUsed})`);
  return { hash, result };
}

export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const n = rev.data?.errorName;
      if (n) return `${n}(${(rev.data?.args ?? []).map(String).join(", ")})`;
    }
    return e.shortMessage;
  }
  return String(e);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function sepoliaTx(hash?: Hex) {
  return hash ? `https://sepolia.etherscan.io/tx/${hash}` : "";
}


export const DISCLAIMER = "Testnet mock tokens, not real securities.";

/** Deploys a contract from a compiled artifact (dry-run: only estimates gas). Returns its address. */
export async function deploy(
  s: ReturnType<typeof signer>,
  what: string,
  artifact: { abi: Abi; bytecode: Hex },
  args: readonly unknown[],
  chain: ChainName,
): Promise<Address | undefined> {
  const client = publicFor(chain);
  const wallet = chain === "arc" ? s.arcWallet : s.wallet;
  if (DRY_RUN || !wallet) {
    const { encodeDeployData } = await import("viem");
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: args as any });
    const gas = await client.estimateGas({ account: s.from, data }).catch((e) => explain(e));
    console.log(`  [dry-run] ${what}: would deploy on ${chain} (gas estimate ${gas})`);
    return undefined;
  }
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: args as any } as any);
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`${what}: deploy tx ${hash} failed`);
  console.log(`  ${what}: ${rc.contractAddress} (tx ${hash}, gas ${rc.gasUsed})`);
  return rc.contractAddress;
}

/** Sends native value (Arc: USDC with 18 decimals). */
export async function sendValue(s: ReturnType<typeof signer>, what: string, to: Address, value: bigint, chain: ChainName) {
  const wallet = chain === "arc" ? s.arcWallet : s.wallet;
  if (DRY_RUN || !wallet) {
    console.log(`  [dry-run] ${what}: would send ${value} wei to ${to} on ${chain}`);
    return;
  }
  const hash = await (wallet as any).sendTransaction({ to, value });
  const rc = await publicFor(chain).waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`${what}: tx ${hash} failed`);
  console.log(`  ${what}: ${hash}`);
}

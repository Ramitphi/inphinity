// Reads and writes records on the shared Permissioned Resolver, only sending what changed.
//
// Live ENSv2 PermissionedResolver stores records in numbered "record bundles". A name either has its
// own bundle, is linked to another name's bundle (linkToNode), or falls back to the default bundle
// (the empty name, 0x00). Setters write into whatever bundle the name currently points at.
import { decodeFunctionResult, encodeFunctionData, namehash, type Address, type Hex } from "viem";
import { ARC_COIN_TYPE, sepoliaClient as c } from "./config";
import { permissionedResolverAbi, profileAbi } from "./abis";
import { dnsEncode, send, signer } from "./lib";

export type Records = { arcAddress?: Address; texts: Record<string, string> };

/** Record bundle id a name points at (0 = none, so it reads the default bundle). */
export async function recordIdOf(resolver: Address, name: string): Promise<bigint> {
  return c.readContract({ address: resolver, abi: permissionedResolverAbi, functionName: "getRecordId", args: [name === "" ? "0x0000000000000000000000000000000000000000000000000000000000000000" : namehash(name)] });
}

export async function readText(resolver: Address, name: string, key: string): Promise<string> {
  const data = encodeFunctionData({ abi: profileAbi, functionName: "text", args: [namehash(name), key] });
  const out = await c.readContract({ address: resolver, abi: permissionedResolverAbi, functionName: "resolve", args: [dnsEncode(name), data] });
  return decodeFunctionResult({ abi: profileAbi, functionName: "text", data: out });
}

export async function readAddr(resolver: Address, name: string, coinType = ARC_COIN_TYPE): Promise<Hex> {
  const data = encodeFunctionData({ abi: profileAbi, functionName: "addr", args: [namehash(name), coinType] });
  const out = await c.readContract({ address: resolver, abi: permissionedResolverAbi, functionName: "resolve", args: [dnsEncode(name), data] });
  return decodeFunctionResult({ abi: profileAbi, functionName: "addr", data: out });
}

/**
 * Writes `want` into `name`'s own bundle with one multicall, skipping values already set.
 * If the name has no bundle yet (it reads the default bundle), everything is written, because the
 * first setter creates an empty bundle and the default no longer applies to it.
 */
export async function syncRecords(
  s: ReturnType<typeof signer>,
  resolver: Address,
  name: string,
  want: Records,
): Promise<{ changed: string[]; hash?: Hex }> {
  const dns = dnsEncode(name);
  const fresh = name !== "" && (await recordIdOf(resolver, name)) === 0n;
  const calls: Hex[] = [];
  const changed: string[] = [];

  if (want.arcAddress) {
    const cur = fresh ? "0x" : await readAddr(resolver, name);
    if (cur.toLowerCase() !== want.arcAddress.toLowerCase()) {
      calls.push(encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setAddress", args: [dns, ARC_COIN_TYPE, want.arcAddress] }));
      changed.push(`addr(${ARC_COIN_TYPE})`);
    }
  }
  for (const [key, value] of Object.entries(want.texts)) {
    const cur = fresh ? "" : await readText(resolver, name, key);
    if (cur === value) continue;
    calls.push(encodeFunctionData({ abi: permissionedResolverAbi, functionName: "setText", args: [dns, key, value] }));
    changed.push(key);
  }
  if (calls.length === 0) return { changed };
  const { hash } = await send(s, `records for ${name || "<default bundle>"} [${changed.join(", ")}]`, {
    address: resolver,
    abi: permissionedResolverAbi,
    functionName: "multicall",
    args: [calls],
  });
  return { changed, hash };
}

/** Points `sourceName` at the bundle of `targetName` (record linking). No-op if already linked. */
export async function linkName(s: ReturnType<typeof signer>, resolver: Address, sourceName: string, targetName: string) {
  const [src, dst] = await Promise.all([recordIdOf(resolver, sourceName), recordIdOf(resolver, targetName)]);
  if (dst === 0n) throw new Error(`cannot link ${sourceName}: ${targetName} has no records yet`);
  if (src === dst) return;
  await send(s, `link ${sourceName} -> records of ${targetName}`, {
    address: resolver,
    abi: permissionedResolverAbi,
    functionName: "linkToNode",
    args: [dnsEncode(sourceName), namehash(targetName)],
  });
}

/** Detaches `name` from any bundle (back to the default bundle). */
export async function unlinkName(s: ReturnType<typeof signer>, resolver: Address, name: string) {
  if ((await recordIdOf(resolver, name)) === 0n) return;
  await send(s, `unlink ${name}`, { address: resolver, abi: permissionedResolverAbi, functionName: "linkToRecord", args: [dnsEncode(name), 0n] });
}

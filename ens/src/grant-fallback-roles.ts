// Grants a dedicated fallback key (src/fallback.ts) exactly the ENSv2 roles it needs, and nothing more:
//   UserRegistry   ROLE_REGISTRAR                      (register fund names)
//   Resolver       SET_ADDRESS | SET_TEXT | LINK       (records + symbol/latest links)
// No admin bits, so the key can never grant roles itself. receiver.retry() is permissionless.
// Run it as the team wallet (it holds the admin roles on both contracts). Idempotent: only missing
// roles are granted. --revoke removes them again (e.g. if the key leaks).
//
// Usage: PRIVATE_KEY=<team key> bun run src/grant-fallback-roles.ts <address> [--dry-run] [--revoke]
import { formatEther, isAddress, getAddress } from "viem";
import { DRY_RUN, sepoliaClient as c } from "./config";
import { permissionedResolverAbi, registryAbi } from "./abis";
import { FALLBACK_REGISTRY_ROLES, FALLBACK_RESOLVER_ROLES, loadState, send, signer } from "./lib";

/** Sepolia gas for one fallback naming of a 3-token fund (measured live 2026-11-06): ~4.1M; 10 tokens ~7.5M. */
const GAS_PER_NAMING = 7_500_000n;

async function main() {
  const REVOKE = process.argv.includes("--revoke");
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!arg || !isAddress(arg)) throw new Error("Usage: bun run src/grant-fallback-roles.ts <address> [--dry-run] [--revoke]");
  const who = getAddress(arg);
  const state = loadState();
  if (!state.userRegistry || !state.resolver) throw new Error("No userRegistry/resolver in deployments.sepolia.json.");
  const s = signer();
  console.log(`${REVOKE ? "Revoking" : "Granting"} fallback roles for ${who} as ${s.from}${DRY_RUN ? " (dry-run)" : ""}`);

  const targets = [
    { what: "UserRegistry ROLE_REGISTRAR", address: state.userRegistry, abi: registryAbi, roles: FALLBACK_REGISTRY_ROLES },
    { what: "Resolver SET_ADDRESS|SET_TEXT|LINK", address: state.resolver, abi: permissionedResolverAbi, roles: FALLBACK_RESOLVER_ROLES },
  ] as const;

  for (const t of targets) {
    const has = await c.readContract({ address: t.address, abi: t.abi as typeof registryAbi, functionName: "hasRootRoles", args: [t.roles, who] });
    if (has !== REVOKE) {
      console.log(`  ${t.what}: already ${REVOKE ? "absent" : "held"} (${t.address})`);
      continue;
    }
    await send(s, `${t.address} ${REVOKE ? "revokeRootRoles" : "grantRootRoles"}(${t.roles}, ${who}) [${t.what}]`, {
      address: t.address,
      abi: registryAbi, // grantRootRoles/revokeRootRoles have the same signature on both contracts
      functionName: REVOKE ? "revokeRootRoles" : "grantRootRoles",
      args: [t.roles, who],
    });
  }

  const [bal, gasPrice] = await Promise.all([c.getBalance({ address: who }), c.getGasPrice()]);
  const perNaming = GAS_PER_NAMING * (gasPrice > 1_000_000_000n ? gasPrice : 1_000_000_000n);
  console.log(`  ${who} has ${formatEther(bal)} Sepolia ETH; one naming needs up to ${GAS_PER_NAMING} gas (~${formatEther(perNaming)} ETH at ${gasPrice > 1_000_000_000n ? "current gas price" : "1 gwei"}).`);
  if (!REVOKE && bal < perNaming * 3n) console.log("  note: fund it with at least 0.05 Sepolia ETH before running the fallback loop.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

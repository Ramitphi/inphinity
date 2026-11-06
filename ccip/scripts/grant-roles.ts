// Ethereum Sepolia: give FundNameReceiver the roles it needs, from the team wallet (which holds the
// admin roles on both contracts, see ens/DESIGN.md):
//   UserRegistry          grantRootRoles(ROLE_REGISTRAR)                          register fund names
//   PermissionedResolver  grantRootRoles(ROLE_SET_ADDRESS | ROLE_SET_TEXT | ROLE_LINK)  write records, links
// No admin roles are granted, so the receiver cannot pass roles on, upgrade, unregister or repoint
// resolvers. The live resolver disables per-resource grantRoles(); root grants are its supported path.
// `--revoke` removes them again.
//
// Usage: PRIVATE_KEY=0x... bun run scripts/grant-roles.ts [--dry-run] [--revoke] [--receiver 0x...]
import { parseAbi, type Address } from "viem";
import { DRY_RUN, ENS, arg, loadState, send, sep, signerFor } from "./config";

export const ROLE_REGISTRAR = 1n << 0n;
export const ROLE_SET_ADDRESS = 1n << 0n;
export const ROLE_SET_TEXT = 1n << 4n;
export const ROLE_LINK = 1n << 28n;
export const REGISTRY_ROLES = ROLE_REGISTRAR;
export const RESOLVER_ROLES = ROLE_SET_ADDRESS | ROLE_SET_TEXT | ROLE_LINK;

const eacAbi = parseAbi([
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)",
]);

const s = signerFor("sepolia");
const receiver = (arg("receiver") ?? loadState().sepolia?.receiver) as Address | undefined;
const revoke = process.argv.includes("--revoke");
if (!receiver) throw new Error("No receiver: run deploy-receiver.ts first (or pass --receiver 0x...).");
console.log(`${revoke ? "Revoking" : "Granting"} roles for FundNameReceiver ${receiver}, as ${s.from}${DRY_RUN ? " (dry-run)" : ""}`);

for (const [what, address, roles] of [
  ["UserRegistry REGISTRAR", ENS.userRegistry, REGISTRY_ROLES],
  ["Resolver SET_ADDRESS|SET_TEXT|LINK", ENS.resolver, RESOLVER_ROLES],
] as const) {
  const has = await sep.readContract({ address, abi: eacAbi, functionName: "hasRootRoles", args: [roles, receiver] });
  if (has !== revoke) {
    console.log(`  ${what}: ${has ? "granted" : "not granted"} (ok)`);
    continue;
  }
  await send(s, `${revoke ? "revoke" : "grant"} ${what}`, {
    address,
    abi: eacAbi,
    functionName: revoke ? "revokeRootRoles" : "grantRootRoles",
    args: [roles, receiver],
  });
}
console.log("Done.");

// Step 2: turn inphinity.eth into an ENSv2 fund registry.
//
//   a. Deploy a UserRegistry proxy through ENS's VerifiableFactory (the team wallet gets operator
//      roles on its ROOT_RESOURCE) and attach it to inphinity.eth with setSubregistry().
//   b. Deploy one Permissioned Resolver proxy through the same factory, set it as the resolver of
//      inphinity.eth, and write the registry-wide records on inphinity.eth itself.
//   c. Point the UserRegistry back at its parent (setParent) so its names are canonical.
//   d. Reserve labels such as latest/www/admin as ownerless entries routed to our resolver, so no
//      fund can take them, and `latest.inphinity.eth` can be linked to the newest fund's records.
//   e. Write the resolver's default record bundle (the empty name): any name on this resolver
//      without its own bundle (reserved labels, names not indexed yet) shows a registry notice
//      and no address.
//
// Every step reads chain state first and only sends what is missing, so it is safe to re-run.
// Usage: PRIVATE_KEY=0x... bun run src/setup-registry.ts [--dry-run]
import { encodeFunctionData, keccak256, stringToHex, zeroAddress, type Address } from "viem";
import { ARC, ENS, PARENT_LABEL, PARENT_NAME, DRY_RUN, sepoliaClient as c } from "./config";
import { permissionedResolverAbi, registryAbi, verifiableFactoryAbi } from "./abis";
import {
  REGISTRY_OPERATOR_ROLES,
  RESERVED_LABELS,
  RESOLVER_ADMIN_ROLES,
  DISCLAIMER,
  labelId,
  loadState,
  saveState,
  send,
  signer,
} from "./lib";
import { syncRecords } from "./records";


export const APP_URL = process.env.APP_URL ?? "https://github.com/ramitphi/inphinity";

const ethRegistry = { address: ENS.ethRegistry, abi: registryAbi } as const;

/** Deploys (or finds) a proxy at the address the VerifiableFactory derives from (sender, salt). */
async function ensureProxy(
  s: ReturnType<typeof signer>,
  what: string,
  implementation: Address,
  saltSeed: string,
  data: `0x${string}`,
): Promise<Address> {
  const salt = BigInt(keccak256(stringToHex(saltSeed)));
  const factory = { address: ENS.verifiableFactory, abi: verifiableFactoryAbi } as const;
  const predicted = await c.readContract({ ...factory, functionName: "predictProxyAddress", args: [s.from, salt] });
  if (await hasCode(predicted)) {
    console.log(`  ${what}: ${predicted} (already deployed)`);
    return predicted;
  }
  await send(s, `deploy ${what} proxy via VerifiableFactory (salt "${saltSeed}")`, { ...factory, functionName: "deployProxy", args: [implementation, salt, data] });
  console.log(`  ${what}: ${predicted}`);
  return predicted;
}

async function hasCode(a?: Address) {
  return !!a && ((await c.getCode({ address: a })) ?? "0x") !== "0x";
}

async function main() {
  const s = signer();
  const me = s.from;
  const state = loadState();
  console.log(`Setting up the ${PARENT_NAME} fund registry as ${me}${DRY_RUN ? " (dry-run)" : ""}`);

  const parentId = labelId(PARENT_LABEL);
  const parentOwner = await c.readContract({ ...ethRegistry, functionName: "getOwner", args: [parentId] });
  if (parentOwner.toLowerCase() !== me.toLowerCase()) {
    const msg = `${PARENT_NAME} is owned by ${parentOwner}, not ${me}. Run register-parent.ts first.`;
    if (!DRY_RUN) throw new Error(msg);
    console.log(`  [dry-run] ${msg} Later steps will show as reverted.`);
  }
  const parentExpiry = await c.readContract({ ...ethRegistry, functionName: "getExpiry", args: [parentId] });

  // a/b. UserRegistry and Permissioned Resolver proxies, both via ENS's VerifiableFactory.
  const registrySeed = state.userRegistrySalt ?? `${PARENT_NAME}:fund-registry:v1`;
  const userRegistry = await ensureProxy(
    s,
    "UserRegistry",
    ENS.userRegistryImpl,
    registrySeed,
    encodeFunctionData({ abi: registryAbi, functionName: "initialize", args: [[{ account: me, roleBitmap: REGISTRY_OPERATOR_ROLES }]] }),
  );
  const resolverSeed = state.resolverSalt ?? `${PARENT_NAME}:resolver:v1`;
  const resolver = await ensureProxy(
    s,
    "PermissionedResolver",
    ENS.permissionedResolverImpl,
    resolverSeed,
    encodeFunctionData({ abi: permissionedResolverAbi, functionName: "initialize", args: [[{ account: me, roleBitmap: RESOLVER_ADMIN_ROLES }], []] }),
  );
  if (!DRY_RUN) Object.assign(state, { userRegistry, userRegistrySalt: registrySeed, resolver, resolverSalt: resolverSeed });
  saveState(state);
  if (DRY_RUN && !(await hasCode(userRegistry))) {
    console.log("  [dry-run] stopping: the remaining steps need the proxies to exist.");
    return;
  }

  // Attach to inphinity.eth in the .eth registry.
  const curSub = await c.readContract({ ...ethRegistry, functionName: "getSubregistry", args: [PARENT_LABEL] });
  if (curSub.toLowerCase() !== userRegistry.toLowerCase()) {
    await send(s, `setSubregistry(${PARENT_NAME} -> UserRegistry)`, { ...ethRegistry, functionName: "setSubregistry", args: [parentId, userRegistry] });
  } else console.log("  subregistry already set");
  const curRes = await c.readContract({ ...ethRegistry, functionName: "getResolver", args: [PARENT_LABEL] });
  if (curRes.toLowerCase() !== resolver.toLowerCase()) {
    if (curRes !== zeroAddress) console.log(`  note: replacing the current resolver ${curRes} of ${PARENT_NAME}`);
    await send(s, `setResolver(${PARENT_NAME} -> PermissionedResolver)`, { ...ethRegistry, functionName: "setResolver", args: [parentId, resolver] });
  } else console.log("  resolver already set");

  // c. Canonical parent pointer.
  const ur = { address: userRegistry, abi: registryAbi } as const;
  const [parentReg, parentLbl] = await c.readContract({ ...ur, functionName: "getParent" });
  if (parentReg.toLowerCase() !== ENS.ethRegistry.toLowerCase() || parentLbl !== PARENT_LABEL) {
    await send(s, "UserRegistry.setParent(.eth registry, inphinity)", { ...ur, functionName: "setParent", args: [ENS.ethRegistry, PARENT_LABEL] });
  } else console.log("  parent pointer already set");

  // d. Reserved labels: ownerless entries (no token) whose resolver is ours.
  for (const label of RESERVED_LABELS) {
    const st = await c.readContract({ ...ur, functionName: "getState", args: [labelId(label)] });
    if (st.status !== 0) continue; // already RESERVED (1) or REGISTERED (2)
    await send(s, `reserve ${label}.${PARENT_NAME}`, {
      ...ur,
      functionName: "register",
      args: [label, zeroAddress, zeroAddress, resolver, 0n, parentExpiry],
    });
  }

  // e. Default bundle: what any name without its own records shows.
  const def = await syncRecords(s, resolver, "", {
    texts: {
      description: `Not an Inphinity fund (or not indexed yet). The fund registry is ${PARENT_NAME}.`,
      url: APP_URL,
      "inphinity.disclaimer": DISCLAIMER,
    },
  });
  if (def.changed.length === 0) console.log("  default bundle already up to date");

  // Registry-wide records on inphinity.eth itself (its own bundle).
  const { changed } = await syncRecords(s, resolver, PARENT_NAME, {
    arcAddress: ARC.indexFactory, // inphinity.eth -> the IndexFactory on Arc Testnet
    texts: {
      description:
        "Inphinity fund registry. Every index fund created on Arc Testnet gets <label>.inphinity.eth, owned by its creator. Records are written from onchain fund data.",
      url: APP_URL,
      "inphinity.chain": `arc-testnet:${ARC.chainId}`,
      "inphinity.factory": ARC.indexFactory,
      "inphinity.registry": userRegistry,
      "inphinity.disclaimer": DISCLAIMER,
    },
  });
  if (changed.length === 0) console.log("  parent records already up to date");

  console.log(`\nDone.\n  UserRegistry         ${userRegistry}\n  PermissionedResolver ${resolver}\n  View: https://sepolia.app.ens.domains/${PARENT_NAME}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

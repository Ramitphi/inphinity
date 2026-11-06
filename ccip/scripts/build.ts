// Compiles ccip/contracts with solc-js (standard JSON + remappings) into ccip/out/<Name>.json.
// Hardhat 2 cannot resolve the "@openzeppelin/contracts@5.3.0/..." imports used inside
// @chainlink/contracts-ccip@2.0.0, so we compile directly with the same remappings as its foundry setup.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore no types
import solc from "solc";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const remap: [string, string][] = [
  ["@openzeppelin/contracts@5.3.0/", join(nm, "@openzeppelin/contracts-5.3.0/")],
  ["@chainlink/contracts-ccip/", join(nm, "@chainlink/contracts-ccip/")],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".sol")) out.push(p);
  }
  return out;
}

const sources: Record<string, { content: string }> = {};
for (const f of walk(join(root, "contracts"))) {
  const rel = f.slice(root.length + 1);
  sources[rel] = { content: readFileSync(f, "utf8") };
}

function findImports(path: string) {
  for (const [from, to] of remap) if (path.startsWith(from)) path = to + path.slice(from.length);
  const p = path.startsWith("/") ? path : join(root, path);
  if (existsSync(p)) return { contents: readFileSync(p, "utf8") };
  return { error: `not found: ${path}` };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
let failed = false;
for (const e of out.errors ?? []) {
  if (e.severity === "error") failed = true;
  console[e.severity === "error" ? "error" : "warn"](e.formattedMessage);
}
if (failed) process.exit(1);
mkdirSync(join(root, "out"), { recursive: true });
for (const [file, contracts] of Object.entries<any>(out.contracts)) {
  if (!file.startsWith("contracts/")) continue;
  for (const [name, c] of Object.entries<any>(contracts)) {
    if (!c.evm.bytecode.object || name === "FundLabel") continue; // interfaces and internal libraries
    writeFileSync(
      join(root, "out", `${name}.json`),
      JSON.stringify({ contractName: name, sourceName: file, compiler: solc.version(), abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2) + "\n",
    );
    console.log(`  ${name}: ${(c.evm.deployedBytecode.object.length / 2).toLocaleString()} bytes`);
  }
}

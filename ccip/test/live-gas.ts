// Measures FundNameReceiver.ccipReceive gas with LIVE Ethereum Sepolia gas pricing (read-only, no key).
//
// Why: live Sepolia prices state creation far above what a local Hardhat fork emulates (measured
// 2026-11-06: new storage slot ~111k gas, code deposit ~1.5k gas/byte), so fork gas numbers are ~3x
// too low. This script asks a live node instead: it builds the receiver's runtime code with eth_call,
// places it at the team wallet (which holds every ENS role we grant the receiver) with a state
// override, and runs eth_estimateGas for ccipReceive as the Sepolia Router, with sample funds.
//
// Usage: bun run test/live-gas.ts      (env SEPOLIA_RPC_URL to use another node)
import { getAddress, createPublicClient, encodeAbiParameters, encodeDeployData, encodeFunctionData, http, toHex, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { CCIP, ENS, TEAM_WALLET } from "../scripts/config";

const live = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com", { timeout: 60_000 }) });
const art = (n: string) => JSON.parse(readFileSync(new URL(`../out/${n}.json`, import.meta.url), "utf8"));
const R = art("FundNameReceiver");
const payloadType = art("FundNameSender").abi.find((x: any) => x.name === "buildPayload").outputs;
const SENDER: Address = "0x5e4de2000000000000000000000000000000c1a0"; // placeholder sender baked into the measured code
const rnd = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

const initData = encodeDeployData({ abi: R.abi, bytecode: R.bytecode, args: [CCIP.sepolia.router, CCIP.arc.chainSelector, SENDER, ENS.userRegistry, ENS.resolver, ENS.ethRegistry, ENS.parentLabel] });
const deployGas = await live.estimateGas({ account: TEAM_WALLET, data: initData });
const { data: code } = await live.call({ account: TEAM_WALLET, data: initData, gas: 60_000_000n });
console.log(`receiver runtime ${(code!.length - 2) / 2} bytes, live deploy estimate ${deployGas} gas`);

// Constructor-written storage: parentLabel (slot 0), as a short string.
const label = new TextEncoder().encode(ENS.parentLabel);
const slot0 = (toHex(label).padEnd(64, "0").slice(0, 64) + (label.length * 2).toString(16).padStart(2, "0")) as Hex;
const stateOverride = [{ address: TEAM_WALLET, code: code!, stateDiff: [{ slot: toHex(0, { size: 32 }), value: slot0 }] }];

const cases: [string, number, number, number, number][] = [
  // [what, tokens, name length, symbol length, token symbol length]
  ["3 tokens (BCHIP-like)", 3, 24, 5, 5],
  ["5 tokens", 5, 32, 6, 5],
  ["10 tokens", 10, 40, 8, 6],
  ["10 tokens, 128-char name, 32-char symbol", 10, 128, 32, 12],
];
for (const [what, n, nameLen, symLen, tsym] of cases) {
  const r = rnd(6);
  const fund = `0x${rnd(40)}` as Address;
  const creator = `0x${rnd(40)}` as Address; // an EOA: the team wallet now has code and rejects ERC-1155 mints
  const name = `Fund ${"N".repeat(200)}`.slice(0, nameLen);
  const symbol = `Q${r.toUpperCase()}${"S".repeat(40)}`.slice(0, symLen);
  const tokens = Array.from({ length: n }, () => getAddress(`0x${rnd(40)}`));
  const syms = Array.from({ length: n }, (_, i) => `t${"ABCDEFGHIJ"[i]}`.padEnd(tsym, "X"));
  const w = Math.floor(10000 / n);
  // Same shape and lengths as FundNameSender._texts.
  const texts = [
    ["name", name],
    ["description", `${name} (${symbol}): an Inphinity index fund on Arc Testnet holding ${syms.join(", ")}.`],
    ["url", `https://explorer.testnet.arc.io/address/${getAddress(fund)}`],
    ["inphinity.symbol", symbol],
    ["inphinity.weights", syms.map((x) => `${x}:${w}`).join(",")],
    ["inphinity.tokens", tokens.join(",")],
    ["inphinity.fee", "50"],
    ["inphinity.creator", getAddress(creator)],
    ["inphinity.chain", "arc-testnet:5042002"],
    ["inphinity.index", "1000000"],
    ["inphinity.disclaimer", "Testnet mock tokens, not real securities."],
  ].map(([key, value]) => ({ key, value }));
  const p = { label: `gas-${r}`, symbolLabel: symbol.toLowerCase(), fund, creator, index: 1_000_000, texts };
  const data = encodeFunctionData({
    abi: R.abi,
    functionName: "ccipReceive",
    args: [{ messageId: `0x${rnd(64)}`, sourceChainSelector: CCIP.arc.chainSelector, sender: encodeAbiParameters([{ type: "address" }], [SENDER]), data: encodeAbiParameters(payloadType, [p]), destTokenAmounts: [] }],
  });
  const gas = await live.estimateGas({ account: CCIP.sepolia.router, to: TEAM_WALLET, data, stateOverride }).catch((e) => `error: ${e.shortMessage}`);
  console.log(`  ${what}: ${gas}`);
}

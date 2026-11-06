// Owner setup on Arc Testnet: trust the fund factory, list each bridged stock at its starting
// price, and (optionally) fund the exchange's USDC reserve. Safe to re-run.
// Usage: tsx scripts/setup-exchange.ts [reserveUsdc]
import { createWalletClient, http, parseUnits, zeroAddress } from "viem";
import { arcTestnet } from "viem/chains";
import { account, arc, erc20Abi, loadState, STOCKS } from "./common.ts";

const EXCHANGE = "0x93662de514b981f8c7bf97085e359e0f18034804" as const;
const FACTORY = "0x9fa4034efb237a7c154adea20b1ccfa0cd538b11" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const; // ERC-20 interface, 6 decimals

// Starting prices in 6-decimal USDC (live Yahoo quotes at setup time; Chainlink CRE updates them after).
const PRICES: Record<string, bigint> = {
  tAAPL: 344_170000n, tMSFT: 535_930000n, tNVDA: 181_600000n, tTSLA: 343_690000n,
  tAMZN: 260_210000n, tGOOGL: 282_570000n, tMETA: 605_080000n, tSPY: 733_000000n,
};

const exchangeAbi = [
  { name: "trustedFactory", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "setTrustedFactory", type: "function", stateMutability: "nonpayable", inputs: [{ name: "factory", type: "address" }], outputs: [] },
  { name: "isListed", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
  { name: "listExternalStock", type: "function", stateMutability: "nonpayable", inputs: [
    { name: "token", type: "address" }, { name: "name", type: "string" },
    { name: "symbol", type: "string" }, { name: "initialPrice", type: "uint256" },
  ], outputs: [] },
] as const;

const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
const send = async (hash: `0x${string}`, what: string) => {
  const r = await arc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`${what}: https://testnet.arcscan.app/tx/${hash}`);
};

if ((await arc.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "trustedFactory" })).toLowerCase() !== FACTORY) {
  await send(await wallet.writeContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "setTrustedFactory", args: [FACTORY] }), "setTrustedFactory");
}

const state = loadState();
for (const s of STOCKS) {
  const rec = state[s.symbol];
  if (!rec || rec.arcToken === zeroAddress) { console.log(`${s.symbol}: not on Arc yet, skipped`); continue; }
  if (await arc.readContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "isListed", args: [rec.arcToken] })) {
    console.log(`${s.symbol}: already listed`); continue;
  }
  await send(await wallet.writeContract({ address: EXCHANGE, abi: exchangeAbi, functionName: "listExternalStock",
    args: [rec.arcToken, s.name, s.symbol, PRICES[s.symbol]] }), `list ${s.symbol}`);
}

const reserve = process.argv[2];
if (reserve) {
  const transferAbi = [{ name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
  await send(await wallet.writeContract({ address: USDC, abi: transferAbi, functionName: "transfer", args: [EXCHANGE, parseUnits(reserve, 6)] }), `fund reserve ${reserve} USDC`);
  console.log("Reserve now:", await arc.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [EXCHANGE] }));
}

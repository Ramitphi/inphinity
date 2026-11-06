// Mints every stock on Base Sepolia and bridges it to one Arc address (by default the exchange,
// as its sell-side inventory). Sends all transfers first, then waits for them to land on Arc.
// Usage: tsx scripts/bridge-all.ts [amountPerStock] [arcRecipient]
import { encodePacked, parseUnits, zeroAddress, zeroHash } from "viem";
import {
  account, arc, ARC_DOMAIN, base, BASE_DOMAIN, baseWallet, CCTS, cctsAbi, DECIMALS,
  erc20Abi, FINALITY, forwardQuote, loadState, sleep,
} from "./common.ts";

const EXCHANGE = "0x93662de514b981f8c7bf97085e359e0f18034804";
const amountStr = process.argv[2] ?? "10000";
const recipient = (process.argv[3] ?? EXCHANGE) as `0x${string}`;
const amount = parseUnits(amountStr, DECIMALS);
const state = loadState();

const wait = async (hash: `0x${string}`, what: string) => {
  if ((await base.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`${what} reverted: ${hash}`);
};

const pending: { symbol: string; token: `0x${string}`; before: bigint }[] = [];
// Optional: ONLY=tAMD,tJPM limits the run to those symbols.
const only = process.env.ONLY?.split(",").map((x) => x.trim()).filter(Boolean);
for (const rec of Object.values(state)) {
  if (only && !only.includes(rec.symbol)) continue;
  if (rec.arcToken === zeroAddress) { console.log(`${rec.symbol}: not on Arc, skipped`); continue; }
  const before = await arc.readContract({ address: rec.arcToken, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
  await wait(await baseWallet.writeContract({ address: rec.baseToken, abi: erc20Abi, functionName: "mint", args: [account.address, amount] }), `${rec.symbol} mint`);
  const manager = await base.readContract({ address: CCTS, abi: cctsAbi, functionName: "resolveTokenManager", args: [rec.tokenId] });
  await wait(await baseWallet.writeContract({ address: rec.baseToken, abi: erc20Abi, functionName: "approve", args: [manager, amount] }), `${rec.symbol} approve`);
  const quote = await forwardQuote(rec.tokenId, BASE_DOMAIN, ARC_DOMAIN, {
    amount: amount.toString(), feeToken: zeroAddress,
    requests: [{ type: "FORWARD", params: { msgType: "TransferMessage", destinationAddress: recipient, autoExecuteHookData: false } }],
  });
  const hash = await baseWallet.writeContract({
    address: CCTS, abi: cctsAbi, functionName: "crossChainTransfer",
    args: [rec.tokenId, amount, ARC_DOMAIN, encodePacked(["address"], [recipient]), zeroHash, FINALITY,
      { signedQuote: quote.signedQuote, refundAddress: zeroAddress }, false, "0x"],
    value: BigInt(quote.feeTotalAmount),
  });
  await wait(hash, `${rec.symbol} bridge`);
  console.log(`${rec.symbol}: minted and bridged ${amountStr} (https://sepolia.basescan.org/tx/${hash})`);
  pending.push({ symbol: rec.symbol, token: rec.arcToken, before });
}

const deadline = Date.now() + 60 * 60_000;
while (pending.length) {
  if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${pending.map((p) => p.symbol).join(", ")}`);
  await sleep(30_000);
  for (const p of [...pending]) {
    const now = await arc.readContract({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    if (now > p.before) {
      console.log(`${p.symbol}: arrived on Arc (${recipient} holds ${now / 10n ** 18n})`);
      pending.splice(pending.indexOf(p), 1);
    }
  }
}
console.log("All transfers landed on Arc.");

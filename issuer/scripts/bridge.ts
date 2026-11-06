// Mints a stock on Base Sepolia (as the issuer) and bridges it to an address on Arc with CCTP.
// Usage: tsx scripts/bridge.ts <SYMBOL> <amount> <arcRecipient> [hookData] [hookTarget]
import { encodePacked, parseUnits, zeroAddress, zeroHash } from "viem";
import {
  account, arc, ARC_DOMAIN, base, BASE_DOMAIN, baseWallet, CCTS, cctsAbi, DECIMALS,
  erc20Abi, FINALITY, forwardQuote, loadState, sleep,
} from "./common.ts";

const [symbol, amountStr, recipientArg, hookData = "0x"] = process.argv.slice(2);
if (!symbol || !amountStr) throw new Error("Usage: bridge.ts <SYMBOL> <amount> [arcRecipient] [hookData]");
const rec = loadState()[symbol];
if (!rec?.arcToken || rec.arcToken === zeroAddress) throw new Error(`${symbol} is not deployed on both chains yet`);
const recipient = (recipientArg ?? account.address) as `0x${string}`;
// The deploy event can report a zero address, so always resolve the Base token from the service.
if (rec.baseToken === zeroAddress) {
  rec.baseToken = await base.readContract({ address: CCTS, abi: cctsAbi, functionName: "resolveTokenAddress", args: [rec.tokenId] });
}
const amount = parseUnits(amountStr, DECIMALS);

const wait = async (hash: `0x${string}`, what: string) => {
  if ((await base.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`${what} reverted: ${hash}`);
};

// 1. Issue the shares on Base Sepolia.
await wait(await baseWallet.writeContract({ address: rec.baseToken, abi: erc20Abi, functionName: "mint", args: [account.address, amount] }), "mint");
console.log(`Minted ${amountStr} ${symbol} on Base Sepolia`);

// 2. Approve this token's TokenManager (not the service) to pull them.
const manager = await base.readContract({ address: CCTS, abi: cctsAbi, functionName: "resolveTokenManager", args: [rec.tokenId] });
await wait(await baseWallet.writeContract({ address: rec.baseToken, abi: erc20Abi, functionName: "approve", args: [manager, amount] }), "approve");

// 3. Quote and send the cross-chain transfer; Circle relays the mint on Arc.
const withHook = hookData !== "0x";
const quote = await forwardQuote(rec.tokenId, BASE_DOMAIN, ARC_DOMAIN, {
  amount: amount.toString(), feeToken: zeroAddress,
  requests: [{ type: "FORWARD", params: { msgType: "TransferMessage", destinationAddress: recipient, autoExecuteHookData: withHook } }],
});
const before = await arc.readContract({ address: rec.arcToken, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
const hash = await baseWallet.writeContract({
  address: CCTS, abi: cctsAbi, functionName: "crossChainTransfer",
  args: [rec.tokenId, amount, ARC_DOMAIN, encodePacked(["address"], [recipient]), zeroHash, FINALITY,
    { signedQuote: quote.signedQuote, refundAddress: zeroAddress }, withHook, hookData as `0x${string}`],
  value: BigInt(quote.feeTotalAmount),
});
await wait(hash, "crossChainTransfer");
console.log(`Bridge sent: https://sepolia.basescan.org/tx/${hash}`);

// 4. Wait for the tokens to land on Arc.
const deadline = Date.now() + 30 * 60_000;
for (;;) {
  if (Date.now() > deadline) throw new Error("Timed out waiting for tokens on Arc");
  await sleep(20_000);
  const now = await arc.readContract({ address: rec.arcToken, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
  if (now > before) { console.log(`Arrived on Arc: ${recipient} now holds ${now} base units of ${symbol}`); break; }
}

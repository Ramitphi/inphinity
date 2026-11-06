// Mints N of every stock on Base Sepolia to an address (default: the issuer), e.g. so a demo
// wallet can try the "Bridge from Base" screen. Usage: tsx scripts/mint-base.ts [amount] [to]
import { parseUnits } from "viem";
import { account, base, baseWallet, DECIMALS, erc20Abi, loadState } from "./common.ts";
const amount = parseUnits(process.argv[2] ?? "100", DECIMALS);
const to = (process.argv[3] ?? account.address) as `0x${string}`;
for (const rec of Object.values(loadState())) {
  const hash = await baseWallet.writeContract({ address: rec.baseToken, abi: erc20Abi, functionName: "mint", args: [to, amount] });
  if ((await base.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`${rec.symbol} mint reverted: ${hash}`);
  const bal = await base.readContract({ address: rec.baseToken, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  console.log(`${rec.symbol}: minted, ${to} now holds ${bal / 10n ** 18n} on Base Sepolia (https://sepolia.basescan.org/tx/${hash})`);
}

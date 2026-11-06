// Deploys each mock stock as a native CCTP cross-chain token on Base Sepolia (the issuer's chain)
// and asks Circle to deploy its twin on Arc Testnet. Safe to re-run: finished stocks are skipped.
import { keccak256, parseEventLogs, toBytes, zeroAddress } from "viem";
import {
  account, arc, ARC_DOMAIN, base, BASE_DOMAIN, baseWallet, CCTS, cctsAbi, DECIMALS,
  forwardQuote, loadState, ownerBytes, saveState, sleep, STOCKS,
} from "./common.ts";

const MAX = 2n ** 256n - 1n;
const params = {
  tokenManagerType: 0, // NATIVE_CROSSCHAIN_TOKEN: burn on the source, mint on the destination
  tokenManagerOwner: ownerBytes,
  tokenManagerOperator: ownerBytes,
  tokenOwner: ownerBytes,
  tokenMinter: ownerBytes, // the issuer is the only minter
  tokenManagerSettings: { rateLimit: MAX, maxTransferAmount: MAX },
} as const;

const state = loadState();
console.log("Issuer:", account.address);

for (const s of STOCKS) {
  if (state[s.symbol]?.arcToken) { console.log(`${s.symbol}: already deployed`); continue; }
  const salt = keccak256(toBytes(`inphinity-${s.symbol}-v1`));

  // 1. Home deploy on Base Sepolia.
  let tokenId = state[s.symbol]?.tokenId;
  let baseToken = state[s.symbol]?.baseToken;
  if (!tokenId) {
    const hash = await baseWallet.writeContract({
      address: CCTS, abi: cctsAbi, functionName: "deployCrossChainToken",
      args: [salt, s.name, s.symbol, DECIMALS, params],
    });
    const receipt = await base.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${s.symbol} home deploy reverted: ${hash}`);
    const claimed = parseEventLogs({ abi: cctsAbi, eventName: "CrossChainTokenIdClaimed", logs: receipt.logs })[0];
    if (!claimed) throw new Error("Missing CrossChainTokenIdClaimed");
    tokenId = claimed.args.tokenId;
    baseToken = claimed.args.tokenAddress;
    state[s.symbol] = { symbol: s.symbol, name: s.name, tokenId, baseToken, arcToken: zeroAddress };
    saveState(state);
    console.log(`${s.symbol}: Base token ${baseToken} (tx https://sepolia.basescan.org/tx/${hash})`);
  }

  // 2. Remote deploy to Arc, relayed by Circle (fee paid in Base Sepolia ETH).
  const quote = await forwardQuote(tokenId!, BASE_DOMAIN, ARC_DOMAIN, {
    amount: "1", feeToken: zeroAddress,
    requests: [{ type: "FORWARD", params: { msgType: "DeployTokenMessage", autoExecuteHookData: false } }],
  });
  const remoteHash = await baseWallet.writeContract({
    address: CCTS, abi: cctsAbi, functionName: "deployRemoteCrossChainToken",
    args: [salt, ARC_DOMAIN, s.name, s.symbol, DECIMALS, params,
      { signedQuote: quote.signedQuote, refundAddress: zeroAddress }],
    value: BigInt(quote.feeTotalAmount),
  });
  if ((await base.waitForTransactionReceipt({ hash: remoteHash })).status !== "success") {
    throw new Error(`${s.symbol} remote deploy reverted: ${remoteHash}`);
  }
  console.log(`${s.symbol}: remote deploy sent, waiting for Arc…`);

  // 3. Wait until the Arc twin exists (usually a few minutes).
  let arcToken: `0x${string}` = zeroAddress;
  const deadline = Date.now() + 20 * 60_000;
  while (arcToken === zeroAddress) {
    if (Date.now() > deadline) throw new Error(`${s.symbol}: timed out waiting for the Arc token`);
    await sleep(15_000);
    try {
      arcToken = await arc.readContract({ address: CCTS, abi: cctsAbi, functionName: "resolveTokenAddress", args: [tokenId!] });
    } catch { arcToken = zeroAddress; }
  }
  state[s.symbol] = { ...state[s.symbol], arcToken };
  saveState(state);
  console.log(`${s.symbol}: Arc token ${arcToken}`);
}
console.log(JSON.stringify(state, null, 2));

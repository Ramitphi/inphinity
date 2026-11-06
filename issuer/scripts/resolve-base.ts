// Fills in each stock's Base Sepolia token address from the CrossChainTokenService.
import { base, CCTS, cctsAbi, loadState, saveState } from "./common.ts";
const state = loadState();
for (const rec of Object.values(state)) {
  rec.baseToken = await base.readContract({ address: CCTS, abi: cctsAbi, functionName: "resolveTokenAddress", args: [rec.tokenId] });
  console.log(rec.symbol, "base", rec.baseToken);
}
saveState(state);

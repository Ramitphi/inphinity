// Local forks for test/fork-e2e.ts. FORK_URL / FORK_CHAIN_ID pick the chain (see package.json
// fork:sepolia and fork:arc). Public RPCs are not archive nodes, so pin a recent FORK_BLOCK or omit it.
module.exports = {
  networks: {
    hardhat: {
      chainId: Number(process.env.FORK_CHAIN_ID ?? 11155111),
      hardfork: "prague",
      forking: {
        url: process.env.FORK_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
        ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
      },
    },
  },
};

// Local fork of Sepolia for test/fork-e2e.ts. publicnode is not an archive node, so pin a recent
// block: FORK_BLOCK=$(cast block-number --rpc-url $FORK_URL) or leave it unset for "latest".
module.exports = {
  solidity: "0.8.28",
  networks: {
    hardhat: {
      chainId: 11155111,
      hardfork: "prague",
      forking: {
        url: process.env.FORK_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
        ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
      },
    },
  },
};

import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },

  networks: {
    hardhat: {},
    ethSepolia: {
      url: 'https://ethereum-sepolia-rpc.publicnode.com',
      accounts: process.env['PRIVATE_KEY'] ? [process.env['PRIVATE_KEY']] : [],
    },
  },

  etherscan: {
    apiKey: {
      bsc: process.env['BSCSCAN_API_KEY'] || '',
      bscTestnet: process.env['BSCSCAN_API_KEY'] || '',
      sepolia: process.env['ETHERSCAN_API_KEY'] || '',
      ethSepolia: process.env['ETHERSCAN_API_KEY'] || '',
    },
  },
};

export default config;

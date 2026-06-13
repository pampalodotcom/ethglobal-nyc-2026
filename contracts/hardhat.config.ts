import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import HardhatIgnitionEthersPlugin from "@nomicfoundation/hardhat-ignition-ethers";
import { defineConfig } from "hardhat/config";

// Prefer a contracts/.env if one exists, otherwise fall back to the
// repo-root .env. `existsSync` instead of letting dotenv try-and-fail
// because dotenv prints a warning on miss, which clutters every
// `hardhat compile` / `hardhat test` run.
const here = dirname(fileURLToPath(import.meta.url));
const localEnv = resolve(here, ".env");
const rootEnv = resolve(here, "../.env");
dotenv.config({ path: existsSync(localEnv) ? localEnv : rootEnv });

// Lightweight Hardhat 3 setup using the mocha + ethers toolbox (no
// viem). Networks below are opt-in via env vars; the default network
// for `pnpm test` is the in-process Hardhat network — no RPC needed.

// One ALCHEMY_API_KEY drives RPC URLs for every chain, one MNEMONIC
// drives signers. Both fall back to empty defaults so missing env
// vars don't crash the config loader: tests on the in-process
// network keep working, and `pnpm compile` is unaffected.
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY ?? "";
const MNEMONIC = process.env.MNEMONIC ?? "";

// Always returns a syntactically valid URL so the config loads even
// when ALCHEMY_API_KEY is unset (Hardhat 3 rejects empty-string urls).
// The empty key only bites at request time — i.e. when you actually
// deploy to a live network without setting it.
function alchemyUrl(subdomain: string): string {
  return `https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`;
}

// HD-wallet accounts shape — Hardhat derives signers from the mnemonic
// on demand. Empty list when MNEMONIC is unset so the config still loads.
const hdAccounts = MNEMONIC ? { mnemonic: MNEMONIC } : [];

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin, HardhatIgnitionEthersPlugin],

  paths: {
    sources: "./contracts",
  },

  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 100 },
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 100 },
        },
      },
    },
  },

  networks: {
    // In-process Base mainnet fork for private-swap tests — forks the real
    // v4 PoolManager + USDC/WETH liquidity so the swap mechanics run against
    // production bytecode/state. Selected explicitly in the swap tests via
    // `network.connect('baseFork')`. Pin FORK_BLOCK for determinism + RPC
    // caching; omitted => recent block.
    baseFork: {
      type: "edr-simulated",
      chainId: 8453,
      forking: {
        url: alchemyUrl("base-mainnet"),
        ...(process.env.FORK_BLOCK
          ? { blockNumber: Number(process.env.FORK_BLOCK) }
          : {}),
      },
    },
    sepolia: {
      type: "http",
      url: alchemyUrl("eth-sepolia"),
      accounts: hdAccounts,
      chainId: 11155111,
    },
    baseSepolia: {
      type: "http",
      url: alchemyUrl("base-sepolia"),
      accounts: hdAccounts,
      chainId: 84532,
    },
  },

  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY ?? "",
    },
  },
});

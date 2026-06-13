# contracts

Solidity contracts for ethglobal-nyc-2026. Hardhat 3 + ethers v6 + mocha.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in ALCHEMY_API_KEY / MNEMONIC for live deploys
```

## Commands

```bash
pnpm compile           # compile contracts
pnpm test              # run the mocha test suite on the in-process network
pnpm deploy:sepolia    # deploy via Ignition to Sepolia
pnpm deploy:base-sepolia
```

## Layout

- `contracts/` — Solidity sources (`Counter.sol` is a placeholder example)
- `ignition/modules/` — Ignition deployment modules
- `helpers/get-testing-api.ts` — one-shot test fixture (deploys + returns signers)
- `test/` — mocha + chai + ethers tests
- `scripts/deploy.ts` — live-network deploy entrypoint

Tests run against the in-process Hardhat network with no RPC needed. The
`@/*` path alias maps to the package root (see `tsconfig.json`).

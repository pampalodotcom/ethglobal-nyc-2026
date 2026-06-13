import CounterModule from "@/ignition/modules/Counter.js";
import hre from "hardhat";

// Live-network deploy. Run with e.g.
//   pnpm deploy:sepolia
// which selects the network via `--network sepolia`. Ignition tracks
// state under ignition/deployments/ so re-runs are idempotent.
async function main() {
  const connection = await hre.network.getOrCreate();

  const { counter } = await connection.ignition.deploy(CounterModule);

  console.log(`Counter deployed to: ${await counter.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

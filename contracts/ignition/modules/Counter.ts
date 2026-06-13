/// <reference types="hardhat" />

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys the example Counter contract. Ignition is the deployment
// system the test fixture (`helpers/get-testing-api.ts`) and the
// `deploy.ts` script both run, so local tests and live deploys go
// through identical wiring.
const CounterModule = buildModule("Counter", (m) => {
  const startingCount = m.getParameter("startingCount", 0n);

  const counter = m.contract("Counter", [startingCount]);

  return { counter };
});

export default CounterModule;

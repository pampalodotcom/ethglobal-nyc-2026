import CounterModule from "@/ignition/modules/Counter.js";
import { ethers } from "ethers";
import hre from "hardhat";

// One-shot test fixture: connects to the in-process Hardhat network,
// grabs signers, and deploys the contracts via Ignition. Tests call
// this in a `before` hook and destructure what they need. Extend the
// return value as you add contracts.
export const getTestingAPI = async () => {
  const connection = await hre.network.create();
  const Signers = await connection.ethers.getSigners();

  const { counter } = await connection.ignition.deploy(CounterModule);

  return {
    connection,
    Signers,
    counter: counter as unknown as ethers.Contract,
  };
};

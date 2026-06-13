import { ethers } from "ethers";
import type hre from "hardhat";
import Poseidon2HuffJson from "@pampalo/contracts/contracts/utils/Poseidon2Huff.json" with { type: "json" };
import { BASE, USDC_BALANCE_SLOT, type Venue } from "./constants.js";

type Connection = Awaited<ReturnType<typeof hre.network.connect>>;

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export interface SwapFixture {
  connection: Connection;
  e: any;
  deployer: ethers.Signer;
  venue: Venue;
  contract: ethers.Contract; // PampaloSwapV4/V3 (or its harness)
  swapAddr: string;
  swapVerifier: string;
  usdc: ethers.Contract;
  weth: ethers.Contract;
}

// Deploy PampaloSwapV4/V3 (or its harness) wired to the chosen venue (Base's
// v4 PoolManager or v3 SwapRouter), the Poseidon huff hasher, and USDC/WETH
// as supported assets. Both venue constructors share the shape
// (4 base verifiers, venueAddr, swapVerifier). The four base verifiers are
// always mocks (unused on the swap path); the swap verifier is the real
// bb-generated SwapVerifier when `realVerifier`, else a mock that accepts any
// proof (for mechanics tests).
export async function deploySwapFixture(
  connection: Connection,
  opts: { venue?: Venue; harness?: boolean; realVerifier?: boolean } = {},
): Promise<SwapFixture> {
  const venue = opts.venue ?? "v4";
  const e = connection.ethers;
  const [deployer] = await e.getSigners();

  const Mock = await e.getContractFactory("MockVerifier");
  const mock = await Mock.deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();

  let swapVerifier = mockAddr;
  if (opts.realVerifier) {
    // The bb-generated verifier depends on the ZKTranscriptLib library,
    // which must be deployed and linked first.
    const ZKTL = await e.getContractFactory(
      "contracts/verifiers/SwapVerifier.sol:ZKTranscriptLib",
    );
    const zktl = await ZKTL.deploy();
    await zktl.waitForDeployment();
    const SV = await e.getContractFactory("SwapVerifier", {
      libraries: { ZKTranscriptLib: await zktl.getAddress() },
    });
    const sv = await SV.deploy();
    await sv.waitForDeployment();
    swapVerifier = await sv.getAddress();
  }

  const baseName = venue === "v4" ? "PampaloSwapV4" : "PampaloSwapV3";
  const venueAddr = venue === "v4" ? BASE.POOL_MANAGER : BASE.V3_ROUTER;
  const PS = await e.getContractFactory(
    opts.harness ? `${baseName}Harness` : baseName,
  );
  const contract = await PS.deploy(
    mockAddr, // depositVerifier
    mockAddr, // transferVerifier
    mockAddr, // withdrawVerifier
    mockAddr, // transferExternalVerifier
    venueAddr,
    swapVerifier,
  );
  await contract.waitForDeployment();
  const swapAddr = await contract.getAddress();

  const poseidon = await new ethers.ContractFactory(
    [],
    Poseidon2HuffJson.bytecode,
    deployer,
  ).deploy();
  await poseidon.waitForDeployment();
  await (await contract.setPoseidon(await poseidon.getAddress())).wait();

  // Oracle is only read on capped paths (shield/unshield); privateSwap
  // never charges, so address(0) is fine here.
  await (await contract.addSupportedAsset(BASE.USDC, ethers.ZeroAddress, 6)).wait();
  await (await contract.addSupportedAsset(BASE.WETH, ethers.ZeroAddress, 18)).wait();

  return {
    connection,
    e,
    deployer,
    venue,
    contract,
    swapAddr,
    swapVerifier,
    usdc: new ethers.Contract(BASE.USDC, ERC20_ABI, deployer),
    weth: new ethers.Contract(BASE.WETH, ERC20_ABI, deployer),
  };
}

// Fund an account's ERC-20 balance by overwriting the balances-mapping slot
// directly (no whale impersonation needed).
export async function fundErc20(
  connection: Connection,
  token: string,
  account: string,
  amount: bigint,
  balanceSlot: bigint,
): Promise<void> {
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256"],
      [account, balanceSlot],
    ),
  );
  await connection.provider.request({
    method: "hardhat_setStorageAt",
    params: [token, slot, ethers.toBeHex(amount, 32)],
  });
}

export const fundUsdc = (
  connection: Connection,
  account: string,
  amount: bigint,
): Promise<void> =>
  fundErc20(connection, BASE.USDC, account, amount, USDC_BALANCE_SLOT);

// Find and parse the first log matching `name`, or undefined.
export function parseEvent(
  contract: ethers.Contract,
  receipt: ethers.TransactionReceipt,
  name: string,
): ethers.LogDescription | undefined {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch {
      /* not one of ours */
    }
  }
  return undefined;
}

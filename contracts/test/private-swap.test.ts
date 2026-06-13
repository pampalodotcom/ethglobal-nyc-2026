import { expect } from "chai";
import { ethers } from "ethers";
import hre from "hardhat";
import Poseidon2HuffJson from "@pampalo/contracts/contracts/utils/Poseidon2Huff.json" with { type: "json" };

// ─── Base mainnet v4 + token addresses ──────────────────────────────────
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // 6 dec
const WETH = "0x4200000000000000000000000000000000000006"; // 18 dec

// PoolKey currencies are address-sorted: WETH (0x42..) < USDC (0x83..), so
// currency0 = WETH, currency1 = USDC. Selling USDC for WETH is therefore
// one-for-zero → zeroForOne = false.
const FEE = 500;
const TICK_SPACING = 10;
const HOOKS = ethers.ZeroAddress;
const POOL_KEY = [WETH, USDC, FEE, TICK_SPACING, HOOKS] as const;

// USDC on Base (FiatTokenV2_2) stores balances in the mapping at slot 9.
const USDC_BALANCE_SLOT = 9n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

// Build the 11-field public-input array for the swap circuit:
// [root, n1,n2,n3, c1,c2,c3, inputAsset, inputAmount, outputAsset, T]
function buildPublicInputs(opts: {
  root: bigint;
  nullifiers: bigint[]; // length 3
  outputCommitments: bigint[]; // length 3 (0 = empty slot)
  inputAsset: string;
  inputAmount: bigint;
  outputAsset: string;
  targetOutput: bigint;
}): string[] {
  const b32 = (v: bigint) => ethers.toBeHex(v, 32);
  const addr = (a: string) => ethers.zeroPadValue(a, 32);
  return [
    b32(opts.root),
    b32(opts.nullifiers[0]),
    b32(opts.nullifiers[1]),
    b32(opts.nullifiers[2]),
    b32(opts.outputCommitments[0]),
    b32(opts.outputCommitments[1]),
    b32(opts.outputCommitments[2]),
    addr(opts.inputAsset),
    b32(opts.inputAmount),
    addr(opts.outputAsset),
    b32(opts.targetOutput),
  ];
}

describe("private swap (Base fork)", () => {
  let connection: Awaited<ReturnType<typeof hre.network.connect>>;
  let e: any;
  let pampaloSwap: ethers.Contract;
  let usdc: ethers.Contract;
  let weth: ethers.Contract;
  let swapAddr: string;

  const FUND_USDC = 10_000n * 10n ** 6n; // 10k USDC into the pool

  before(async () => {
    connection = await hre.network.connect("baseFork");
    e = connection.ethers;
    const [deployer] = await e.getSigners();

    const Mock = await e.getContractFactory("MockVerifier");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    const mockAddr = await mock.getAddress();

    const PS = await e.getContractFactory("PampaloSwap");
    pampaloSwap = await PS.deploy(
      mockAddr, // depositVerifier
      mockAddr, // transferVerifier
      mockAddr, // withdrawVerifier
      mockAddr, // transferExternalVerifier
      POOL_MANAGER,
      mockAddr // swapVerifier
    );
    await pampaloSwap.waitForDeployment();
    swapAddr = await pampaloSwap.getAddress();

    // Deploy the arity-2 Poseidon tree hasher from the package blob.
    const PoseidonFactory = new ethers.ContractFactory(
      [],
      Poseidon2HuffJson.bytecode,
      deployer
    );
    const poseidon = await PoseidonFactory.deploy();
    await poseidon.waitForDeployment();
    await (await pampaloSwap.setPoseidon(await poseidon.getAddress())).wait();

    // Register supported assets. The oracle is only read on capped paths
    // (shield/unshield); privateSwap never charges, so address(0) is fine.
    await (await pampaloSwap.addSupportedAsset(USDC, ethers.ZeroAddress, 6)).wait();
    await (await pampaloSwap.addSupportedAsset(WETH, ethers.ZeroAddress, 18)).wait();

    // Fund the contract's pooled USDC by writing the balance slot directly
    // (no whale needed).
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [swapAddr, USDC_BALANCE_SLOT]
      )
    );
    await connection.provider.request({
      method: "hardhat_setStorageAt",
      params: [USDC, slot, ethers.toBeHex(FUND_USDC, 32)],
    });

    usdc = new ethers.Contract(USDC, ERC20_ABI, deployer);
    weth = new ethers.Contract(WETH, ERC20_ABI, deployer);

    const funded = await usdc.balanceOf(swapAddr);
    expect(funded, "USDC funding via storage slot failed — check slot").to.equal(
      FUND_USDC
    );
  });

  it("swaps pooled USDC -> WETH, takes realized, forfeits surplus, inserts notes", async () => {
    const swapAmount = 1_000n * 10n ** 6n; // 1000 USDC
    const T = 1n; // minimal floor for the mechanics test

    const root = await pampaloSwap.currentRoot();
    const publicInputs = buildPublicInputs({
      root,
      nullifiers: [
        BigInt(ethers.id("n1")),
        BigInt(ethers.id("n2")),
        0n,
      ],
      // Two output notes: B (swap output) + A (change). Arbitrary < PRIME.
      outputCommitments: [111n, 222n, 0n],
      inputAsset: USDC,
      inputAmount: swapAmount,
      outputAsset: WETH,
      targetOutput: T,
    });
    const path = [[POOL_KEY, false]]; // single hop, USDC->WETH (oneForZero)

    const usdcBefore = await usdc.balanceOf(swapAddr);
    const wethBefore = await weth.balanceOf(swapAddr);
    const nextIndexBefore = await pampaloSwap.nextIndex();

    const tx = await pampaloSwap.privateSwap(
      "0x", // mock proof
      publicInputs,
      path,
      [] // no encrypted payloads
    );
    const receipt = await tx.wait();

    const usdcAfter = await usdc.balanceOf(swapAddr);
    const wethAfter = await weth.balanceOf(swapAddr);

    // Exact-input: spent exactly swapAmount of USDC.
    expect(usdcBefore - usdcAfter).to.equal(swapAmount);
    // Received realized WETH (the full output, including forfeited surplus).
    const realized = wethAfter - wethBefore;
    expect(realized).to.be.greaterThan(T);

    // Both output commitments inserted as leaves.
    expect(await pampaloSwap.nextIndex()).to.equal(nextIndexBefore + 2n);

    // Input nullifiers marked spent.
    expect(await pampaloSwap.nullifierUsed(publicInputs[1])).to.equal(true);
    expect(await pampaloSwap.nullifierUsed(publicInputs[2])).to.equal(true);

    // Event carries the realized output.
    const ev = receipt.logs
      .map((l: any) => {
        try {
          return pampaloSwap.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "PrivateSwapExecuted");
    expect(ev, "PrivateSwapExecuted not emitted").to.not.equal(undefined);
    expect(ev!.args.realizedOutput).to.equal(realized);

    console.log(
      `    swapped ${swapAmount / 10n ** 6n} USDC -> ${ethers.formatEther(
        realized
      )} WETH`
    );
  });

  it("reverts when realized < target output T (sandwich floor)", async () => {
    const swapAmount = 1_000n * 10n ** 6n;
    const T = ethers.parseEther("1000"); // absurd floor → must revert

    const root = await pampaloSwap.currentRoot();
    const publicInputs = buildPublicInputs({
      root,
      nullifiers: [BigInt(ethers.id("n3")), 0n, 0n],
      outputCommitments: [333n, 0n, 0n],
      inputAsset: USDC,
      inputAmount: swapAmount,
      outputAsset: WETH,
      targetOutput: T,
    });
    const path = [[POOL_KEY, false]];

    await expect(
      pampaloSwap.privateSwap("0x", publicInputs, path, [])
    ).to.be.revertedWith("slippage / sandwich floor");
  });
});

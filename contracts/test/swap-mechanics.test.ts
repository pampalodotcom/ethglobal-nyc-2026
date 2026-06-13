import { expect } from "chai";
import { ethers } from "ethers";
import hre from "hardhat";
import { BASE, ROUTES, USDC_UNIT, type Venue } from "./helpers/constants.js";
import { deploySwapFixture, fundUsdc, parseEvent, type SwapFixture } from "./helpers/fixture.js";
import { swapPublicInputs } from "./helpers/notes.js";

// v4-mechanics tests against real Base liquidity, using a MOCK swap verifier
// so we can drive privateSwap with hand-built public inputs (no real proof)
// and exercise the venue adapter + forfeit/insert/floor invariants. The
// real-proof path is covered in swap-roundtrip.test.ts. Parameterized over
// both AMM venues — the note machinery is shared (PampaloSwapBase), only the
// _executeSwap adapter differs.
const VENUES: Venue[] = ["v4", "v3"];

for (const venue of VENUES) {
  describe(`private swap mechanics — ${venue} (Base fork)`, () => {
    let fx: SwapFixture;
    const FUND_USDC = 10_000n * USDC_UNIT;

    before(async () => {
      fx = await deploySwapFixture(await hre.network.connect("baseFork"), { venue });
      await fundUsdc(fx.connection, fx.swapAddr, FUND_USDC);
      expect(await fx.usdc.balanceOf(fx.swapAddr)).to.equal(FUND_USDC);
    });

    it("swaps pooled USDC -> WETH, takes realized, forfeits surplus, inserts notes", async () => {
      const swapAmount = 1_000n * USDC_UNIT;
      const T = 1n; // minimal floor for the mechanics test

      const publicInputs = swapPublicInputs({
        root: await fx.contract.currentRoot(),
        nullifiers: [BigInt(ethers.id(`${venue}-n1`)), BigInt(ethers.id(`${venue}-n2`)), 0n],
        outputCommitments: [111n, 222n, 0n], // B note + A change (arbitrary < PRIME)
        inputAsset: BASE.USDC,
        inputAmount: swapAmount,
        outputAsset: BASE.WETH,
        targetOutput: T,
      });

      const usdcBefore = await fx.usdc.balanceOf(fx.swapAddr);
      const wethBefore = await fx.weth.balanceOf(fx.swapAddr);
      const nextIndexBefore = await fx.contract.nextIndex();

      const receipt = await (
        await fx.contract.privateSwap("0x", publicInputs, ROUTES[venue], [])
      ).wait();

      // Exact-input: spent exactly swapAmount of USDC.
      expect(usdcBefore - (await fx.usdc.balanceOf(fx.swapAddr))).to.equal(swapAmount);
      // Received realized WETH (full output, including forfeited surplus).
      const realized = (await fx.weth.balanceOf(fx.swapAddr)) - wethBefore;
      expect(realized).to.be.greaterThan(T);

      // Both output commitments inserted as leaves.
      expect(await fx.contract.nextIndex()).to.equal(nextIndexBefore + 2n);
      // Input nullifiers marked spent.
      expect(await fx.contract.nullifierUsed(publicInputs[1])).to.equal(true);
      expect(await fx.contract.nullifierUsed(publicInputs[2])).to.equal(true);

      const ev = parseEvent(fx.contract, receipt, "PrivateSwapExecuted");
      expect(ev, "PrivateSwapExecuted not emitted").to.not.equal(undefined);
      expect(ev!.args.realizedOutput).to.equal(realized);

      console.log(`    [${venue}] swapped 1000 USDC -> ${ethers.formatEther(realized)} WETH`);
    });

    it("reverts when realized < target output T (sandwich floor)", async () => {
      const publicInputs = swapPublicInputs({
        root: await fx.contract.currentRoot(),
        nullifiers: [BigInt(ethers.id(`${venue}-n3`)), 0n, 0n],
        outputCommitments: [333n, 0n, 0n],
        inputAsset: BASE.USDC,
        inputAmount: 1_000n * USDC_UNIT,
        outputAsset: BASE.WETH,
        targetOutput: ethers.parseEther("1000"), // absurd floor → must revert
      });

      // v4 reverts with our explicit floor; v3's router reverts first with
      // "Too little received" — either way the swap is blocked.
      const floorRevert: Record<Venue, string> = {
        v4: "slippage / sandwich floor",
        v3: "Too little received",
      };
      await expect(
        fx.contract.privateSwap("0x", publicInputs, ROUTES[venue], []),
      ).to.be.revertedWith(floorRevert[venue]);
    });
  });
}

import { getTestingAPI } from "@/helpers/get-testing-api.js";
import { expect } from "chai";
import { ethers } from "ethers";

describe("Counter", () => {
  let counter: ethers.Contract;
  let Signers: ethers.Signer[];

  before(async () => {
    ({ counter, Signers } = await getTestingAPI());
  });

  it("starts at the deployed starting count", async () => {
    expect(await counter.count()).to.equal(0n);
  });

  it("increments by the given amount", async () => {
    await counter.increment(5n);
    expect(await counter.count()).to.equal(5n);

    await counter.increment(3n);
    expect(await counter.count()).to.equal(8n);
  });

  it("emits Incremented with the caller and new count", async () => {
    const caller = await Signers[0].getAddress();
    await expect(counter.increment(2n))
      .to.emit(counter, "Incremented")
      .withArgs(caller, 10n);
  });
});

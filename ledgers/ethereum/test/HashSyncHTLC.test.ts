import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const h = ethers.keccak256(ethers.toUtf8Bytes("dossier TP1 v1"));
const secret = ethers.hexlify(ethers.randomBytes(32));
const q = ethers.sha256(secret);
const syncId = ethers.sha256(ethers.concat([h, q]));

async function deploy() {
  // the deployer (#0) only pays for the deployment, the operator passed to the constructor owns the contract
  const [, operator] = await ethers.getSigners();
  const c = (await ethers.deployContract("HashSyncHTLC", [operator.address])).connect(operator);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  return { c, now };
}

describe("HashSyncHTLC", function () {
  it("adds a record once and keeps it (grow-only, idempotent)", async function () {
    const { c } = await deploy();
    await expect(c.addRecord(h, "TP1")).to.emit(c, "RecordAdded");
    await expect(c.addRecord(h, "TP1")).to.not.emit(c, "RecordAdded");
    expect(await c.hasRecord(h)).to.equal(true);
    expect(await c.recordCount()).to.equal(1n);
    expect(await c.getRecords(0n, 10n)).to.deep.equal([h]);
  });

  it("computes the same syncId as sha256(h || q) off-chain", async function () {
    const { c } = await deploy();
    expect(await c.syncIdOf(h, q)).to.equal(syncId);
  });

  it("lock then claim with the right secret adds the record", async function () {
    const { c, now } = await deploy();
    await expect(c.lock(syncId, h, q, now + 600n, "TP2")).to.emit(c, "Locked");
    expect(await c.hasRecord(h)).to.equal(false);
    await expect(c.claim(syncId, secret)).to.emit(c, "Claimed").withArgs(syncId, h, secret);
    expect(await c.hasRecord(h)).to.equal(true);
    const a = await c.getAttempt(syncId);
    expect(a.status).to.equal(2n);
    expect(a.secret).to.equal(secret);
  });

  it("rejects a wrong secret, a late claim and a duplicate lock", async function () {
    const { c, now } = await deploy();
    await c.lock(syncId, h, q, now + 60n, "TP2");
    await expect(c.lock(syncId, h, q, now + 60n, "TP2")).to.be.revertedWithCustomError(c, "AttemptExists");
    await expect(c.claim(syncId, ethers.ZeroHash.replace(/0$/, "1"))).to.be.revertedWithCustomError(c, "WrongSecret");
    await networkHelpers.time.increase(120);
    await expect(c.claim(syncId, secret)).to.be.revertedWithCustomError(c, "DeadlinePassed");
  });

  it("refund only after the deadline, and the record is never removed", async function () {
    const { c, now } = await deploy();
    await c.addRecord(h, "TP1");
    await c.lock(syncId, h, q, now + 60n, "TP1");
    await expect(c.refund(syncId)).to.be.revertedWithCustomError(c, "DeadlineNotReached");
    await networkHelpers.time.increase(120);
    await expect(c.refund(syncId)).to.emit(c, "Refunded");
    expect((await c.getAttempt(syncId)).status).to.equal(3n);
    expect(await c.hasRecord(h)).to.equal(true);
  });

  it("a new attempt for the same record works after an expiry", async function () {
    const { c, now } = await deploy();
    await c.lock(syncId, h, q, now + 60n, "TP2");
    await networkHelpers.time.increase(120);
    await c.refund(syncId);
    const s2 = ethers.hexlify(ethers.randomBytes(32));
    const q2 = ethers.sha256(s2);
    const id2 = ethers.sha256(ethers.concat([h, q2]));
    const t = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await c.lock(id2, h, q2, t + 600n, "TP2");
    await c.claim(id2, s2);
    expect(await c.hasRecord(h)).to.equal(true);
  });

  it("checks syncId, deadlines and operators", async function () {
    const { c, now } = await deploy();
    await expect(c.lock(ethers.ZeroHash.replace(/0$/, "1"), h, q, now + 60n, "TP2")).to.be.revertedWithCustomError(c, "InvalidSyncId");
    await expect(c.lock(syncId, h, q, now, "TP2")).to.be.revertedWithCustomError(c, "DeadlineInPast");
    const [deployer, , other] = await ethers.getSigners();
    await expect(c.connect(deployer).addRecord(h, "TP1")).to.be.revertedWithCustomError(c, "NotOperator");
    await expect(c.connect(deployer).setOperator(deployer.address, true)).to.be.revertedWithCustomError(c, "NotOperator");
    await expect(c.connect(other).addRecord(h, "TP1")).to.be.revertedWithCustomError(c, "NotOperator");
    await c.setOperator(other.address, true);
    await expect(c.connect(other).addRecord(h, "TP1")).to.emit(c, "RecordAdded");
  });
});

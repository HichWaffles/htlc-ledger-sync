import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("MedicalRecord", function () {
  async function deployMedicalRecord() {
    return ethers.deployContract("MedicalRecord");
  }

  it("stores a patient's hash and emits the version event", async function () {
    const medicalRecord = await deployMedicalRecord();
    const patientId = 42n;
    const recordHash = ethers.keccak256(ethers.toUtf8Bytes("patient record v1"));
    const block = await ethers.provider.getBlock("latest");
    const expectedTimestamp = BigInt(block!.timestamp + 1);

    await expect(medicalRecord.registerRecordHash(patientId, recordHash))
      .to.emit(medicalRecord, "RecordHashStored")
      .withArgs(patientId, 0n, recordHash, expectedTimestamp);

    expect(await medicalRecord.getLatestHash(patientId)).to.equal(recordHash);
    expect(await medicalRecord.getVersionCount(patientId)).to.equal(1n);
  });

  it("verifies a matching hash and rejects a modified hash", async function () {
    const medicalRecord = await deployMedicalRecord();
    const patientId = 7n;
    const recordHash = ethers.keccak256(ethers.toUtf8Bytes("original record"));
    const modifiedHash = ethers.keccak256(ethers.toUtf8Bytes("modified record"));

    await medicalRecord.registerRecordHash(patientId, recordHash);

    expect(await medicalRecord.verifyRecord(patientId, recordHash)).to.equal(true);
    expect(await medicalRecord.verifyRecord(patientId, modifiedHash)).to.equal(false);
  });

  it("reverts when reading a patient without a record", async function () {
    const medicalRecord = await deployMedicalRecord();

    await expect(medicalRecord.getLatestHash(999n))
      .to.be.revertedWithCustomError(medicalRecord, "PatientHasNoRecord")
      .withArgs(999n);
    expect(await medicalRecord.getVersionCount(999n)).to.equal(0n);
  });

  it("keeps every version and exposes its timestamp", async function () {
    const medicalRecord = await deployMedicalRecord();
    const patientId = 11n;
    const firstHash = ethers.keccak256(ethers.toUtf8Bytes("record v1"));
    const secondHash = ethers.keccak256(ethers.toUtf8Bytes("record v2"));

    await medicalRecord.registerRecordHash(patientId, firstHash);
    await medicalRecord.registerRecordHash(patientId, secondHash);

    expect(await medicalRecord.getVersionCount(patientId)).to.equal(2n);
    expect(await medicalRecord.getLatestHash(patientId)).to.equal(secondHash);

    const firstVersion = await medicalRecord.getVersion(patientId, 0n);
    const secondVersion = await medicalRecord.getVersion(patientId, 1n);
    expect(firstVersion.recordHash).to.equal(firstHash);
    expect(secondVersion.recordHash).to.equal(secondHash);
    expect(secondVersion.timestamp).to.be.greaterThanOrEqual(firstVersion.timestamp);
  });

  it("rejects an empty hash", async function () {
    const medicalRecord = await deployMedicalRecord();

    await expect(medicalRecord.registerRecordHash(1n, ethers.ZeroHash))
      .to.be.revertedWithCustomError(medicalRecord, "EmptyRecordHash");
  });
});
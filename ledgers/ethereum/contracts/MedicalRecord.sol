// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

contract MedicalRecord {
  struct RecordVersion {
    bytes32 recordHash;
    uint256 timestamp;
  }

  mapping(uint256 => RecordVersion[]) private records;

  event RecordHashStored(
    uint256 indexed patientId,
    uint256 indexed version,
    bytes32 recordHash,
    uint256 timestamp
  );

  error PatientHasNoRecord(uint256 patientId);
  error EmptyRecordHash();

  function registerRecordHash(uint256 patientId, bytes32 recordHash) external {
    if (recordHash == bytes32(0)) {
      revert EmptyRecordHash();
    }

    uint256 version = records[patientId].length;
    uint256 timestamp = block.timestamp;
    records[patientId].push(RecordVersion(recordHash, timestamp));

    emit RecordHashStored(patientId, version, recordHash, timestamp);
  }

  function getLatestHash(uint256 patientId) external view returns (bytes32) {
    return _latestVersion(patientId).recordHash;
  }

  function verifyRecord(uint256 patientId, bytes32 recordHash)
    external
    view
    returns (bool)
  {
    return _latestVersion(patientId).recordHash == recordHash;
  }

  function getVersionCount(uint256 patientId) external view returns (uint256) {
    return records[patientId].length;
  }

  function getVersion(uint256 patientId, uint256 version)
    external
    view
    returns (bytes32 recordHash, uint256 timestamp)
  {
    if (version >= records[patientId].length) {
      revert PatientHasNoRecord(patientId);
    }

    RecordVersion memory storedVersion = records[patientId][version];
    return (storedVersion.recordHash, storedVersion.timestamp);
  }

  function _latestVersion(uint256 patientId)
    private
    view
    returns (RecordVersion storage)
  {
    uint256 versionCount = records[patientId].length;
    if (versionCount == 0) {
      revert PatientHasNoRecord(patientId);
    }

    return records[patientId][versionCount - 1];
  }
}
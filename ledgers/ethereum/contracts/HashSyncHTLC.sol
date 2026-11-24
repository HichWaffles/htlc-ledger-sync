// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title HashSyncHTLC
/// @notice Grow-only registry of record hashes, synchronised with Hyperledger Fabric through
///         hash time-locked attempts. What is locked is the right to add a record to this ledger:
///         lock(h, q, deadline) opens it, claim(s) with sha256(s) == q before the deadline exercises it,
///         refund() closes it after the deadline. A record, once added, is never removed.
contract HashSyncHTLC {
  enum Status { None, Locked, Claimed, Expired }

  struct Record {
    bool exists;
    string origin;      // "TP1" or "TP2": app that created the record
    uint64 addedAt;
  }

  struct Attempt {
    bytes32 recordHash; // application hash h (the record)
    bytes32 hashlock;   // q = sha256(s)
    uint64 deadline;
    Status status;
    string origin;
    bytes32 secret;     // revealed by claim
  }

  address public immutable owner;
  mapping(address => bool) public operators;

  mapping(bytes32 => Record) private records;
  bytes32[] private recordList;
  mapping(bytes32 => Attempt) private attempts;

  event RecordAdded(bytes32 indexed recordHash, string origin, uint64 addedAt);
  event Locked(bytes32 indexed syncId, bytes32 indexed recordHash, bytes32 hashlock, uint64 deadline, string origin);
  event Claimed(bytes32 indexed syncId, bytes32 indexed recordHash, bytes32 secret);
  event Refunded(bytes32 indexed syncId, bytes32 indexed recordHash);

  error NotOperator();
  error EmptyHash();
  error AttemptExists(bytes32 syncId);
  error UnknownAttempt(bytes32 syncId);
  error NotLocked(bytes32 syncId);
  error DeadlineInPast();
  error DeadlinePassed(bytes32 syncId);
  error DeadlineNotReached(bytes32 syncId);
  error WrongSecret(bytes32 syncId);
  error InvalidSyncId(bytes32 syncId);

  modifier onlyOperator() {
    if (!operators[msg.sender]) revert NotOperator();
    _;
  }

  /// @param operator_ TP1's own key: owner and only operator. The deploying account gets no rights,
  ///        so the node's unlocked test accounts cannot write here.
  constructor(address operator_) {
    owner = operator_;
    operators[operator_] = true;
  }

  function setOperator(address account, bool allowed) external {
    if (msg.sender != owner) revert NotOperator();
    operators[account] = allowed;
  }

  /// @notice syncId = sha256(h || q), identical on Fabric
  function syncIdOf(bytes32 recordHash, bytes32 hashlock) public pure returns (bytes32) {
    return sha256(abi.encodePacked(recordHash, hashlock));
  }

  /// @notice Origin ledger: add a record created by an app on this side (idempotent)
  function addRecord(bytes32 recordHash, string calldata origin) external onlyOperator {
    _add(recordHash, origin);
  }

  /// @notice Open a hash time-locked attempt for a record
  function lock(bytes32 syncId, bytes32 recordHash, bytes32 hashlock, uint64 deadline, string calldata origin)
    external
    onlyOperator
  {
    if (recordHash == bytes32(0) || hashlock == bytes32(0)) revert EmptyHash();
    if (syncId != syncIdOf(recordHash, hashlock)) revert InvalidSyncId(syncId);
    if (attempts[syncId].status != Status.None) revert AttemptExists(syncId);
    if (deadline <= block.timestamp) revert DeadlineInPast();
    attempts[syncId] = Attempt(recordHash, hashlock, deadline, Status.Locked, origin, bytes32(0));
    emit Locked(syncId, recordHash, hashlock, deadline, origin);
  }

  /// @notice Reveal the secret before the deadline: closes the attempt and adds the record if missing
  function claim(bytes32 syncId, bytes32 secret) external onlyOperator {
    Attempt storage a = attempts[syncId];
    if (a.status == Status.None) revert UnknownAttempt(syncId);
    if (a.status != Status.Locked) revert NotLocked(syncId);
    if (block.timestamp >= a.deadline) revert DeadlinePassed(syncId);
    if (sha256(abi.encodePacked(secret)) != a.hashlock) revert WrongSecret(syncId);
    a.status = Status.Claimed;
    a.secret = secret;
    _add(a.recordHash, a.origin);
    emit Claimed(syncId, a.recordHash, secret);
  }

  /// @notice After the deadline an unclaimed attempt is closed. The record (if any) is kept.
  function refund(bytes32 syncId) external onlyOperator {
    Attempt storage a = attempts[syncId];
    if (a.status == Status.None) revert UnknownAttempt(syncId);
    if (a.status != Status.Locked) revert NotLocked(syncId);
    if (block.timestamp < a.deadline) revert DeadlineNotReached(syncId);
    a.status = Status.Expired;
    emit Refunded(syncId, a.recordHash);
  }

  function hasRecord(bytes32 recordHash) external view returns (bool) {
    return records[recordHash].exists;
  }

  function getRecord(bytes32 recordHash) external view returns (Record memory) {
    return records[recordHash];
  }

  function getAttempt(bytes32 syncId) external view returns (Attempt memory) {
    return attempts[syncId];
  }

  function recordCount() external view returns (uint256) {
    return recordList.length;
  }

  function getRecords(uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
    uint256 n = recordList.length;
    if (offset >= n) return new bytes32[](0);
    uint256 end = offset + limit > n ? n : offset + limit;
    page = new bytes32[](end - offset);
    for (uint256 i = offset; i < end; i++) page[i - offset] = recordList[i];
  }

  function _add(bytes32 recordHash, string memory origin) private {
    if (recordHash == bytes32(0)) revert EmptyHash();
    if (records[recordHash].exists) return;
    records[recordHash] = Record(true, origin, uint64(block.timestamp));
    recordList.push(recordHash);
    emit RecordAdded(recordHash, origin, uint64(block.timestamp));
  }
}

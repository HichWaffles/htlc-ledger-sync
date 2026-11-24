# htlc-ledger-sync

> **School work.** This is a coursework project for a university blockchain module (practical sessions TP1 and
> TP2). It is a teaching exercise, not production software: it runs on local test networks with test accounts,
> and the HTLC is used for ledger synchronisation because the assignment requires it, not because it is the right
> primitive for that job (see the [report](docs/REPORT.md), sections 2 and 7).

Two medical-record apps on two ledgers, kept in sync with hash time-locked contracts (HTLC), without a bridge:

* **TP1** (http://localhost:3000) stores dossier fingerprints on **Ethereum** (Hardhat).
* **TP2** (http://localhost:3001) stores them on **Hyperledger Fabric** (test-network).
* A record added on one ledger is copied to the other: each app writes only its own ledger and watches the other.
* A read-only **monitor** (http://localhost:3200) shows both ledgers, every synchronisation step by step, and a
  "Vérifier la synchronisation" button that checks every record on both ledgers.

Report: [`docs/REPORT.md`](docs/REPORT.md) ([PDF](docs/REPORT.pdf)) · plan: [`docs/REPORT_PLAN.md`](docs/REPORT_PLAN.md) ([PDF](docs/REPORT_PLAN.pdf))

## Quick start

Linux or WSL2 (Ubuntu) with Docker, Node.js 20+, git, curl and jq. On Windows, work **inside WSL** (not under `/mnt/c`).

```bash
git clone https://github.com/HichWaffles/htlc-ledger-sync.git ~/htlc-ledger-sync && cd ~/htlc-ledger-sync
npm run setup     # checks tools, gets Fabric 2.5 if missing, installs packages, writes the .env files
npm start         # Hardhat + contracts, Fabric + chaincodes, both apps, monitor
```

Test accounts (both apps): `ali.medecin@test.com` / `Medecin123!` (doctor), `ahmed.patient@test.com` / `Patient123!`.
Full steps, including MetaMask for TP1: [report, section 5](docs/REPORT.md#5-running-it).

| Command | Does |
|---|---|
| `npm run setup` | one-time setup; reuse a Fabric install with `FABRIC_SAMPLES=/path/to/fabric-samples npm run setup` |
| `npm start` / `npm stop` / `npm run status` | start, stop (Fabric ledger kept), show what runs; logs in `.run/logs/` |
| `npm run demo:eth-record` | adds a record on Ethereum only; reconciliation copies it to Fabric |
| `npm run demo:unauthorized` | shows that Hardhat's test accounts cannot write to the sync contract |
| `npm test` | contract and chaincode unit tests |
| `npm run reset` | erases the Fabric ledger and both app databases |
| `ANON_TERMS="first name,last name" npm run check:anonymous` | before a push: commit authors, local files, paths and the given words ([report 5.1](docs/REPORT.md#51-publishing-once)) |

## Layout

```
apps/tp1-ethereum/     TP1 web app (Express, SQLite, MetaMask page)
apps/tp2-fabric/       TP2 web app (Express, SQLite, Fabric Gateway)
sync/                  HTLC sync engine shared by both apps (@htlc/sync)
monitor/               read-only monitor
ledgers/ethereum/      Hardhat project: MedicalRecord, HashSyncHTLC (+ tests)
ledgers/fabric/        chaincodes: documents, hashsync-htlc (+ tests)
scripts/               setup, start, stop, status, reset, test, configure, md2pdf
tools/                 demo scripts
docs/                  report, plan, screenshots
```

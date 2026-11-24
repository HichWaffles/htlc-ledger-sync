# Report plan: synchronising Ethereum and Hyperledger Fabric with HTLCs

**Hichem Hamza** · GI3 S3

Draft text for every part is in `docs/REPORT.md`; figures are in `docs/images/`.

| # | Part | Content | Figures | Sources |
|---|---|---|---|---|
| 1 | Goal | Two apps, two ledgers (TP1 Ethereum, TP2 Fabric); a record added on one must reach the other through an HTLC; no bridge | | |
| 2 | HTLC: definition and intended use | Hashlock + timelock; built for exchanges of value between distrustful parties: atomic swaps, Lightning, Fabric/Corda asset exchange; explicit statement that record sync is not its purpose | | [1] to [7] |
| 3 | Architecture | Each app writes only its own ledger and reads the other; who signs and who pays (TP1 key and gas, Org1 certificate, no fees on Fabric) | architecture diagram | |
| 4 | Protocol | Lock, detect, lock, publish secret, claim, confirm; `T_B > T_A`; refund and retry; reconciliation | sequence diagram, state diagram | |
| 5 | Running it | Publishing: identity check, public GitHub repository, `git clone`; prerequisites; `npm run setup`, `npm start`; test accounts; MetaMask; demos; verify button; stop and reset | | |
| 6 | Results | Both directions timed, recovery after a ledger reset, expiry and retry, refused accounts, unit tests | monitor screenshots, TP2 page | |
| 7 | Assessment | Not the intended use of an HTLC (wrong primitive); time-lock second-order effects; works only thanks to the components we added; 7 drawbacks; 4 advantages; better alternatives | | [8] to [16] |
| 8 | Implementing the approach | Pseudocode: ledger side (`lock`, `claim`, `refund`) and app side (origin, responder, reconciliation) | | |
| | Sources | 16 references | | |

**Style:** first person, short sentences, English body with the TP's French titles, no em dashes, intros of two
sentences at most. **Length target:** 6 to 8 pages including figures.

**Figures** (`docs/images/`, 2x resolution): in the report, a full synchronisation with its two time locks, a lock
running out, a lock refunded, and the verification button. Extra screenshots for the final report: monitor overview,
records table, both doctor pages.

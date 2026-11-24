import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// operator = TP1's own address (key in apps/tp1-ethereum/.env, SYNC_ETH_OPERATOR_KEY), written to
// ignition/parameters.json by scripts/setup.sh.
// The deploying account only pays for the deployment and the funding; it gets no rights on the contract.
export default buildModule("HashSyncHTLCModule", (m) => {
  const operator = m.getParameter("operator");
  const hashSync = m.contract("HashSyncHTLC", [operator]);
  // test ETH so the operator can pay the gas of the HTLC steps
  m.send("FundOperator", operator, 10n * 10n ** 18n);
  return { hashSync };
});

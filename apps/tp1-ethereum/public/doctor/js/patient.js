// public/doctor/js/patient.js
requireRole('medecin');
document.getElementById('doctorName').textContent = 'Dr ' + (localStorage.getItem('name') || '');

const params = new URLSearchParams(window.location.search);
const patientId = params.get('id');
if (!patientId) window.location.href = 'dashboard.html';

const saveToBlockchainBtn = document.getElementById('saveToBlockchainBtn');

let currentDossier = null;
let provider = null;
let signer = null;

const abi = [
  "function registerRecordHash(uint256 patientId, bytes32 recordHash) external",
  "function getLatestHash(uint256 patientId) external view returns (bytes32)",
  "function verifyRecord(uint256 patientId, bytes32 recordHash) external view returns (bool)",
  "function getVersionCount(uint256 patientId) external view returns (uint256)",
  "function getVersion(uint256 patientId, uint256 version) external view returns (bytes32 recordHash, uint256 timestamp)",
  "event RecordHashStored(uint256 indexed patientId, uint256 indexed version, bytes32 recordHash, uint256 timestamp)"
];

const updateInfo = async () => {
  const dossierInfo = await getDossierInformation();
  if (!dossierInfo) return;

  document.getElementById('dossierVersionCount').textContent = dossierInfo.versionCount > 0 ? `Nombre de versions sur la blockchain: ${dossierInfo.versionCount}` : 'Aucune version enregistrée sur la blockchain.';
  document.getElementById('dossierLastHash').textContent = dossierInfo.lastHash ? `Dernier hash enregistré: ${dossierInfo.lastHash}` : 'Aucun hash enregistré.';
  document.getElementById('hasSubmitted').textContent = dossierInfo.hasCount ? 'Le dossier a été soumis au moins une fois.' : 'Le dossier n\'a jamais été soumis.';
}

const connectBtn = document.getElementById('connectBtn');
const accountDisplay = document.getElementById('accountDisplay');
const verifyRecordBtn = document.getElementById('verifyRecord');
const networkDisplay = document.getElementById('networkDisplay');
const connectStatus = document.getElementById('connectStatus');
const blockchainStatus = document.getElementById('blockchainStatus');

// Affiche un message dans la page (succès en vert, erreur en rouge) au lieu d'une alert()
function showStatus(el, html, ok) {
  el.className = ok ? 'success-msg' : 'error-msg';
  el.innerHTML = html;
}

// Adresse du contrat MedicalRecord, fournie par le serveur (GET /api/config) au premier usage
let contractAddress = null;
async function loadContractAddress() {
  if (contractAddress) return contractAddress;
  const res = await fetch('/api/config');
  const cfg = await res.json();
  if (!res.ok || !cfg.medicalRecord) throw new Error(cfg.error || 'Adresse du contrat MedicalRecord inconnue');
  contractAddress = cfg.medicalRecord;
  return contractAddress;
}
const EXPECTED_CHAIN_ID = 31337n; // Hardhat node local
const HARDHAT_CHAIN_HEX = '0x7a69'; // 31337 en hexadécimal

let chainListenerAdded = false;

// Demande à MetaMask de basculer sur le réseau Hardhat local (et de l'ajouter s'il est inconnu)
async function switchToHardhatNetwork() {
  const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
  if (BigInt(currentChainId) === EXPECTED_CHAIN_ID) return;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: HARDHAT_CHAIN_HEX }],
    });
  } catch (error) {
    // 4902 : réseau inconnu de MetaMask -> on l'ajoute (MetaMask bascule ensuite dessus)
    const code = error.code ?? error.data?.originalError?.code;
    if (code !== 4902) throw error;
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: HARDHAT_CHAIN_HEX,
        chainName: 'Hardhat Local',
        rpcUrls: ['http://127.0.0.1:8545'],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      }],
    });
  }
}

const connect = async () => {
  if (typeof window.ethereum !== 'undefined') {
    try {
      // Demander l'accès aux comptes
      await window.ethereum.request({ method: 'eth_requestAccounts' });

      // Basculer sur Hardhat avant de créer le provider : ethers refuse un changement de réseau après coup
      await switchToHardhatNetwork();

      // Ethers v6: utilisation de BrowserProvider
      provider = new ethers.BrowserProvider(window.ethereum);

      // Récupérer le signataire (le compte connecté)
      signer = await provider.getSigner();
      const address = await signer.getAddress();

      // Afficher l'adresse
      accountDisplay.textContent = address;
      accountDisplay.classList.remove('text-muted');
      connectBtn.textContent = 'Connecté';
      connectBtn.classList.replace('primary', 'secondary');

      // Récupérer le réseau
      const network = await provider.getNetwork();
      networkDisplay.textContent = `${network.name} (Chain ID: ${network.chainId})`;
      networkDisplay.classList.remove('text-muted');

      // Si le réseau change ensuite dans MetaMask, on recharge pour repartir d'un état propre
      if (!chainListenerAdded && window.ethereum.on) {
        window.ethereum.on('chainChanged', () => window.location.reload());
        chainListenerAdded = true;
      }

      showStatus(connectStatus, 'MetaMask connecté.', true);
      await updateInfo();
    } catch (error) {
      console.error("Erreur de connexion:", error);
      if (error.code === 4001) {
        showStatus(connectStatus, "Connexion annulée dans MetaMask. Acceptez la connexion et le passage au réseau Hardhat Local (Chain ID 31337) pour continuer.", false);
      } else {
        showStatus(connectStatus, "Erreur de connexion à MetaMask: " + (error.reason || error.message), false);
      }
    }
  } else {
    showStatus(connectStatus, "MetaMask n'est pas installé ! Veuillez l'installer pour continuer.", false);
  }
}



connectBtn.addEventListener('click', connect);

async function loadDossier() {
  try {
    const dossier = await apiFetch(`/api/doctor/patients/${patientId}/dossier`);
    currentDossier = dossier;
    renderPatientInfo(dossier.patient);
    renderHistory(dossier.consultations);
    renderConsultationSelect(dossier.consultations);
  } catch (err) {
    alert(err.message);
  }
}

function renderPatientInfo(patient) {
  document.getElementById('patientName').textContent = patient.name;
  document.getElementById('patientDetails').textContent =
    `${patient.email} · Né(e) le ${patient.birth_date || 'N/A'} · ${patient.gender || ''}`;
}

function renderConsultationSelect(consultations) {
  const select = document.getElementById('targetConsultation');
  select.innerHTML = '';
  if (consultations.length === 0) {
    select.innerHTML = '<option value="">Aucune consultation - créez-en une d\'abord</option>';
    return;
  }
  consultations.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${formatDate(c.date)} — ${c.reason || 'Sans motif'}`;
    select.appendChild(opt);
  });
}

function renderHistory(consultations) {
  const container = document.getElementById('historyContainer');
  container.innerHTML = '';

  if (consultations.length === 0) {
    container.innerHTML = '<div class="empty-state">Aucune consultation enregistrée.</div>';
    return;
  }

  consultations.forEach((c) => {
    const block = document.createElement('div');
    block.className = 'consultation-block';

    let diagnosticsHtml = c.diagnostics.length
      ? '<ul class="sub-list">' + c.diagnostics.map(d => `<li>🩺 ${d.description}</li>`).join('') + '</ul>'
      : '<p style="font-size:13px;color:#94a3b8;">Aucun diagnostic.</p>';

    let prescriptionsHtml = c.prescriptions.length
      ? '<ul class="sub-list">' + c.prescriptions.map(p =>
        `<li>💊 <strong>${p.medication}</strong> ${p.dosage ? '- ' + p.dosage : ''} ${p.duration ? '(' + p.duration + ')' : ''}${p.instructions ? '<br><em>' + p.instructions + '</em>' : ''}</li>`
      ).join('') + '</ul>'
      : '<p style="font-size:13px;color:#94a3b8;">Aucune prescription.</p>';

    block.innerHTML = `
      <div class="consultation-header">
        <span class="date">${formatDate(c.date)}</span>
      </div>
      <p><strong>Motif:</strong> ${c.reason || '-'}</p>
      <p><strong>Notes:</strong> ${c.notes || '-'}</p>
      <p><strong>Diagnostics</strong></p>
      ${diagnosticsHtml}
      <p><strong>Prescriptions</strong></p>
      ${prescriptionsHtml}
    `;
    container.appendChild(block);
  });
}

document.getElementById('consultationForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('consultationError');
  errorEl.textContent = '';
  try {
    await apiFetch('/api/doctor/consultations', {
      method: 'POST',
      body: JSON.stringify({
        patient_id: Number(patientId),
        reason: document.getElementById('reason').value,
        notes: document.getElementById('notes').value,
      }),
    });
    document.getElementById('consultationForm').reset();
    loadDossier();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('diagnosticForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('subFormError');
  errorEl.textContent = '';
  const consultationId = document.getElementById('targetConsultation').value;
  if (!consultationId) {
    errorEl.textContent = 'Créez d\'abord une consultation.';
    return;
  }
  try {
    await apiFetch('/api/doctor/diagnostics', {
      method: 'POST',
      body: JSON.stringify({
        consultation_id: Number(consultationId),
        description: document.getElementById('diagnosticDescription').value,
      }),
    });
    document.getElementById('diagnosticForm').reset();
    loadDossier();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

function jsonConsultation() {
  const consultationId = document.getElementById('targetConsultation').value;
  if (!consultationId) {
    alert('Créez d\'abord une consultation.');
    return;
  }
  const consultationData = {
    consultation_id: Number(consultationId),
    medication: document.getElementById('medication').value,
    dosage: document.getElementById('dosage').value,
    duration: document.getElementById('duration').value,
    instructions: document.getElementById('instructions').value,
  }

  return consultationData;
}

function calculateHash(data) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(data)));
}

document.getElementById('prescriptionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('subFormError');
  errorEl.textContent = '';
  const consultationId = document.getElementById('targetConsultation').value;
  if (!consultationId) {
    errorEl.textContent = 'Créez d\'abord une consultation.';
    return;
  }
  try {
    await apiFetch('/api/doctor/prescriptions', {
      method: 'POST',
      body: JSON.stringify(jsonConsultation()),
    });
    document.getElementById('prescriptionForm').reset();
    loadDossier();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

loadDossier();

async function getDossierInformation() {
  if (!currentDossier || !provider) return null;

  try {
    const network = await provider.getNetwork();
    if (network.chainId !== EXPECTED_CHAIN_ID) {
      showStatus(blockchainStatus, `MetaMask est connecté au mauvais réseau (Chain ID ${network.chainId}). Sélectionnez le réseau Hardhat local (http://127.0.0.1:8545, Chain ID 31337).`, false);
      return null;
    }

    await loadContractAddress();
    const code = await provider.getCode(contractAddress);
    if (!code || code === '0x' || code === '0x0') {
      console.warn(`Aucun smart contract trouvé à l'adresse ${contractAddress} sur ce réseau.`);
      showStatus(blockchainStatus, `Erreur: aucun smart contract n'est déployé à l'adresse ${contractAddress} sur le réseau connecté. Vérifiez que Hardhat node est actif (Chain ID 31337) et que le contrat a été déployé.`, false);
      return null;
    }
    console.log(patientId, currentDossier);

    // Get the number of versions stored on the blockchain for this patient
    const contract = new ethers.Contract(await loadContractAddress(), abi, provider);
    const versionCount = await contract.getVersionCount(Number(patientId));

    let lastHash = null;
    if (versionCount > 0n) {
      lastHash = await contract.getLatestHash(Number(patientId));
    }

    return {
      versionCount: Number(versionCount),
      lastHash: lastHash,
      hasCount: versionCount > 0n,
    };
  } catch (err) {
    console.error('Erreur lors de la récupération des infos blockchain:', err);
    showStatus(blockchainStatus, 'Erreur blockchain: ' + (err.reason || err.message), false);
    return null;
  }
}

const verifyRecord = async () => {
  if (!currentDossier) {
    showStatus(blockchainStatus, 'Aucun dossier chargé.', false);
    return;
  }

  if (!provider) {
    showStatus(blockchainStatus, 'Veuillez d\'abord connecter MetaMask.', false);
    return;
  }

  try {
    const contract = new ethers.Contract(await loadContractAddress(), abi, provider);
    const versionCount = await contract.getVersionCount(Number(patientId));

    if (versionCount === 0n) {
      showStatus(blockchainStatus, 'Aucune version n\'a encore été enregistrée sur la blockchain pour ce patient.', false);
      return;
    }

    const recordHash = calculateHash(currentDossier);
    const isValid = await contract.verifyRecord(Number(patientId), recordHash);

    if (isValid) {
      showStatus(blockchainStatus, '<strong>Intégrité vérifiée</strong> : le dossier correspond à la version enregistrée sur la blockchain.', true);
    } else {
      showStatus(blockchainStatus, '<strong>Intégrité compromise</strong> : le dossier a été modifié depuis son dernier enregistrement sur la blockchain.', false);
    }
  } catch (err) {
    console.error('Erreur vérification dossier:', err);
    showStatus(blockchainStatus, 'Erreur lors de la vérification : ' + (err.reason || err.message), false);
  }
};

verifyRecordBtn.addEventListener('click', verifyRecord);

saveToBlockchainBtn.addEventListener('click', async () => {
  if (!currentDossier) {
    showStatus(blockchainStatus, 'Aucun dossier chargé.', false);
    return;
  }

  if (!signer) {
    showStatus(blockchainStatus, 'Veuillez d\'abord connecter MetaMask.', false);
    return;
  }

  const recordHash = calculateHash(currentDossier);

  const payload = {
    patient_id: Number(patientId),
    record_hash: recordHash,
  };

  try {
    const contract = new ethers.Contract(await loadContractAddress(), abi, signer);
    showStatus(blockchainStatus, 'Validez la transaction dans MetaMask…', true);
    const tx = await contract.registerRecordHash(payload.patient_id, payload.record_hash);
    showStatus(blockchainStatus, 'Transaction envoyée, en attente de confirmation…', true);
    await tx.wait();

    // Synchronisation HTLC : le serveur vérifie ce hash sur Ethereum puis le fait parvenir à Fabric
    let syncInfo = '';
    try {
      const sync = await apiFetch(`/api/doctor/patients/${patientId}/sync`, {
        method: 'POST',
        body: JSON.stringify({ hash: recordHash }),
      });
      syncInfo = ` Synchronisation vers Fabric lancée (${sync.syncId.slice(0, 10)}…).`;
    } catch (err) {
      syncInfo = ` Synchronisation vers Fabric non lancée : ${err.message}`;
    }

    await loadDossier();
    await updateInfo();
    showStatus(blockchainStatus, `Dossier enregistré sur la blockchain avec succès ! (transaction ${tx.hash})${syncInfo}`, true);
  } catch (err) {
    console.error('Erreur enregistrement blockchain:', err);
    showStatus(blockchainStatus, 'Erreur lors de l\'enregistrement sur la blockchain: ' + (err.reason || err.message), false);
  }
});

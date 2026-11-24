// public/doctor/js/patient.js
requireRole('medecin');
document.getElementById('doctorName').textContent = 'Dr ' + (localStorage.getItem('name') || '');

const params = new URLSearchParams(window.location.search);
const patientId = params.get('id');
if (!patientId) window.location.href = 'dashboard.html';

// Hyperledger Fabric : le dossier reste dans la base SQLite, le serveur calcule son empreinte
// SHA-256 et l'enregistre / la vérifie avec le chaincode "documents" (identité User1@org1).
const saveToBlockchainBtn = document.getElementById('saveToBlockchainBtn');
const verifyRecordBtn = document.getElementById('verifyRecord');
const connectBtn = document.getElementById('connectBtn');
const accountDisplay = document.getElementById('accountDisplay');
const networkDisplay = document.getElementById('networkDisplay');
const connectStatus = document.getElementById('connectStatus');
const blockchainStatus = document.getElementById('blockchainStatus');

let currentDossier = null;
let fabricConnected = false;

// Affiche un message dans la page (succès en vert, erreur en rouge)
function showStatus(el, html, ok) {
  el.className = ok ? 'success-msg' : 'error-msg';
  el.innerHTML = html;
}

function renderDossierInfo(info) {
  document.getElementById('dossierVersionCount').textContent = info.versionCount > 0 ? `Nombre de versions sur la blockchain: ${info.versionCount}` : 'Aucune version enregistrée sur la blockchain.';
  document.getElementById('dossierLastHash').textContent = info.lastHash ? `Dernier hash enregistré: ${info.lastHash}` : 'Aucun hash enregistré.';
  document.getElementById('hasSubmitted').textContent = info.versionCount > 0 ? 'Le dossier a été soumis au moins une fois.' : 'Le dossier n\'a jamais été soumis.';
}

const updateInfo = async () => {
  const info = await apiFetch(`/api/doctor/patients/${patientId}/blockchain`);
  renderDossierInfo(info);
  return info;
};

// Connexion au réseau Fabric : le serveur utilise l'identité de l'organisation (pas de MetaMask)
const connect = async () => {
  try {
    const info = await updateInfo();
    const id = info.identity;
    accountDisplay.textContent = `${id.user} (${id.mspId})`;
    accountDisplay.classList.remove('text-muted');
    networkDisplay.textContent = `channel ${id.channel} · chaincode ${id.chaincode} · peer ${id.peer}`;
    networkDisplay.classList.remove('text-muted');
    connectBtn.textContent = 'Connecté';
    connectBtn.classList.replace('primary', 'secondary');
    fabricConnected = true;
    showStatus(connectStatus, 'Connecté au réseau Hyperledger Fabric.', true);
  } catch (err) {
    console.error('Erreur de connexion Fabric:', err);
    showStatus(connectStatus, 'Connexion à Fabric impossible : ' + err.message + ' (le réseau test-network est-il démarré ?)', false);
  }
};

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

const verifyRecord = async () => {
  if (!currentDossier) {
    showStatus(blockchainStatus, 'Aucun dossier chargé.', false);
    return;
  }

  if (!fabricConnected) {
    showStatus(blockchainStatus, 'Veuillez d\'abord vous connecter à Fabric.', false);
    return;
  }

  try {
    const r = await apiFetch(`/api/doctor/patients/${patientId}/blockchain/verify`, { method: 'POST' });

    if (!r.Exists) {
      showStatus(blockchainStatus, 'Aucune version n\'a encore été enregistrée sur la blockchain pour ce patient.', false);
    } else if (r.Valid) {
      showStatus(blockchainStatus, '<strong>Intégrité vérifiée</strong> : le dossier correspond à la version enregistrée sur la blockchain.', true);
    } else {
      showStatus(blockchainStatus, '<strong>Intégrité compromise</strong> : le dossier a été modifié depuis son dernier enregistrement sur la blockchain.', false);
    }
  } catch (err) {
    console.error('Erreur vérification dossier:', err);
    showStatus(blockchainStatus, 'Erreur lors de la vérification : ' + err.message, false);
  }
};

verifyRecordBtn.addEventListener('click', verifyRecord);

saveToBlockchainBtn.addEventListener('click', async () => {
  if (!currentDossier) {
    showStatus(blockchainStatus, 'Aucun dossier chargé.', false);
    return;
  }

  if (!fabricConnected) {
    showStatus(blockchainStatus, 'Veuillez d\'abord vous connecter à Fabric.', false);
    return;
  }

  try {
    saveToBlockchainBtn.disabled = true;
    showStatus(blockchainStatus, 'Transaction envoyée à Fabric, en attente de validation par Org1, Org2 et l\'orderer…', true);
    const r = await apiFetch(`/api/doctor/patients/${patientId}/blockchain`, { method: 'POST' });

    await loadDossier();
    await updateInfo();
    showStatus(blockchainStatus, `Dossier enregistré sur la blockchain avec succès ! (transaction ${r.txId}, bloc ${r.block})`, true);
  } catch (err) {
    console.error('Erreur enregistrement blockchain:', err);
    showStatus(blockchainStatus, 'Erreur lors de l\'enregistrement sur la blockchain: ' + err.message, false);
  } finally {
    saveToBlockchainBtn.disabled = false;
  }
});

// public/patient/js/dashboard.js
requireRole('patient');
document.getElementById('patientNameTop').textContent = localStorage.getItem('name') || '';

const profileForm = document.getElementById('profileForm');
const profileName = document.getElementById('profileName');
const profileEmail = document.getElementById('profileEmail');
const profilePassword = document.getElementById('profilePassword');
const profileBirthDate = document.getElementById('profileBirthDate');
const profileGender = document.getElementById('profileGender');
const profileMessage = document.getElementById('profileMessage');

function showProfileForm(profile) {
  profileName.value = profile.name || '';
  profileEmail.value = profile.email || '';
  profilePassword.value = '';
  profileBirthDate.value = profile.birth_date || '';
  profileGender.value = profile.gender || '';
  profileMessage.textContent = '';
  profileForm.hidden = false;
  profileName.focus();
}

function hideProfileForm() {
  profileForm.hidden = true;
  profileMessage.textContent = '';
}

document.getElementById('editProfileButton').addEventListener('click', () => {
  loadProfile().then(showProfileForm).catch((err) => {
    profileMessage.textContent = err.message;
  });
});

document.getElementById('cancelProfileButton').addEventListener('click', hideProfileForm);

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  profileMessage.className = 'error-msg';
  const payload = {
    name: profileName.value.trim(),
    email: profileEmail.value.trim(),
    password: profilePassword.value,
    birth_date: profileBirthDate.value,
    gender: profileGender.value.trim(),
  };

  try {
    const data = await apiFetch('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    localStorage.setItem('token', data.token);
    localStorage.setItem('name', data.user.name);
    await loadProfile();
    hideProfileForm();
  } catch (err) {
    profileMessage.textContent = err.message;
  }
});

async function loadProfile() {
  try {
    const profile = await apiFetch('/api/patient/profile');
    localStorage.setItem('name', profile.name);
    document.getElementById('patientNameTop').textContent = profile.name;
    document.getElementById('profileDetails').textContent =
      `${profile.name} · ${profile.email} · Né(e) le ${profile.birth_date || 'N/A'} · ${profile.gender || ''}`;
    return profile;
  } catch (err) {
    console.error(err);
    throw err;
  }
}

async function loadDossier() {
  try {
    const dossier = await apiFetch('/api/patient/dossier');
    const container = document.getElementById('dossierContainer');
    container.innerHTML = '';

    if (dossier.consultations.length === 0) {
      container.innerHTML = '<div class="empty-state">Aucune consultation pour le moment.</div>';
      return;
    }

    dossier.consultations.forEach((c) => {
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
          <span class="badge">Dr ${c.doctor_name}</span>
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
  } catch (err) {
    console.error(err);
  }
}

loadProfile();
loadDossier();

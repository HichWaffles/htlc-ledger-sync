// public/doctor/js/dashboard.js
requireRole('medecin');
document.getElementById('doctorName').textContent = 'Dr ' + (localStorage.getItem('name') || '');

const profileForm = document.getElementById('profileForm');
const profileName = document.getElementById('profileName');
const profileEmail = document.getElementById('profileEmail');
const profilePassword = document.getElementById('profilePassword');
const profileSpecialty = document.getElementById('profileSpecialty');
const profileMessage = document.getElementById('profileMessage');

function showProfileForm(profile) {
  profileName.value = profile.name || '';
  profileEmail.value = profile.email || '';
  profilePassword.value = '';
  profileSpecialty.value = profile.specialty || '';
  profileMessage.textContent = '';
  profileForm.hidden = false;
  profileName.focus();
}

function hideProfileForm() {
  profileForm.hidden = true;
  profileMessage.textContent = '';
}

async function loadProfile() {
  const profile = await apiFetch('/api/auth/profile');
  localStorage.setItem('name', profile.name);
  document.getElementById('doctorName').textContent = 'Dr ' + profile.name;
  document.getElementById('profileDetails').textContent =
    `${profile.name} · ${profile.email} · ${profile.specialty || 'Spécialité N/A'}`;
  return profile;
}

document.getElementById('editProfileButton').addEventListener('click', async () => {
  try {
    showProfileForm(await loadProfile());
  } catch (err) {
    profileMessage.textContent = err.message;
  }
});

document.getElementById('cancelProfileButton').addEventListener('click', hideProfileForm);

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  profileMessage.textContent = '';

  try {
    const data = await apiFetch('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({
        name: profileName.value.trim(),
        email: profileEmail.value.trim(),
        password: profilePassword.value,
        specialty: profileSpecialty.value.trim(),
      }),
    });
    localStorage.setItem('token', data.token);
    localStorage.setItem('name', data.user.name);
    await loadProfile();
    hideProfileForm();
  } catch (err) {
    profileMessage.textContent = err.message;
  }
});

async function loadPatients() {
  try {
    const patients = await apiFetch('/api/doctor/patients');
    const tbody = document.getElementById('patientsBody');
    const emptyState = document.getElementById('emptyState');
    tbody.innerHTML = '';

    if (patients.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    patients.forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${p.name}</td>
        <td>${p.email}</td>
        <td>${p.birth_date || '-'}</td>
        <td>${p.gender || '-'}</td>
        <td><button class="link-btn" onclick="openPatient(${p.patient_id})">Voir le dossier →</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    alert(err.message);
  }
}

function openPatient(patientId) {
  window.location.href = `patient.html?id=${patientId}`;
}

loadPatients();
loadProfile().catch((err) => console.error(err));

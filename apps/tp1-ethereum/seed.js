// seed.js : donnees de test pour la base SQLite de cette application.
// Usage : npm run seed   (ne fait rien si les comptes existent deja)
// Comptes de TEST uniquement (base locale de developpement).
require('dotenv').config();
const db = require('./config/db');
const { hashPassword } = require('./utils/password');

const DOCTOR = { name: 'Ali Ben Salah', email: 'ali.medecin@test.com', password: 'Medecin123!', specialty: 'Médecine générale' };
const PATIENT = { name: 'Ahmed Trabelsi', email: 'ahmed.patient@test.com', password: 'Patient123!', birth_date: '1995-05-14', gender: 'Homme' };

const seed = db.transaction(() => {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(DOCTOR.email)) return false;

  const d = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
    .run(DOCTOR.name, DOCTOR.email, hashPassword(DOCTOR.password), 'medecin');
  const doctorId = db.prepare('INSERT INTO doctor_profiles (user_id, specialty) VALUES (?, ?)')
    .run(d.lastInsertRowid, DOCTOR.specialty).lastInsertRowid;

  const p = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
    .run(PATIENT.name, PATIENT.email, hashPassword(PATIENT.password), 'patient');
  const patientId = db.prepare('INSERT INTO patient_profiles (user_id, birth_date, gender) VALUES (?, ?, ?)')
    .run(p.lastInsertRowid, PATIENT.birth_date, PATIENT.gender).lastInsertRowid;
  db.prepare('INSERT INTO patient_doctor_assignments (patient_id, doctor_id) VALUES (?, ?)').run(patientId, doctorId);

  const c = db.prepare('INSERT INTO consultations (patient_id, doctor_id, reason, notes) VALUES (?, ?, ?, ?)')
    .run(patientId, doctorId, 'Maux de tête', 'Examen clinique normal');
  db.prepare('INSERT INTO diagnostics (consultation_id, description) VALUES (?, ?)').run(c.lastInsertRowid, 'Céphalée de tension');
  db.prepare('INSERT INTO prescriptions (consultation_id, medication, dosage, duration) VALUES (?, ?, ?, ?)')
    .run(c.lastInsertRowid, 'Paracétamol', '500mg, 3x/jour', '5 jours');
  return true;
});

console.log(seed() ? 'Base initialisée (comptes de test dans seed.js).' : 'Comptes de test déjà présents, rien à faire.');

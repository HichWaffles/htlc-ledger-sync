// routes/doctor.routes.js
const express = require('express');
const db = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken, requireRole('medecin'));

// GET /api/doctor/patients
// Liste des patients assignes a ce medecin seulement.
router.get('/patients', (req, res) => {
  const doctorProfileId = req.user.profileId;

  const patients = db
    .prepare(
      `SELECT pp.id as patient_id, u.name, u.email, pp.birth_date, pp.gender
       FROM patient_doctor_assignments pda
       JOIN patient_profiles pp ON pp.id = pda.patient_id
       JOIN users u ON u.id = pp.user_id
       WHERE pda.doctor_id = ?
       ORDER BY u.name ASC`
    )
    .all(doctorProfileId);

  res.json(patients);
});

// Fonction utilitaire: construit le dossier medical complet d'un patient
function buildDossier(patientId, doctorProfileId = null) {
  const patient = db
    .prepare(
      `SELECT pp.id as patient_id, u.name, u.email, pp.birth_date, pp.gender
       FROM patient_profiles pp JOIN users u ON u.id = pp.user_id
       WHERE pp.id = ?`
    )
    .get(patientId);

  if (!patient) return null;

  if (doctorProfileId) {
    const assignment = db
      .prepare('SELECT 1 FROM patient_doctor_assignments WHERE patient_id = ? AND doctor_id = ?')
      .get(patientId, doctorProfileId);

    if (!assignment) {
      return null;
    }
  }

  const consultations = db
    .prepare(
      `SELECT c.id, c.date, c.reason, c.notes, u.name as doctor_name
       FROM consultations c
       JOIN doctor_profiles dp ON dp.id = c.doctor_id
       JOIN users u ON u.id = dp.user_id
       WHERE c.patient_id = ?
       ORDER BY c.date DESC`
    )
    .all(patientId);

  const consultationIds = consultations.map((c) => c.id);

  let diagnostics = [];
  let prescriptions = [];
  if (consultationIds.length > 0) {
    const placeholders = consultationIds.map(() => '?').join(',');
    diagnostics = db
      .prepare(
        `SELECT * FROM diagnostics WHERE consultation_id IN (${placeholders}) ORDER BY created_at DESC`
      )
      .all(...consultationIds);
    prescriptions = db
      .prepare(
        `SELECT * FROM prescriptions WHERE consultation_id IN (${placeholders}) ORDER BY created_at DESC`
      )
      .all(...consultationIds);
  }

  const consultationsWithDetails = consultations.map((c) => ({
    ...c,
    diagnostics: diagnostics.filter((d) => d.consultation_id === c.id),
    prescriptions: prescriptions.filter((p) => p.consultation_id === c.id),
  }));

  return { patient, consultations: consultationsWithDetails };
}

// GET /api/doctor/patients/:id/dossier
router.get('/patients/:id/dossier', (req, res) => {
  const dossier = buildDossier(Number(req.params.id), req.user.profileId);
  if (!dossier) return res.status(404).json({ error: 'Patient introuvable ou non assigne a ce medecin.' });
  res.json(dossier);
});

// GET /api/doctor/patients/:id/historique  (alias explicite demande par le besoin fonctionnel)
router.get('/patients/:id/historique', (req, res) => {
  const dossier = buildDossier(Number(req.params.id), req.user.profileId);
  if (!dossier) return res.status(404).json({ error: 'Patient introuvable ou non assigne a ce medecin.' });
  res.json(dossier.consultations);
});

// POST /api/doctor/consultations
// body: { patient_id, reason, notes }
router.post('/consultations', (req, res) => {
  const { patient_id, reason, notes } = req.body;
  if (!patient_id) return res.status(400).json({ error: 'patient_id requis.' });

  const doctorId = req.user.profileId;
  const assignment = db
    .prepare('SELECT 1 FROM patient_doctor_assignments WHERE patient_id = ? AND doctor_id = ?')
    .get(patient_id, doctorId);

  if (!assignment) {
    return res.status(403).json({ error: 'Ce patient n\'est pas assigne a ce medecin.' });
  }

  const info = db
    .prepare(
      `INSERT INTO consultations (patient_id, doctor_id, reason, notes) VALUES (?, ?, ?, ?)`
    )
    .run(patient_id, doctorId, reason || null, notes || null);
  const consultationId = info.lastInsertRowid;

  const created = db.prepare('SELECT * FROM consultations WHERE id = ?').get(consultationId);
  res.status(201).json(created);
});

// POST /api/doctor/diagnostics
// body: { consultation_id, description }
router.post('/diagnostics', (req, res) => {
  const { consultation_id, description } = req.body;
  if (!consultation_id || !description) {
    return res.status(400).json({ error: 'consultation_id et description requis.' });
  }

  const consultation = db
    .prepare('SELECT * FROM consultations WHERE id = ? AND doctor_id = ?')
    .get(consultation_id, req.user.profileId);
  if (!consultation) {
    return res.status(403).json({ error: 'Consultation introuvable ou non autorisee.' });
  }

  const info = db
    .prepare('INSERT INTO diagnostics (consultation_id, description) VALUES (?, ?)')
    .run(consultation_id, description);
  const diagnosticId = info.lastInsertRowid;

  const created = db.prepare('SELECT * FROM diagnostics WHERE id = ?').get(diagnosticId);
  res.status(201).json(created);
});

// POST /api/doctor/prescriptions
// body: { consultation_id, medication, dosage, duration, instructions }
router.post('/prescriptions', (req, res) => {
  const { consultation_id, medication, dosage, duration, instructions } = req.body;
  if (!consultation_id || !medication) {
    return res.status(400).json({ error: 'consultation_id et medication requis.' });
  }

  const consultation = db
    .prepare('SELECT * FROM consultations WHERE id = ? AND doctor_id = ?')
    .get(consultation_id, req.user.profileId);
  if (!consultation) {
    return res.status(403).json({ error: 'Consultation introuvable ou non autorisee.' });
  }

  const info = db
    .prepare(
      `INSERT INTO prescriptions (consultation_id, medication, dosage, duration, instructions)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(consultation_id, medication, dosage || null, duration || null, instructions || null);
  const prescriptionId = info.lastInsertRowid;

  const created = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(prescriptionId);
  res.status(201).json(created);
});

// POST /api/doctor/patients/:id/sync  body: { hash }
// Appele par la page apres l'enregistrement MetaMask dans MedicalRecord : lance la synchronisation HTLC
// vers Fabric, apres avoir verifie sur Ethereum que ce hash est bien le dernier du patient.
router.post('/patients/:id/sync', async (req, res) => {
  const patientId = Number(req.params.id);
  const assignment = db
    .prepare('SELECT 1 FROM patient_doctor_assignments WHERE patient_id = ? AND doctor_id = ?')
    .get(patientId, req.user.profileId);
  if (!assignment) return res.status(403).json({ error: 'Ce patient n\'est pas assigne a ce medecin.' });
  const hash = String(req.body.hash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ error: 'hash invalide' });
  try {
    const { ethers } = require('ethers');
    const fs = require('fs');
    const path = require('path');
    const addresses = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', process.env.ETH_ADDRESSES), 'utf8'));
    const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC, undefined, { staticNetwork: true });
    const medicalRecord = new ethers.Contract(addresses['MedicalRecordModule#MedicalRecord'],
      ['function getLatestHash(uint256 patientId) view returns (bytes32)'], provider);
    const latest = (await medicalRecord.getLatestHash(patientId)).toLowerCase();
    if (latest !== hash) return res.status(409).json({ error: 'Ce hash n\'est pas le dernier enregistre pour ce patient' });
    const syncId = req.app.locals.sync.start(hash, `patient ${patientId}`);
    res.status(202).json({ syncId });
  } catch (err) {
    res.status(502).json({ error: err.shortMessage || err.message });
  }
});

module.exports = router;

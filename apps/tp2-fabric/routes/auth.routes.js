// routes/auth.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { hashPassword, comparePassword } = require('../utils/password');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

function signToken(user, profileId) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name, profileId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function validateBirthDate(birth_date) {
  if (!birth_date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) {
    return 'La date de naissance est invalide.';
  }

  const birthDate = new Date(`${birth_date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [year, month, day] = birth_date.split('-').map(Number);

  if (
    Number.isNaN(birthDate.getTime()) ||
    birthDate.getFullYear() !== year ||
    birthDate.getMonth() !== month - 1 ||
    birthDate.getDate() !== day
  ) {
    return 'La date de naissance est invalide.';
  }
  if (birthDate > today) {
    return 'La date de naissance ne peut pas etre dans le futur.';
  }
  return null;
}

function normalizeProfileFields(body) {
  return {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    email: typeof body.email === 'string' ? body.email.trim().toLowerCase() : '',
    password: typeof body.password === 'string' ? body.password : '',
    specialty: typeof body.specialty === 'string' ? body.specialty.trim() : null,
    birth_date: typeof body.birth_date === 'string' ? body.birth_date : null,
    gender: typeof body.gender === 'string' ? body.gender.trim() : null,
  };
}

function validateProfileFields(fields, requirePassword = false) {
  if (!fields.name || !fields.email || (requirePassword && !fields.password)) {
    return 'Nom, email et mot de passe requis.';
  }
  if (fields.password && fields.password.length < 6) {
    return 'Le mot de passe doit contenir au moins 6 caracteres.';
  }
  return validateBirthDate(fields.birth_date);
}

router.get('/doctors', (req, res) => {
  const doctors = db
    .prepare(
      `SELECT dp.id AS doctor_id, u.name, u.email, dp.specialty
       FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
       ORDER BY u.name ASC`
    )
    .all();

  res.json(doctors);
});

// POST /api/auth/register
// body: { name, email, password, role: 'medecin'|'patient', specialty?, birth_date?, gender?, assigned_doctor_id? }
router.post('/register', (req, res) => {
  const { role, assigned_doctor_id } = req.body;
  const fields = normalizeProfileFields(req.body);

  if (!['medecin', 'patient'].includes(role)) {
    return res.status(400).json({ error: 'Role invalide.' });
  }
  const validationError = validateProfileFields(fields, true);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(fields.email);
  if (existing) {
    return res.status(409).json({ error: 'Un compte existe deja avec cet email.' });
  }

  const hashed = hashPassword(fields.password);
  const insertUser = db.prepare(
    'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)'
  );
  const info = insertUser.run(fields.name, fields.email, hashed, role);
  const userId = info.lastInsertRowid;

  let profileId;
  if (role === 'medecin') {
    const info2 = db
      .prepare('INSERT INTO doctor_profiles (user_id, specialty) VALUES (?, ?)')
      .run(userId, fields.specialty);
    profileId = info2.lastInsertRowid;
  } else {
    const doctorId = Number(assigned_doctor_id);
    if (!doctorId || !db.prepare('SELECT id FROM doctor_profiles WHERE id = ?').get(doctorId)) {
      return res.status(400).json({ error: 'Veuillez choisir un medecin valide.' });
    }

    const info2 = db
      .prepare(
        'INSERT INTO patient_profiles (user_id, birth_date, gender) VALUES (?, ?, ?)'
      )
      .run(userId, fields.birth_date, fields.gender);
    profileId = info2.lastInsertRowid;

    db.prepare(
      'INSERT INTO patient_doctor_assignments (patient_id, doctor_id) VALUES (?, ?)'
    ).run(profileId, doctorId);
  }

  const user = { id: userId, role, name: fields.name };
  const token = signToken(user, profileId);
  res.status(201).json({ token, user: { id: userId, name: fields.name, email: fields.email, role, profileId } });
});

// POST /api/auth/login
// body: { email, password }
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !comparePassword(password, user.password)) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  let profileId;
  if (user.role === 'medecin') {
    const p = db.prepare('SELECT id FROM doctor_profiles WHERE user_id = ?').get(user.id);
    profileId = p ? p.id : null;
  } else {
    const p = db.prepare('SELECT id FROM patient_profiles WHERE user_id = ?').get(user.id);
    profileId = p ? p.id : null;
  }

  const token = signToken(user, profileId);
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, profileId },
  });
});


router.get('/profile', verifyToken, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Profil introuvable.' });

  const table = user.role === 'medecin' ? 'doctor_profiles' : 'patient_profiles';
  const profile = db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).get(user.id);
  res.json({ ...user, ...profile });
});

router.put('/profile', verifyToken, (req, res) => {
  const fields = normalizeProfileFields(req.body);
  const validationError = validateProfileFields(fields);
  if (validationError) return res.status(400).json({ error: validationError });

  const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!currentUser) return res.status(404).json({ error: 'Profil introuvable.' });

  const duplicate = db
    .prepare('SELECT id FROM users WHERE email = ? AND id <> ?')
    .get(fields.email, currentUser.id);
  if (duplicate) return res.status(409).json({ error: 'Un compte existe deja avec cet email.' });

  const password = fields.password ? hashPassword(fields.password) : currentUser.password;
  db.prepare('UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?')
    .run(fields.name, fields.email, password, currentUser.id);

  if (currentUser.role === 'medecin') {
    db.prepare('UPDATE doctor_profiles SET specialty = ? WHERE user_id = ?')
      .run(fields.specialty, currentUser.id);
  } else {
    const birthDateError = validateBirthDate(fields.birth_date);
    if (birthDateError) return res.status(400).json({ error: birthDateError });
    db.prepare(
      'UPDATE patient_profiles SET birth_date = ?, gender = ? WHERE user_id = ?'
    ).run(fields.birth_date, fields.gender, currentUser.id);
  }

  const profile = db.prepare(
    currentUser.role === 'medecin'
      ? 'SELECT id FROM doctor_profiles WHERE user_id = ?'
      : 'SELECT id FROM patient_profiles WHERE user_id = ?'
  ).get(currentUser.id);
  const user = { id: currentUser.id, role: currentUser.role, name: fields.name };
  const token = signToken(user, profile ? profile.id : null);
  res.json({ token, user: { ...user, email: fields.email, profileId: profile ? profile.id : null } });
});

module.exports = router;

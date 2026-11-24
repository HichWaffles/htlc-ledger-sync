// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./config/db'); // initialise la base + le schema au demarrage
const { createSync } = require('@htlc/sync');

const authRoutes = require('./routes/auth.routes');
const doctorRoutes = require('./routes/doctor.routes');
const patientRoutes = require('./routes/patient.routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api/patient', patientRoutes);

// Synchronisation HTLC Ethereum <-> Fabric (voir docs/REPORT.md)
const sync = createSync(db, __dirname);
app.locals.sync = sync;
app.use('/api/sync', sync.router());
sync.run();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Serveur demarre sur http://localhost:${PORT}`);
});

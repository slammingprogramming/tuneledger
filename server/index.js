'use strict';

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { openDb } = require('./db');
const buildApiRouter = require('./routes/api');
const buildLibraryRouter = require('./routes/library');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'library.db');
const PORT = process.env.PORT || 3000;

const db = openDb(DB_PATH);

const app = express();
app.use(express.json({ limit: '10mb' }));

// TuneLedger is meant to be run locally/self-hosted, but this still bounds
// how many API requests one client can fire in a window - a cheap backstop
// against a runaway script (or someone finding this exposed on a network)
// hammering an expensive endpoint like /library-scan or /imports.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.use('/api', buildApiRouter(db));
app.use('/api', buildLibraryRouter(db));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`TuneLedger listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Database: ${DB_PATH}`);
});

module.exports = app;

/**
 * src/app.js – Express application factory
 */
'use strict';

const express        = require('express');
const healthRoutes   = require('./routes/health');
const webhookRoutes  = require('./routes/webhook');
const logger         = require('./utils/logger');

const app = express();

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  logger.info({ event: 'http_request', method: req.method, url: req.originalUrl });
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRoutes);
app.use('/webhook', webhookRoutes);

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error({ event: 'unhandled_express_error', err: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;


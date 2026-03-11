/**
 * index.js – SofIA entry point
 *
 * Boots:
 *  1. Express HTTP server (routes: /health, /webhook/elevenlabs-resultado)
 *  2. Scheduled cron jobs (fill queue 3×/day)
 *  3. Queue worker (every N seconds → outbound calls)
 */
'use strict';

require('dotenv').config();

const app                  = require('./src/app');
const { initSchedulers }   = require('./src/schedulers');
const { startQueueWorker } = require('./src/services/cola/processQueue');
const logger               = require('./src/utils/logger');

const PORT = process.env.PORT || 3000;

async function main() {
  // ── HTTP server ──────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    logger.info({ event: 'server_started', port: PORT }, 'HTTP server listening');
  });

  // ── Scheduled jobs (fill queue 3×/day) ──────────────────────────────────
  initSchedulers();

  // ── Queue worker (consume queue every N seconds) ─────────────────────────
  startQueueWorker();

  logger.info({ event: 'sofia_ready' }, 'SofIA service is running');
}

main().catch((err) => {
  logger.error({ event: 'fatal_startup_error', err: err.message }, 'Failed to start SofIA');
  process.exit(1);
});

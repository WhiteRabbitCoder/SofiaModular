/**
 * src/schedulers/index.js – Cron job definitions
 *
 * Three daily jobs fill cola_llamadas for each franja:
 *   manana  → default 07:00 Colombia time
 *   tarde   → default 14:00 Colombia time
 *   noche   → default 19:00 Colombia time
 *
 * Cron expressions can be overridden via .env:
 *   CRON_FILL_MANANA=0 7 * * *
 *   CRON_FILL_TARDE=0 14 * * *
 *   CRON_FILL_NOCHE=0 19 * * *
 *
 * node-cron uses the server's local timezone unless `timezone` option is set.
 * We explicitly set timezone to 'America/Bogota' so schedules are always
 * relative to Colombia time regardless of the host server's timezone.
 *
 * Equivalent to the "Planificador" (hourly Schedule Trigger) in Varios,
 * but split into 3 precise daily jobs instead of running every hour.
 */
'use strict';

const cron                    = require('node-cron');
const { llenarColaParaFranja } = require('../services/cola/fillQueue');
const logger                  = require('../utils/logger');

const TZ = 'America/Bogota';

/**
 * Schedule a single fill-queue job.
 *
 * @param {string} franja   – 'manana' | 'tarde' | 'noche'
 * @param {string} cronExpr – cron expression
 */
function scheduleJob(franja, cronExpr) {
  if (!cron.validate(cronExpr)) {
    logger.error(
      { event: 'invalid_cron', franja, cronExpr },
      `Invalid cron expression for franja ${franja}: "${cronExpr}"`,
    );
    return;
  }

  cron.schedule(cronExpr, async () => {
    logger.info({ event: 'cron_triggered', franja, cronExpr }, `Cron triggered: fill queue for ${franja}`);
    try {
      const count = await llenarColaParaFranja(franja);
      logger.info({ event: 'cron_done', franja, inserted: count }, `Cron done: ${count} items inserted for ${franja}`);
    } catch (err) {
      logger.error({ event: 'cron_error', franja, err: err.message }, `Cron job error for franja ${franja}`);
    }
  }, { timezone: TZ });

  logger.info({ event: 'cron_registered', franja, cronExpr, timezone: TZ }, `Cron registered for franja ${franja}`);
}

/**
 * Register all three daily fill-queue cron jobs.
 * Called once at startup from index.js.
 */
function initSchedulers() {
  scheduleJob('manana', process.env.CRON_FILL_MANANA || '0 7 * * *');
  scheduleJob('tarde',  process.env.CRON_FILL_TARDE  || '0 14 * * *');
  scheduleJob('noche',  process.env.CRON_FILL_NOCHE  || '0 19 * * *');

  logger.info({ event: 'schedulers_initialized' }, 'All cron schedulers initialized');
}

module.exports = { initSchedulers };


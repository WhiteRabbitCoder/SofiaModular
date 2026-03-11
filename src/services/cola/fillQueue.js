/**
 * src/services/cola/fillQueue.js – Fill the call queue for a time slot
 *
 * Equivalent to:
 *   - "Crear cola de pendientes" (calls llenar_cola_llamadas RPC) in Varios
 *   - The priority calculation logic ("Ordenar por prioridad") in Asesor Nueva BD
 *
 * This module replaces the Supabase RPC with a direct INSERT … SELECT from Node.
 *
 * Priority formula:
 *   priority = (ci_total × 10) − (intentos_llamada × 3) − (intentos_franja_actual × 1)
 *              + daysOldBonus (older ultimo_contacto → more urgency)
 *
 * Default hora_programada per franja:
 *   manana  → 09:00
 *   tarde   → 15:00
 *   noche   → 19:00
 */
'use strict';

const { getCandidatesForQueue } = require('../../db/candidatos');
const { bulkInsertQueue }       = require('../../db/cola');
const { getEnCursoResultadoId, getPendienteEstadoId } = require('../../db/lookups');
const { colombiaDateString }    = require('../../utils/dateHelpers');
const logger                    = require('../../utils/logger');

/** Default call time per franja */
const DEFAULT_HORA = {
  manana: '09:00',
  tarde:  '15:00',
  noche:  '19:00',
};

/**
 * Compute a numeric priority for a candidate.
 * Higher value = processed first.
 *
 * @param {object} candidato – row from candidatos + ci_total
 * @returns {number}
 */
function computePriority(candidato) {
  const ciTotal            = Number(candidato.ci_total)            || 0;
  const intentos           = Number(candidato.intentos_llamada)    || 0;
  const intentosFranja     = Number(candidato.intentos_franja_actual) || 0;

  // Days since last contact (null = never contacted → highest urgency bonus)
  let daysBonus = 0;
  if (candidato.ultimo_contacto) {
    const msPerDay   = 24 * 60 * 60 * 1000;
    const daysSince  = Math.floor((Date.now() - new Date(candidato.ultimo_contacto).getTime()) / msPerDay);
    daysBonus        = Math.min(daysSince, 10); // cap at 10 to avoid overflow
  } else {
    daysBonus = 10; // never contacted → max bonus
  }

  return (ciTotal * 10) - (intentos * 3) - (intentosFranja * 1) + daysBonus;
}

/**
 * Fill cola_llamadas for a given franja.
 *
 * Scheduled 3×/day by src/schedulers/index.js
 *
 * @param {'manana'|'tarde'|'noche'} franja
 * @returns {Promise<number>} – number of rows inserted
 */
async function llenarColaParaFranja(franja) {
  const validFranjas = ['manana', 'tarde', 'noche'];
  if (!validFranjas.includes(franja)) {
    throw new Error(`Invalid franja: ${franja}. Must be one of: ${validFranjas.join(', ')}`);
  }

  logger.info({ event: 'fill_queue_start', franja }, `Filling call queue for franja: ${franja}`);

  // Resolve lookup IDs dynamically (first run fetches from DB, then cached)
  const [pendienteEstadoId, enCursoResultadoId] = await Promise.all([
    getPendienteEstadoId(),
    getEnCursoResultadoId(),
  ]);

  // Fetch eligible candidates
  const candidates = await getCandidatesForQueue(pendienteEstadoId, enCursoResultadoId);

  if (candidates.length === 0) {
    logger.info({ event: 'fill_queue_empty', franja }, 'No eligible candidates found');
    return 0;
  }

  const fechaHoy      = colombiaDateString();
  const horaPorDefecto = DEFAULT_HORA[franja];

  // Build queue entries with computed priorities
  const entries = candidates.map((c) => ({
    candidatoId:     c.id,
    prioridad:       computePriority(c),
    franjaProgramada: franja,
    horaProgramada:  c.hora_preferida_llamada || horaPorDefecto,
  }));

  const inserted = await bulkInsertQueue(entries, fechaHoy);

  logger.info(
    { event: 'fill_queue_done', franja, candidates: candidates.length, inserted },
    `Queue filled: ${inserted} rows inserted for franja ${franja}`,
  );

  return inserted;
}

module.exports = { llenarColaParaFranja };


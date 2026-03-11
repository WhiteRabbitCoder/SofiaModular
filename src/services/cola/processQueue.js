/**
 * src/services/cola/processQueue.js – Queue worker
 *
 * Equivalent to the second Schedule Trigger flow in Varios (every 10 seconds):
 *   "Contar llamadas activas" → "Calcular disponibles" → "¿Hay espacio?"
 *   → "Traer siguiente cola" → "Ordenar por prioridad"
 *   → for each item: "Marcar EN_CURSO en cola" → "Traer candidato completo"
 *      → "Obtener motivo_llamada" → "Obtener Eventos"
 *      → "Parseo de fecha" → "Validar horario de llamada"
 *      → "JSON ElevenLabs" → "HTTP Request" → "Crear Llamada"
 *
 * Behavior when outside call window:
 *   The queue item is left as PENDIENTE and will be retried on the next iteration.
 *   This mirrors the n8n behavior where Validar horario returns [] (empty) and
 *   the flow simply ends without processing that item.
 */
'use strict';

const { countActiveCalls }    = require('../../db/llamadas');
const { getPendingQueueItems, markQueueItemEnCurso } = require('../../db/cola');
const { getCandidatoById }    = require('../../db/candidatos');
const { getAvailableEvents }  = require('../../db/eventos');
const { getMotivoById, getEnCursoResultadoId } = require('../../db/lookups');
const { makeOutboundCall }    = require('../llamadas/callService');
const { isCallWindowOpen }    = require('../../utils/timeValidator');
const { colombiaDateString }  = require('../../utils/dateHelpers');
const logger                  = require('../../utils/logger');

const MAX_CONCURRENT_CALLS   = Number(process.env.MAX_CONCURRENT_CALLS) || 4;
const INTERVAL_SECONDS        = Number(process.env.QUEUE_WORKER_INTERVAL_SECONDS) || 10;

let workerRunning = false; // Prevent overlapping iterations

/**
 * Single iteration of the queue worker.
 *
 * Steps:
 *  1. Count active calls → calculate available slots.
 *  2. If no slots, stop.
 *  3. Fetch PENDIENTE queue items for today (up to `available` rows).
 *  4. For each item:
 *     a. Validate call window (horario_id → horarios.codigo).
 *     b. Mark as EN_CURSO.
 *     c. Fetch candidate, motivo, available events.
 *     d. Make outbound call via ElevenLabs.
 *     e. Record llamada in DB.
 */
async function runQueueIteration() {
  // ── Step 1: Count active calls ─────────────────────────────────────────────
  const enCursoId = await getEnCursoResultadoId();
  const activeCount = await countActiveCalls(enCursoId);
  const available   = Math.max(0, MAX_CONCURRENT_CALLS - activeCount);

  logger.info(
    { event: 'queue_iteration', active: activeCount, available, max: MAX_CONCURRENT_CALLS },
    `Queue worker: ${activeCount} active calls, ${available} slots available`,
  );

  // ── Step 2: Check available slots ─────────────────────────────────────────
  if (available <= 0) {
    logger.info({ event: 'queue_no_slots' }, 'No available call slots, skipping iteration');
    return;
  }

  // ── Step 3: Fetch pending queue items ──────────────────────────────────────
  const today = colombiaDateString();
  const items = await getPendingQueueItems(today, available);

  if (items.length === 0) {
    logger.info({ event: 'queue_empty_today', fecha: today }, 'No pending queue items for today');
    return;
  }

  logger.info({ event: 'queue_processing', count: items.length }, `Processing ${items.length} queue item(s)`);

  // ── Step 4: Process each item sequentially ────────────────────────────────
  for (const item of items) {
    try {
      await processQueueItem(item);
    } catch (err) {
      logger.error(
        { event: 'queue_item_error', cola_id: item.id, candidato_id: item.candidato_id, err: err.message },
        'Error processing queue item – skipping to next',
      );
    }
  }
}

/**
 * Process a single cola_llamadas item.
 *
 * @param {object} item – cola_llamadas row
 */
async function processQueueItem(item) {
  // ── a. Fetch candidate with horario info ───────────────────────────────────
  const candidato = await getCandidatoById(item.candidato_id);
  if (!candidato) {
    logger.warn(
      { event: 'candidato_not_found', candidato_id: item.candidato_id },
      'Candidate not found, skipping queue item',
    );
    return;
  }

  // ── b. Validate call window ────────────────────────────────────────────────
  // Equivalent to "Validar horario de llamada" node in Varios
  const horarioCodigo = candidato.horario_codigo || null;
  if (!isCallWindowOpen(horarioCodigo)) {
    logger.info(
      {
        event:       'call_window_closed',
        candidato_id: candidato.id,
        horario:     horarioCodigo,
        cola_id:     item.id,
      },
      'Call window closed for this candidate, leaving item as PENDIENTE',
    );
    // Leave the item in PENDIENTE state – it will be retried in the next iteration
    return;
  }

  // ── c. Mark queue item as EN_CURSO ────────────────────────────────────────
  // Equivalent to "Marcar EN_CURSO en cola" node in Varios
  await markQueueItemEnCurso(item.id);

  // ── d. Fetch motivo_llamada ────────────────────────────────────────────────
  // Equivalent to "Obtener motivo_llamada" node in Varios
  let motivo = candidato.fase_actual; // fallback
  if (candidato.motivo_llamada_id) {
    const motivoRow = await getMotivoById(candidato.motivo_llamada_id);
    if (motivoRow) motivo = motivoRow.codigo;
  }

  // ── e. Fetch available events ─────────────────────────────────────────────
  // Equivalent to "Obtener Eventos" node in Varios
  // tipo_reunion matches candidato.fase_actual
  const eventos = await getAvailableEvents(candidato.fase_actual);

  logger.info(
    {
      event:        'processing_candidate',
      candidato_id: candidato.id,
      nombre:       `${candidato.nombre} ${candidato.apellido}`,
      fase_actual:  candidato.fase_actual,
      motivo,
      eventos_count: eventos.length,
    },
    'Preparing outbound call',
  );

  // ── f. Make outbound call + create llamada record ─────────────────────────
  // Equivalent to "HTTP Request" + "Code in JavaScript" + "Crear Llamada" nodes
  await makeOutboundCall(candidato, motivo, eventos);
}

/**
 * Start the background queue worker loop.
 *
 * Runs every INTERVAL_SECONDS seconds using setInterval.
 * Uses a flag to prevent overlapping executions.
 */
function startQueueWorker() {
  logger.info(
    { event: 'queue_worker_start', interval_seconds: INTERVAL_SECONDS },
    `Queue worker started (interval: ${INTERVAL_SECONDS}s)`,
  );

  setInterval(async () => {
    if (workerRunning) {
      logger.warn({ event: 'queue_worker_overlap' }, 'Previous iteration still running, skipping');
      return;
    }

    workerRunning = true;
    try {
      await runQueueIteration();
    } catch (err) {
      logger.error(
        { event: 'queue_iteration_fatal', err: err.message },
        'Fatal error in queue iteration',
      );
    } finally {
      workerRunning = false;
    }
  }, INTERVAL_SECONDS * 1000);
}

module.exports = { startQueueWorker, runQueueIteration };


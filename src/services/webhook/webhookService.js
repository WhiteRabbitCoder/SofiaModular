/**
 * src/services/webhook/webhookService.js – ElevenLabs webhook processor
 *
 * Equivalent to the entire webhook branch in Asesor Nueva BD:
 *   "Webhook" → "Parseo llamada" → "Obtener resultado_llamada"
 *   → "Obtener estado_gestion" → "Actualizar tabla llamada"
 *   → "Actualizar Candidato" → "¿Fue agendado?" → "Obtener evento"
 *   → "Parsear evento" → "Actualizar EVENTO"
 *
 * Expected incoming payload from ElevenLabs:
 * {
 *   "resultado":    "AGENDADO",          // maps to resultados_llamada.codigo
 *   "dia":          "miércoles",         // dia_agendado
 *   "hora":         "7:00 PM",           // hora_agendado
 *   "candidato_id": "uuid-string",
 *   "evento_id":    2,                   // integer or null
 *   "nota":         "some text"          // resumen
 * }
 *
 * Results that are considered FINAL (queue row → COMPLETADA):
 *   AGENDADO, COMPLETADO, NUM_INVALIDO, DESCARTADO
 *
 * Results that keep the candidate active for retries (queue row → CANCELADA):
 *   NO_CONTESTA, OCUPADO
 */
'use strict';

const pool                        = require('../../db/pool');
const { getResultadoByCodigo,
        getEstadoGestionByCodigo,
        getEnCursoResultadoId }   = require('../../db/lookups');
const { getLatestActiveLlamada,
        updateLlamada }           = require('../../db/llamadas');
const { updateCandidato }         = require('../../db/candidatos');
const { getEventoById,
        incrementEventoInscritos } = require('../../db/eventos');
const { finalizeCandidateQueueItems } = require('../../db/cola');
const { colombiaDateString }      = require('../../utils/dateHelpers');
const logger                      = require('../../utils/logger');

/**
 * Resultado codes that indicate a "final" outcome → queue row = COMPLETADA.
 * Everything else → CANCELADA (candidate may be retried later).
 */
const FINAL_RESULTADOS = new Set(['AGENDADO', 'COMPLETADO', 'NUM_INVALIDO', 'DESCARTADO']);

/**
 * Map a webhook resultado code to the best-fit estados_gestion codigo.
 *
 * The n8n flow uses `resultado.toUpperCase()` directly to look up estados_gestion,
 * which works because several codes are shared between the two tables.
 * We replicate that logic here with an explicit mapping for safety.
 *
 * @param {string} resultadoCodigo – e.g. 'AGENDADO', 'NO_CONTESTA'
 * @returns {string} – estados_gestion.codigo
 */
function mapResultadoToEstadoGestion(resultadoCodigo) {
  const MAP = {
    AGENDADO:    'AGENDADO',
    NO_CONTESTA: 'NO_CONTESTA',
    OCUPADO:     'NO_CONTESTA',   // treat busy as "no contact"
    NUM_INVALIDO: 'DESCARTADO',
    COMPLETADO:  'INSCRITO',
    DESCARTADO:  'DESCARTADO',
    EN_CURSO:    'PENDIENTE',     // should not arrive, but handle gracefully
  };
  return MAP[resultadoCodigo.toUpperCase()] || resultadoCodigo.toUpperCase();
}

/**
 * Process an ElevenLabs webhook result and update all related tables.
 *
 * All DB writes are wrapped in a single transaction for consistency.
 *
 * @param {object} payload
 * @param {string}       payload.candidato_id
 * @param {string}       payload.resultado        – e.g. 'AGENDADO'
 * @param {string|null}  [payload.dia]            – dia_agendado text
 * @param {string|null}  [payload.hora]           – hora_agendado text
 * @param {number|null}  [payload.evento_id]
 * @param {string|null}  [payload.nota]
 * @param {string|null}  [payload.conversation_id]
 * @param {number|null}  [payload.duracion_segundos]
 * @returns {Promise<{success: boolean, details: object}>}
 */
async function processWebhookResult(payload) {
  // ── 1. Parse and normalise payload ──────────────────────────────────────────
  // Equivalent to "Parseo llamada" node in Asesor Nueva BD
  const candidatoId     = payload.candidato_id;
  const resultadoCodigo = (payload.resultado || '').toUpperCase();
  const diaAgendado     = payload.dia    || null;
  const horaAgendado    = payload.hora   || null;
  const eventoId        = payload.evento_id ? Number(payload.evento_id) : null;
  const nota            = payload.nota   || null;
  // conversation_id is already stored when the call is initiated; no need to update here.
  const duracion        = payload.duracion_segundos ? Number(payload.duracion_segundos) : null;

  logger.info(
    { event: 'webhook_received', candidato_id: candidatoId, resultado: resultadoCodigo, evento_id: eventoId },
    'Processing ElevenLabs webhook result',
  );

  if (!candidatoId || !resultadoCodigo) {
    throw new Error('Missing required fields: candidato_id and resultado are required');
  }

  // ── 2. Resolve lookup IDs ──────────────────────────────────────────────────
  // Equivalent to "Obtener resultado_llamada" + "Obtener estado_gestion" nodes
  const [resultadoRow, enCursoId] = await Promise.all([
    getResultadoByCodigo(resultadoCodigo),
    getEnCursoResultadoId(),
  ]);

  if (!resultadoRow) {
    throw new Error(`Unknown resultado codigo: ${resultadoCodigo}`);
  }

  const estadoGestionCodigo = mapResultadoToEstadoGestion(resultadoCodigo);
  const estadoGestionRow    = await getEstadoGestionByCodigo(estadoGestionCodigo);

  if (!estadoGestionRow) {
    throw new Error(`Unknown estado_gestion codigo: ${estadoGestionCodigo}`);
  }

  // ── 3. Begin transaction ──────────────────────────────────────────────────
  const client = await pool.connect();
  const details = {};

  try {
    await client.query('BEGIN');

    // ── 4. Update llamada record ─────────────────────────────────────────────
    // Equivalent to "Actualizar tabla llamada" node
    const llamada = await getLatestActiveLlamada(candidatoId, enCursoId);
    if (llamada) {
      await updateLlamada(llamada.id, {
        resultadoId:     resultadoRow.id,
        diaAgendado:     diaAgendado,
        horaAgendado:    horaAgendado,
        eventoAsignadoId: eventoId,
        resumen:         nota,
        duracionSegundos: duracion,
      });
      details.llamada_id = String(llamada.id);
      logger.info({ event: 'llamada_updated', llamada_id: String(llamada.id) }, 'Llamada updated');
    } else {
      logger.warn(
        { event: 'llamada_not_found', candidato_id: candidatoId },
        'No active llamada found for candidate – skipping llamada update',
      );
    }

    // ── 5. Update candidato ──────────────────────────────────────────────────
    // Equivalent to "Actualizar Candidato" node
    await updateCandidato(candidatoId, {
      ultimoContacto:  new Date().toISOString(),
      eventoAsignadoId: eventoId,
      estadoGestionId: estadoGestionRow.id,
    });
    details.candidato_updated = true;
    logger.info({ event: 'candidato_updated', candidato_id: candidatoId }, 'Candidato updated');

    // ── 6. Update evento if result is AGENDADO ────────────────────────────────
    // Equivalent to "¿Fue agendado?" → "Obtener evento" → "Parsear evento" → "Actualizar EVENTO"
    if (resultadoCodigo === 'AGENDADO' && eventoId) {
      const evento = await getEventoById(eventoId);
      if (evento && evento.estado !== 'COMPLETO') {
        const updated = await incrementEventoInscritos(eventoId);
        details.evento_updated = { evento_id: eventoId, ...updated };
        logger.info(
          { event: 'evento_updated', evento_id: eventoId, ...updated },
          `Evento updated: ${updated?.inscritos_actuales} / ${evento.capacidad_total}`,
        );
      }
    }

    // ── 7. Update cola_llamadas ───────────────────────────────────────────────
    const today          = colombiaDateString();
    const isFinal        = FINAL_RESULTADOS.has(resultadoCodigo);
    const nuevoEstadoCola = isFinal ? 'COMPLETADA' : 'CANCELADA';

    await finalizeCandidateQueueItems(candidatoId, today, nuevoEstadoCola);
    details.queue_estado = nuevoEstadoCola;
    logger.info(
      { event: 'cola_updated', candidato_id: candidatoId, nuevo_estado: nuevoEstadoCola },
      `Cola items set to ${nuevoEstadoCola}`,
    );

    await client.query('COMMIT');

    logger.info(
      { event: 'webhook_processed', candidato_id: candidatoId, resultado: resultadoCodigo },
      'Webhook processed successfully',
    );

    return { success: true, details };

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(
      { event: 'webhook_transaction_error', candidato_id: candidatoId, err: err.message },
      'Transaction rolled back due to error',
    );
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { processWebhookResult };



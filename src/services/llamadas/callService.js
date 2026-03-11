/**
 * src/services/llamadas/callService.js – ElevenLabs outbound call
 *
 * Equivalent to:
 *   - "HTTP Request" (outbound call) node in both n8n flows
 *   - "Code in JavaScript" (build llamada payload) node
 *   - "Crear Llamada" (insert into llamadas) node
 *
 * Calls ElevenLabs ConvAI Twilio outbound-call API and records the call in DB.
 */
'use strict';

const axios  = require('axios');
const { createLlamada }      = require('../../db/llamadas');
const { getEnCursoResultadoId } = require('../../db/lookups');
const { buildEventTexts }    = require('../../utils/dateHelpers');
const logger                 = require('../../utils/logger');

const ELEVENLABS_API_URL     = process.env.ELEVENLABS_API_URL
  || 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';
const ELEVENLABS_API_KEY     = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID    = process.env.ELEVENLABS_AGENT_ID
  || 'agent_4501khbynht9ennvk32madk7k1jj';
const ELEVENLABS_PHONE_NUM_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID
  || 'phnum_8101khntfkmbeq6amer4dt70p5vs';

/**
 * Build the ElevenLabs request body.
 *
 * Equivalent to the "JSON ElevenLabs" node in both n8n flows.
 *
 * @param {object} candidato   – candidatos row
 * @param {string} motivo      – motivo codigo or fase_actual
 * @param {Array}  eventos     – array of evento rows (with fecha_hora)
 * @returns {object}           – ElevenLabs API body
 */
function buildElevenLabsBody(candidato, motivo, eventos) {
  const { fechasTexto, eventosTexto } = buildEventTexts(eventos);

  return {
    agent_id: ELEVENLABS_AGENT_ID,
    agent_phone_number_id: ELEVENLABS_PHONE_NUM_ID,
    to_number: candidato.telefono,
    conversation_initiation_client_data: {
      dynamic_variables: {
        id:                  candidato.id,
        nombre:              `${candidato.nombre} ${candidato.apellido}`,
        motivo:              motivo,
        lista_horarios:      fechasTexto,
        eventos_disponibles: eventosTexto,
      },
    },
  };
}

/**
 * Make an outbound call via ElevenLabs and record it in the DB.
 *
 * @param {object} candidato  – row from public.candidatos
 * @param {string} motivo     – motivo text (motivos_llamada.codigo or fase_actual)
 * @param {Array}  eventos    – available events for candidate's fase_actual
 * @returns {Promise<{llamada: object, conversationId: string|null}>}
 */
async function makeOutboundCall(candidato, motivo, eventos) {
  const body = buildElevenLabsBody(candidato, motivo, eventos);

  logger.info(
    { event: 'elevenlabs_call_attempt', candidato_id: candidato.id, telefono: candidato.telefono },
    'Making outbound call via ElevenLabs',
  );

  let conversationId = null;

  try {
    const response = await axios.post(ELEVENLABS_API_URL, body, {
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key':   ELEVENLABS_API_KEY,
      },
      timeout: 15_000,
    });

    conversationId = response.data?.conversation_id || null;

    logger.info(
      { event: 'elevenlabs_call_success', candidato_id: candidato.id, conversationId },
      'ElevenLabs call initiated successfully',
    );
  } catch (err) {
    const status  = err.response?.status;
    const errBody = err.response?.data;
    logger.error(
      { event: 'elevenlabs_call_error', candidato_id: candidato.id, status, errBody, err: err.message },
      'ElevenLabs call failed',
    );
    throw err;
  }

  // Record the call in the DB with status EN_CURSO
  const enCursoId = await getEnCursoResultadoId();
  const llamada   = await createLlamada({
    candidatoId:    candidato.id,
    resultadoId:    enCursoId,
    conversationId: conversationId,
    resumen:        'Llamada iniciada',
  });

  logger.info(
    { event: 'llamada_created', llamada_id: llamada.id, candidato_id: candidato.id },
    'Llamada record created in DB',
  );

  return { llamada, conversationId };
}

module.exports = { makeOutboundCall, buildElevenLabsBody };


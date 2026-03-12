// chatbot/chatbot.service.js
'use strict';

const axios = require('axios');
const https = require('https');
// Ajustar ruta relativa al pool de la base de datos
const pool = require('../src/db/pool');

const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function formatChatbotDate(fechaHoraIso) {
  // Ajuste timezone similar a dateHelpers
  const cleaned  = String(fechaHoraIso).replace('+00:00', '').replace('Z', '');
  const fecha    = new Date(cleaned);

  const diaNombre = DAYS_ES[fecha.getDay()];
  const horas     = fecha.getHours();
  const minutos   = String(fecha.getMinutes()).padStart(2, '0');
  const ampm      = horas >= 12 ? 'PM' : 'AM';
  const hora12    = horas % 12 || 12;

  return {
    simple: `${diaNombre} ${hora12}:${minutos} ${ampm}`,
    full:   `${diaNombre} a las ${hora12}:${minutos} ${ampm}`
  };
}

/**
 * URL del webhook externo (ngrok) del Chatbot.
 * Debe definirse en .env como CHATBOT_WEBHOOK_URL.
 */
const CHATBOT_WEBHOOK_URL = process.env.CHATBOT_WEBHOOK_URL || 'http://localhost:4000/webhook/initiate';

/**
 * 1. Verifica si el candidato cumple la condición de 9 llamadas NO_CONTESTAS hoy.
 * @param {string} candidatoId - UUID del candidato.
 * @returns {Promise<boolean>}
 */
async function shouldTriggerChatbot(candidatoId) {
  // Contamos llamadas del día actual que resultaron en NO_CONTESTA
  const query = `
    SELECT COUNT(*) as failed_calls
    FROM public.llamadas l
    JOIN public.resultados_llamada rl ON l.resultado_id = rl.id
    WHERE l.candidato_id = $1
      AND l.fecha_hora_llamada::date = CURRENT_DATE
      AND rl.codigo = 'NO_CONTESTA'
  `;
  
  const { rows } = await pool.query(query, [candidatoId]);
  const count = parseInt(rows[0].failed_calls, 10);
  
  // Condición estricta: exactamente 9 llamadas.
  // Esto evita disparar múltiples veces el mismo día si sigue fallando.
  return count === 9;
}

/**
 * 2. Recopila datos del candidato y eventos compatibles.
 * @param {string} candidatoId 
 */
async function gatherCandidateData(candidatoId) {
  // Obtener Info Candidato
  const candidateQuery = `
    SELECT 
      c.id, c.nombre, c.apellido, c.telefono, c.correo, 
      c.fase_actual, c.franja_actual, 
      m.nombre as ciudad_nombre,
      eg.codigo as estado_gestion
    FROM public.candidatos c
    LEFT JOIN public.estados_gestion eg ON c.estado_gestion_id = eg.id
    LEFT JOIN public.municipios m ON c.municipio_id = m.id
    WHERE c.id = $1
  `;
  const candidateRes = await pool.query(candidateQuery, [candidatoId]);
  const candidate = candidateRes.rows[0];

  if (!candidate) throw new Error(`Candidato ${candidatoId} no encontrado.`);

  // Obtener Eventos Compatibles basados en la fase actual
  // Asumimos que la fase coincide con tipo_reunion en eventos
  const eventsQuery = `
    SELECT 
      e.id, e.tipo_reunion, e.fecha_hora, 
      e.inscritos_actuales, e.capacidad_total, e.descripcion,
      s.nombre as sede
    FROM public.eventos e
    LEFT JOIN public.sedes s ON e.sede_id = s.id
    WHERE e.tipo_reunion = $1
      AND e.estado = 'DISPONIBLE'
      AND e.fecha_hora > NOW()
    ORDER BY e.fecha_hora ASC
    LIMIT 5
  `;
  
  const eventsRes = await pool.query(eventsQuery, [candidate.fase_actual]);
  const rawEvents = eventsRes.rows;

  // Procesar eventos para el formato requerido
  const eventos_disponibles = rawEvents.map(e => {
    const formatted = formatChatbotDate(e.fecha_hora);
    return {
      fecha_legible: formatted.full, // "lunes a las 3:00 PM"
      evento_id: e.id,
      _simple: formatted.simple // helper interno
    };
  });

  // Construir string lista_horarios: "1) lunes 3:00 PM\n2) martes 7:00 PM"
  const lista_horarios = eventos_disponibles
      .map((e, idx) => `${idx + 1}) ${e._simple}`)
      .join('\n');

  // Limpiar eventos_disponibles de propiedades internas
  const finalEvents = eventos_disponibles.map(({ _simple, ...rest }) => rest);

  // Mensaje precocinado para facilitar el envío por WhatsApp
  const mensaje = `Hola ${candidate.nombre}, hemos intentado contactarte varias veces sin éxito. ` +
                  `Nos gustaría agendar una cita contigo. Por favor responde con el número de tu preferencia:\n\n${lista_horarios}`;

  // Payload final
  return {
    candidato_id: candidate.id, // Requerido por el chatbot para saber a quién actualizar luego
    telefono: candidate.telefono ? candidate.telefono.replace('+', '') : '', // Quitar '+' si existe
    nombre: candidate.nombre,
    motivo: candidate.fase_actual, // Asumimos fase_actual es el motivo (ej. ENTREVISTA)
    ciudad: candidate.ciudad_nombre || 'Desconocida',
    lista_horarios: lista_horarios,
    eventos_disponibles: finalEvents,
    mensaje: mensaje // Nuevo campo con el texto completo
  };
}

/**
 * 3. Envía el payload al Chatbot externo.
 * @param {object} payload 
 */
async function sendToChatbot(payload) {
  try {
    console.log(`[ChatbotService] Enviando datos de usuario ${payload.nombre} a ${CHATBOT_WEBHOOK_URL}...`);
    
    // Configurar agente HTTPS para evitar errores de certificado con ngrok/dev
    const agent = new https.Agent({  
      rejectUnauthorized: false
    });

    const response = await axios.post(CHATBOT_WEBHOOK_URL, payload, {
      timeout: 10000, // 10s timeout
      httpsAgent: agent,
      headers: {
        'ngrok-skip-browser-warning': 'true', // Salta la pantalla de advertencia de ngrok gratuito
        'User-Agent': 'SofIA-Bot/2.0'
      }
    });
    console.log(`[ChatbotService] Respuesta del bot: ${response.status}`);
    return response.data;
  } catch (error) {
    console.error('[ChatbotService] Error enviando a webhook externo:', error.message);
    // Retornar detalle del error para facilitar depuración en endpoints manuales
    return { 
        error_envio: true, 
        message: error.message,
        details: error.response ? error.response.data : 'Sin respuesta del servidor remoto'
    };
  }
}

/**
 * Funcionalidad Principal: Verifica condición y ejecuta si se cumple.
 * Debe ser llamada cuando se registre una llamada fallida.
 */
async function processCandidateCallFail(candidatoId) {
  try {
    const trigger = await shouldTriggerChatbot(candidatoId);
    if (trigger) {
      console.log(`[ChatbotService] Condición cumplida (9 llamadas fallidas hoy) para candidato ${candidatoId}. Despertando a SofIA Chat...`);
      const data = await gatherCandidateData(candidatoId);
      await sendToChatbot(data);
    } 
  } catch (err) {
    console.error('[ChatbotService] Error en processCandidateCallFail:', err);
  }
}

/**
 * Trigger manual para pruebas (salta la verificación de 9 llamadas).
 */
async function forceChatbotTrigger(candidatoId) {
  console.log(`[ChatbotService] Forzando trigger manual para candidato ${candidatoId}...`);
  const data = await gatherCandidateData(candidatoId);
  return await sendToChatbot(data);
}

/**
 * 4. Procesa la respuesta del Chatbot (Webhook entrante).
 * Actualiza la BD con los resultados del chat.
 * @param {object} body - Payload recibido del bot.
 */
async function handleBotWebhook(body) {
  const { candidato_id, estado_gestion, resultado_agenda, evento_id, nota, extra_candidato_fields } = body;
  let targetId = candidato_id;

  // Si no llega candidato_id, intentar buscar por telefono (como respaldo)
  if (!targetId && body.telefono) {
      // Intentar formatear telefono para buscar: "+57..." o "57..."
      let tel = body.telefono;
      if (!tel.startsWith('+')) tel = '+' + tel; // La BD guarda con + usualmente

      const searchRes = await pool.query('SELECT id FROM public.candidatos WHERE telefono = $1 LIMIT 1', [tel]);
      if (searchRes.rows.length > 0) {
          targetId = searchRes.rows[0].id;
      }
  }

  if (!targetId) throw new Error('No se pudo identificar al candidato (falta candidato_id o telefono no encontrado).');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Manejo de estado: estado_gestion (explicito) o resultado_agenda map
    let statusToSet = estado_gestion;

    if (!statusToSet && resultado_agenda === 'AGENDADO') {
        // Mapear AGENDADO a 'CITA_AGENDADA' en la BD
        const statusRes = await client.query("SELECT codigo FROM public.estados_gestion WHERE codigo = 'CITA_AGENDADA' LIMIT 1");
        if (statusRes.rows.length > 0) {
            statusToSet = 'CITA_AGENDADA';
        } else {
             // Fallback si no existe CITA_AGENDADA, usar algo genérico o dejarlo
             console.warn('Estado CITA_AGENDADA no encontrado en DB, no se actualizará estado.');
        }
    }

    if (statusToSet) {
        const estadoRes = await client.query('SELECT id FROM public.estados_gestion WHERE codigo = $1', [statusToSet]);
        if (estadoRes.rows.length > 0) {
            await client.query(
                'UPDATE public.candidatos SET estado_gestion_id = $1, updated_at = NOW() WHERE id = $2',
                [estadoRes.rows[0].id, targetId]
            );
        }
    }

    // 1.5. Manejo de Inscripción a Evento (si vino AGENDADO y evento_id)
    if (resultado_agenda === 'AGENDADO' && evento_id) {
        // Verificar si el evento existe y tiene cupo (opcional, pero recomendado)
        // Actualizar candidatos.evento_asignado_id 
        await client.query('UPDATE public.candidatos SET evento_asignado_id = $1 WHERE id = $2', [evento_id, targetId]);
        
        // Incrementar inscritos (simple counter, ideally should be robust)
        await client.query('UPDATE public.eventos SET inscritos_actuales = inscritos_actuales + 1 WHERE id = $1', [evento_id]);
    }

    // 2. Insertar nota histórica si se provee
    // (Asumimos que nota_horario es un lugar temporal, o idealmente añadir a una bitácora)
    if (nota) {
        await client.query(
            'UPDATE public.candidatos SET nota_horario = $1 WHERE id = $2',
            [nota, targetId] // Usar targetId en vez de candidato_id
        );
    }

    // 3. Actualizar campos extras permitidos
    if (extra_candidato_fields && typeof extra_candidato_fields === 'object') {
        const whitelisted = ['telefono', 'correo', 'franja_actual', 'fase_actual'];
        for (const [key, value] of Object.entries(extra_candidato_fields)) {
            if (whitelisted.includes(key)) {
                // Usamos inyección segura con placeholders dinámicos no es trivial con pg puro sin ORM
                // Pero como key está whitelisted, es seguro concatenar la key.
                await client.query(
                    `UPDATE public.candidatos SET ${key} = $1 WHERE id = $2`,
                    [value, targetId] // Usar targetId
                );
            }
        }
    }

    await client.query('COMMIT');
    console.log(`[ChatbotService] Candidato ${targetId} actualizado exitosamente tras interacción bot.`);
    return { success: true };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ChatbotService] Error actualizando DB desde bot:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  processCandidateCallFail,
  handleBotWebhook,
  forceChatbotTrigger,
  sendToChatbot,
  gatherCandidateData // Exportada para debug
};

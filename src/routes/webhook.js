/**
 * src/routes/webhook.js – ElevenLabs webhook route
 *
 * POST /webhook/elevenlabs-resultado
 *
 * Replaces the Webhook node in the "Asesor Nueva BD" n8n flow
 * (previously at path c7110bc4-8aac-4e71-b16b-7628b6e68105).
 *
 * Expected body from ElevenLabs:
 * {
 *   "resultado":    "AGENDADO",
 *   "dia":          "miércoles",
 *   "hora":         "7:00 PM",
 *   "candidato_id": "b243b83d-341c-43d6-a2f7-10dd0a0a8091",
 *   "evento_id":    2,
 *   "nota":         "Candidate agreed to schedule interview"
 * }
 */
'use strict';

const express              = require('express');
const { processWebhookResult } = require('../services/webhook/webhookService');
const logger               = require('../utils/logger');

const router = express.Router();

/**
 * POST /webhook/elevenlabs-resultado
 */
router.post('/elevenlabs-resultado', async (req, res) => {
  try {
    const payload = req.body;

    // Basic validation
    if (!payload || !payload.candidato_id || !payload.resultado) {
      logger.warn(
        { event: 'webhook_invalid_payload', body: payload },
        'Webhook received invalid payload',
      );
      return res.status(400).json({
        error: 'Missing required fields: candidato_id and resultado',
      });
    }

    const result = await processWebhookResult(payload);

    return res.status(200).json({
      success: true,
      ...result,
    });

  } catch (err) {
    logger.error(
      { event: 'webhook_route_error', err: err.message },
      'Error processing webhook',
    );
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  }
});

module.exports = router;


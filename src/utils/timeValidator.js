/**
 * src/utils/timeValidator.js – Call window validation
 *
 * Equivalent to the "Validar horario de llamada" node in BOTH n8n flows
 * (Asesor Nueva BD and Varios).
 *
 * Rules (Colombia time, UTC-5):
 *   Global window : 06:00 – 22:00
 *   horarios.codigo = 'AM'   → 06:00 – 13:00
 *   horarios.codigo = 'PM'   → 14:00 – 22:00
 *   horarios.codigo = 'AMPM' → 06:00 – 22:00 (same as global)
 *
 * If no horario is found the global window applies.
 *
 * Behavior when outside window:
 *   - The queue item stays PENDIENTE for the next worker iteration.
 *   - No call is made.
 */
'use strict';

const { colombiaHour } = require('./dateHelpers');

/**
 * Returns true if a call can be placed right now given the candidate's schedule.
 *
 * @param {string|null} horarioCodigo – 'AM', 'PM', 'AMPM', or null
 * @returns {boolean}
 */
function isCallWindowOpen(horarioCodigo) {
  const hora = colombiaHour();

  // Global window: 06:00 – 22:00 (exclusive of 22)
  if (hora < 6 || hora >= 22) return false;

  if (!horarioCodigo) return true; // no schedule constraint → global window only

  switch (horarioCodigo.toUpperCase()) {
    case 'AM':
      return hora >= 6 && hora < 13;
    case 'PM':
      return hora >= 14 && hora < 22;
    case 'AMPM':
      return hora >= 6 && hora < 22;
    default:
      return true; // unknown code → fall back to global window
  }
}

module.exports = { isCallWindowOpen };


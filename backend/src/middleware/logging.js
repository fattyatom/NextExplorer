const pinoHttp = require('pino-http');
const { logging } = require('../config/index');
const logger = require('../utils/logger');

/**
 * Map a completed request to a log level.
 *
 * pino-http invokes customLogLevel as `(req, res, err)`. The leading `req`
 * argument matters: an older `(res, err)` signature lined `err` up with the
 * response object, which is always truthy, so every completed request —
 * including `GET /healthz` 200 — was logged at `error`. That made the
 * service's error rate meaningless in SigNoz until 2026-08-25. The
 * accompanying test drives the real pino-http middleware so a future major
 * bump that reorders these arguments fails loudly instead of silently.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Error} [err]
 * @returns {'debug' | 'info' | 'warn' | 'error'}
 */
const resolveHttpLogLevel = (req, res, err) => {
  const statusCode = res && typeof res.statusCode === 'number' ? res.statusCode : 0;
  if (err || statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return logging.isDebug ? 'debug' : 'info';
};

const configureHttpLogging = (app) => {
  if (!logging.enableHttpLogging) {
    logger.debug('HTTP logging is disabled');
    return;
  }

  app.use(
    pinoHttp({
      logger: logger.child({ context: 'http' }),
      customLogLevel: resolveHttpLogLevel,
    })
  );

  logger.debug('HTTP logging middleware configured');
};

module.exports = { configureHttpLogging, resolveHttpLogLevel };

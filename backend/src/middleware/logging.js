const pinoHttp = require('pino-http');
const { logging } = require('../config/index');
const logger = require('../utils/logger');
const { sanitizeHttpRequestForLog } = require('../utils/logSanitizer');

/**
 * The level a finished request is logged at.
 *
 * pino-http calls this as `(req, res, err)`. Declared as `(res, err)`, the
 * request stood where the response was meant to be and the response where the
 * error was: `err` was never empty, so every request — a health probe answered
 * 200 included — was logged at `error`, and a real failure had nowhere to
 * stand out.
 */
const resolveHttpLogLevel = (req, res, err) => {
  const statusCode = typeof res?.statusCode === 'number' ? res.statusCode : 0;
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
      serializers: {
        req: sanitizeHttpRequestForLog,
      },
      customLogLevel: resolveHttpLogLevel,
    })
  );

  logger.debug('HTTP logging middleware configured');
};

module.exports = { configureHttpLogging, resolveHttpLogLevel };

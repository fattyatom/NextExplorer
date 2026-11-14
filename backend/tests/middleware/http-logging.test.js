import { describe, it, expect, beforeAll } from 'vitest';

const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const request = require('supertest');

const { resolveHttpLogLevel } = require('../../src/middleware/logging');

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };

/**
 * Build an app wired to the REAL pino-http middleware, logging into an
 * in-memory stream. Driving the real middleware (rather than calling
 * resolveHttpLogLevel by hand) is the point: it pins the `(req, res, err)`
 * argument order that pino-http passes, which is what regressed and made
 * every 200 log at `error`.
 */
const buildApp = () => {
  const lines = [];
  const stream = {
    write(chunk) {
      lines.push(JSON.parse(chunk));
    },
  };
  const logger = pino({ level: 'trace', base: null }, stream);

  const app = express();
  app.use(pinoHttp({ logger, customLogLevel: resolveHttpLogLevel }));
  app.get('/healthz', (req, res) => res.status(200).send('ok'));
  app.get('/cached', (req, res) => res.status(304).end());
  app.get('/missing', (req, res) => res.status(404).send('nope'));
  app.get('/broken', (req, res) => res.status(503).send('down'));

  return { app, lines };
};

const levelFor = async (path, expectedStatus) => {
  const { app, lines } = buildApp();
  await request(app).get(path).expect(expectedStatus);
  // pino-http synthesizes an `err` for 5xx, which switches the message from
  // 'request completed' to 'request errored' — match on the response instead.
  const completed = lines.filter((line) => typeof line?.res?.statusCode === 'number');
  expect(completed).toHaveLength(1);
  return completed[0];
};

describe('HTTP request log levels', () => {
  it('logs a successful response at info, not error', async () => {
    const line = await levelFor('/healthz', 200);
    expect(line.level).toBe(LEVELS.info);
    expect(line.res.statusCode).toBe(200);
  });

  it('logs a 304 at info', async () => {
    const line = await levelFor('/cached', 304);
    expect(line.level).toBe(LEVELS.info);
  });

  it('logs a 4xx at warn', async () => {
    const line = await levelFor('/missing', 404);
    expect(line.level).toBe(LEVELS.warn);
  });

  it('logs a 5xx at error', async () => {
    const line = await levelFor('/broken', 503);
    expect(line.level).toBe(LEVELS.error);
  });

  it('never logs a 2xx at error across a mixed request stream', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/healthz').expect(200);
    await request(app).get('/missing').expect(404);
    await request(app).get('/healthz').expect(200);

    const errors = lines.filter((line) => line.level >= LEVELS.error);
    expect(errors).toHaveLength(0);
  });
});

describe('resolveHttpLogLevel', () => {
  it('escalates to error when pino-http reports a transport error', () => {
    expect(resolveHttpLogLevel({}, { statusCode: 200 }, new Error('aborted'))).toBe('error');
  });

  it('does not treat the response object as an error', () => {
    // The regression: with a (res, err) signature, `err` received the
    // response — always truthy — and returned 'error' for everything.
    expect(resolveHttpLogLevel({ method: 'GET' }, { statusCode: 200 })).toBe('info');
  });

  it('tolerates a missing response object', () => {
    expect(resolveHttpLogLevel({}, undefined)).toBe('info');
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

let envContext;
const testContent = 'Hello, chunked download world! This is test content for range requests.';
const testFilename = 'sample.txt';
let testFilePath;

const testUser = { id: 'user-1', roles: ['user'] };

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'range-download-test-',
    modules: [
      'src/routes/files/rangeDownload',
      'src/services/accessManager',
      'src/services/preparedDownloads',
      'src/middleware/errorHandler',
    ],
  });

  // Create a test file
  testFilePath = path.join(envContext.volumeDir, testFilename);
  await fs.writeFile(testFilePath, testContent);
});

afterAll(async () => {
  await envContext.cleanup();
});

const buildApp = ({ user } = {}) => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');
  clearModuleCache('src/routes/files/rangeDownload');
  clearModuleCache('src/services/accessManager');
  clearModuleCache('src/middleware/errorHandler');

  // Mock access manager
  const accessManager = envContext.requireFresh('src/services/accessManager');
  accessManager.resolvePathWithAccess = async (context, relativePath) => ({
    accessInfo: { canAccess: true, canRead: true, canDownload: true },
    resolved: {
      absolutePath: path.join(envContext.volumeDir, relativePath),
      relativePath,
    },
  });

  const rangeDownloadRoutes = envContext.requireFresh('src/routes/files/rangeDownload');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', rangeDownloadRoutes);
  app.use(errorHandler);
  return app;
};

describe('Range Download Routes', () => {
  describe('HEAD /api/range-download', () => {
    it('returns file metadata without body', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .head(`/api/range-download?path=${testFilename}`);

      expect(res.status).toBe(200);
      expect(Number(res.headers['content-length'])).toBe(testContent.length);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-disposition']).toContain(testFilename);
      expect(res.text).toBeFalsy();
    });
  });

  describe('GET /api/range-download (full file)', () => {
    it('returns the entire file with 200', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get(`/api/range-download?path=${testFilename}`);

      expect(res.status).toBe(200);
      expect(Number(res.headers['content-length'])).toBe(testContent.length);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text).toBe(testContent);
    });
  });

  describe('GET /api/range-download (Range header)', () => {
    it('returns 206 Partial Content for a valid range', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get(`/api/range-download?path=${testFilename}`)
        .set('Range', 'bytes=0-4');

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-4/${testContent.length}`);
      expect(Number(res.headers['content-length'])).toBe(5);
      expect(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text).toBe('Hello');
    });

    it('returns the correct middle range', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get(`/api/range-download?path=${testFilename}`)
        .set('Range', 'bytes=7-13');

      expect(res.status).toBe(206);
      expect(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text).toBe('chunked');
    });

    it('clamps end to file size - 1 when end exceeds file size', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get(`/api/range-download?path=${testFilename}`)
        .set('Range', `bytes=0-${testContent.length + 1000}`);

      expect(res.status).toBe(206);
      const end = testContent.length - 1;
      expect(res.headers['content-range']).toBe(`bytes 0-${end}/${testContent.length}`);
    });

    it('returns 416 when start exceeds end', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get(`/api/range-download?path=${testFilename}`)
        .set('Range', 'bytes=100-5');

      expect(res.status).toBe(416);
    });

    it('returns 416 for malformed non-bytes range', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get(`/api/range-download?path=${testFilename}`)
        .set('Range', 'items=0-4');

      expect(res.status).toBe(416);
    });

    it('handles open-ended range (bytes=10-)', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get(`/api/range-download?path=${testFilename}`)
        .set('Range', 'bytes=10-');

      expect(res.status).toBe(206);
      const expectedLength = testContent.length - 10;
      expect(Number(res.headers['content-length'])).toBe(expectedLength);
    });
  });

  describe('GET /api/range-download (prepared download)', () => {
    it('serves a prepared download by downloadId', async () => {
      // Seed the preparedDownloads store
      clearModuleCache('src/services/preparedDownloads');
      const preparedDownloads = envContext.requireFresh('src/services/preparedDownloads');

      const zipContent = 'fake-zip-content-for-test';
      const zipPath = path.join(envContext.volumeDir, 'test-prepared.zip');
      await fs.writeFile(zipPath, zipContent);

      preparedDownloads.set('dl-test-123', {
        userId: testUser.id,
        tempPath: zipPath,
        filename: 'prepared.zip',
        size: zipContent.length,
      });

      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get('/api/range-download?downloadId=dl-test-123');

      expect(res.status).toBe(200);
      expect(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text).toBe(zipContent);
    });

    it('returns 404 for expired/missing downloadId', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get('/api/range-download?downloadId=nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('validation', () => {
    it('returns 400 when no path or downloadId is provided', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .get('/api/range-download');

      expect(res.status).toBe(400);
    });
  });
});

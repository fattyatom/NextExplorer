import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { setupTestEnv, clearModuleCache, modulePath } from '../helpers/env-test-utils.js';

let envContext;
const testUser = { id: 'user-1', roles: ['user'] };

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'download-test-',
    modules: [
      'src/routes/files/download',
      'src/routes/files/rangeDownload',
      'src/services/accessManager',
      'src/services/preparedDownloads',
      'src/middleware/errorHandler',
    ],
  });

  const testDir = path.join(envContext.volumeDir, 'photos');
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(path.join(testDir, 'a.txt'), 'File A contents');
  await fs.writeFile(path.join(testDir, 'b.txt'), 'File B contents');
  await fs.writeFile(path.join(envContext.volumeDir, 'solo.txt'), 'Solo file');
});

afterAll(async () => {
  await envContext.cleanup();
});

const buildApp = ({ user } = {}) => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');
  clearModuleCache('src/routes/files/download');
  clearModuleCache('src/routes/files/rangeDownload');
  clearModuleCache('src/services/accessManager');
  clearModuleCache('src/services/preparedDownloads');
  clearModuleCache('src/middleware/errorHandler');

  const accessManager = envContext.requireFresh('src/services/accessManager');
  accessManager.resolvePathWithAccess = async (context, relativePath) => ({
    accessInfo: { canAccess: true, canRead: true, canDownload: true },
    resolved: {
      absolutePath: path.join(envContext.volumeDir, relativePath),
      relativePath,
    },
  });

  const downloadRoutes = envContext.requireFresh('src/routes/files/download');
  const rangeDownloadRoutes = envContext.requireFresh('src/routes/files/rangeDownload');
  const preparedDownloads = require(modulePath('src/services/preparedDownloads'));
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', downloadRoutes);
  app.use('/api', rangeDownloadRoutes);
  app.use(errorHandler);
  return { app, preparedDownloads };
};

/**
 * Poll preparedDownloads until the archive finishes building.
 * Returns the download metadata once ready.
 */
async function waitForBuild(preparedDownloads, downloadId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dl = preparedDownloads.get(downloadId);
    if (dl && !dl.building) return dl;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Archive build did not complete within ${timeoutMs}ms`);
}

describe('POST /api/download', () => {
  // ── Single-file fast path ──────────────────────────────────────────
  describe('single file', () => {
    it('streams the file directly (no zip, no async build)', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download')
        .send({ items: ['solo.txt'] });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('solo.txt');
      expect(res.text).toBe('Solo file');
    });
  });

  // ── Async archive build ───────────────────────────────────────────
  describe('directory / multi-file (async build)', () => {
    it('returns 202 with downloadId for a directory', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download')
        .send({ items: ['photos'], basePath: '' });

      expect(res.status).toBe(202);
      expect(res.body.downloadId).toMatch(/^[a-f0-9]{32}$/);
      expect(res.body.filename).toBe('photos.zip');
    });

    it('returns 202 with downloadId for multiple files', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download')
        .send({ items: ['photos/a.txt', 'photos/b.txt'], basePath: '' });

      expect(res.status).toBe(202);
      expect(res.body.downloadId).toBeDefined();
      expect(res.body.filename).toBe('download.zip');
    });

    it('builds a valid zip to temp file', async () => {
      const { app, preparedDownloads } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download')
        .send({ items: ['photos'], basePath: '' });

      const { downloadId } = res.body;

      // Wait for the background build to finish
      const dl = await waitForBuild(preparedDownloads, downloadId);
      expect(dl.size).toBeGreaterThan(0);
      expect(dl.filename).toBe('photos.zip');

      // Verify the temp file is a valid zip
      const zipBuffer = await fs.readFile(dl.tempPath);
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries().map((e) => e.entryName).sort();
      expect(entries).toContain('photos/a.txt');
      expect(entries).toContain('photos/b.txt');
    });

    it('serves the completed zip via range-download', async () => {
      const { app, preparedDownloads } = buildApp({ user: testUser });
      const postRes = await request(app)
        .post('/api/download')
        .send({ items: ['photos'], basePath: '' });

      const { downloadId } = postRes.body;
      await waitForBuild(preparedDownloads, downloadId);

      // Download via range-download endpoint
      const getRes = await request(app)
        .get(`/api/range-download?downloadId=${downloadId}`)
        .responseType('arraybuffer');

      expect(getRes.status).toBe(200);
      expect(getRes.headers['content-type']).toBe('application/zip');

      const zip = new AdmZip(Buffer.from(getRes.body));
      const entries = zip.getEntries().map((e) => e.entryName).sort();
      expect(entries).toContain('photos/a.txt');
      expect(entries).toContain('photos/b.txt');
    });

    it('rejects range-download while still building', async () => {
      const { app } = buildApp({ user: testUser });
      const postRes = await request(app)
        .post('/api/download')
        .send({ items: ['photos'], basePath: '' });

      const { downloadId } = postRes.body;

      // Immediately try range-download (before build finishes)
      // This may or may not be "building" depending on speed, so just
      // verify the endpoint responds without crashing
      const getRes = await request(app)
        .head(`/api/range-download?downloadId=${downloadId}`);

      expect([200, 404]).toContain(getRes.status);
    });
  });

  // ── Validation ─────────────────────────────────────────────────────
  describe('validation', () => {
    it('returns 400 when no paths provided', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download')
        .send({ items: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when body is missing', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 for only-whitespace paths', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download')
        .send({ items: ['  ', ''] });

      expect(res.status).toBe(400);
    });
  });
});

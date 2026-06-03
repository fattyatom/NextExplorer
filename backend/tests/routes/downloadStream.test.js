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
    tag: 'download-stream-test-',
    modules: [
      'src/routes/downloadStream',
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
  clearModuleCache('src/routes/downloadStream');
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

  const downloadStreamRoutes = envContext.requireFresh('src/routes/downloadStream');
  // Access the same preparedDownloads instance that downloadStream loaded into cache
  // (requireFresh would clear+reload, giving us a different Map)
  const preparedDownloads = require(modulePath('src/services/preparedDownloads'));
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', downloadStreamRoutes);
  app.use(errorHandler);
  return { app, preparedDownloads };
};

describe('Download Stream Routes', () => {
  describe('POST /api/download/zip-stream', () => {
    it('streams a valid zip for a directory', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/zip-stream')
        .send({ items: ['photos'], basePath: '' })
        .responseType('arraybuffer');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['x-download-id']).toBeDefined();
      expect(res.headers['content-disposition']).toContain('photos.zip');

      const zip = new AdmZip(Buffer.from(res.body));
      const entries = zip.getEntries().map((e) => e.entryName).sort();
      expect(entries).toContain('photos/a.txt');
      expect(entries).toContain('photos/b.txt');
    });

    it('streams a valid zip for multiple files', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/zip-stream')
        .send({ items: ['photos/a.txt', 'photos/b.txt'], basePath: '' })
        .responseType('arraybuffer');

      expect(res.status).toBe(200);
      expect(res.headers['x-download-id']).toBeDefined();

      const zip = new AdmZip(Buffer.from(res.body));
      const entries = zip.getEntries().map((e) => e.entryName).sort();
      expect(entries).toContain('photos/a.txt');
      expect(entries).toContain('photos/b.txt');
    });

    it('registers the download for chunked resume', async () => {
      const { app, preparedDownloads } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/zip-stream')
        .send({ items: ['photos'], basePath: '' })
        .responseType('arraybuffer');

      const downloadId = res.headers['x-download-id'];
      const dl = preparedDownloads.get(downloadId);
      expect(dl).not.toBeNull();
      expect(dl.size).toBeGreaterThan(0);
      expect(dl.building).toBeUndefined();
      expect(dl.filename).toBe('photos.zip');
    });

    it('returns 400 when no paths provided', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/zip-stream')
        .send({ items: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when body is missing', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/zip-stream')
        .send({});

      expect(res.status).toBe(400);
    });

    it('names single-directory zip after the directory', async () => {
      const { app } = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/zip-stream')
        .send({ items: ['photos'] })
        .responseType('arraybuffer');

      expect(res.headers['content-disposition']).toContain('photos.zip');
    });
  });
});

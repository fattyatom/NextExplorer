import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

let envContext;
const testUser = { id: 'user-1', roles: ['user'] };

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'download-prepare-test-',
    modules: [
      'src/routes/downloadPrepare',
      'src/services/accessManager',
      'src/services/preparedDownloads',
      'src/middleware/errorHandler',
    ],
  });

  // Create test directory structure
  const testDir = path.join(envContext.volumeDir, 'docs');
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(path.join(testDir, 'readme.txt'), 'Hello readme');
  await fs.writeFile(path.join(testDir, 'notes.txt'), 'Hello notes');
  await fs.writeFile(path.join(envContext.volumeDir, 'single.txt'), 'Single file');
});

afterAll(async () => {
  await envContext.cleanup();
});

const buildApp = ({ user } = {}) => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');
  clearModuleCache('src/routes/downloadPrepare');
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

  const downloadPrepareRoutes = envContext.requireFresh('src/routes/downloadPrepare');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', downloadPrepareRoutes);
  app.use(errorHandler);
  return app;
};

describe('Download Prepare Routes', () => {
  describe('POST /api/download/prepare', () => {
    it('creates a zip for a directory and returns downloadId', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/prepare')
        .send({ items: ['docs'], basePath: '' });

      expect(res.status).toBe(200);
      expect(res.body.downloadId).toBeDefined();
      expect(typeof res.body.downloadId).toBe('string');
      expect(res.body.filename).toBe('docs.zip');
      expect(res.body.size).toBeGreaterThan(0);
    });

    it('creates a zip for multiple files', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/prepare')
        .send({ items: ['docs/readme.txt', 'docs/notes.txt'], basePath: '' });

      expect(res.status).toBe(200);
      expect(res.body.downloadId).toBeDefined();
      expect(res.body.filename).toBe('download.zip');
      expect(res.body.size).toBeGreaterThan(0);
    });

    it('returns 400 when no paths provided', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/prepare')
        .send({ items: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when paths are all empty strings', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/prepare')
        .send({ items: ['', '  '] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when body is missing', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/prepare')
        .send({});

      expect(res.status).toBe(400);
    });

    it('names single-directory zip after the directory', async () => {
      const app = buildApp({ user: testUser });
      const res = await request(app)
        .post('/api/download/prepare')
        .send({ items: ['docs'] });

      expect(res.body.filename).toBe('docs.zip');
    });
  });
});

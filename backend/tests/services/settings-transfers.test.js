import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestEnv, clearModuleCache, overrideEnv } from '../helpers/env-test-utils.js';

let envContext;

const adminUser = { id: 'admin-1', roles: ['admin'] };
const regularUser = { id: 'user-1', roles: ['user'] };

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'settings-transfers-test-',
    modules: [
      'src/services/settingsService',
      'src/routes/settings',
      'src/middleware/errorHandler',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

const buildApp = ({ user } = {}) => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');
  clearModuleCache('src/services/settingsService');
  clearModuleCache('src/routes/settings');
  clearModuleCache('src/middleware/errorHandler');

  const settingsRoutes = envContext.requireFresh('src/routes/settings');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', settingsRoutes);
  app.use(errorHandler);
  return app;
};

describe('Chunked Transfer Settings', () => {
  describe('GET /api/settings', () => {
    it('returns chunkedTransfers with defaults for admin', async () => {
      const app = buildApp({ user: adminUser });
      const res = await request(app).get('/api/settings');

      expect(res.status).toBe(200);
      expect(res.body.chunkedTransfers).toBeDefined();
      expect(res.body.chunkedTransfers.uploadEnabled).toBe(true);
      expect(res.body.chunkedTransfers.downloadEnabled).toBe(true);
      expect(res.body.chunkedTransfers.chunkSizeMB).toBe(20);
      // Admin gets envLocked
      expect(res.body.chunkedTransfers.envLocked).toBeDefined();
      expect(res.body.chunkedTransfers.envLocked.uploadEnabled).toBe(false);
      expect(res.body.chunkedTransfers.envLocked.downloadEnabled).toBe(false);
      expect(res.body.chunkedTransfers.envLocked.chunkSizeMB).toBe(false);
    });

    it('returns chunkedTransfers without envLocked for regular user', async () => {
      const app = buildApp({ user: regularUser });
      const res = await request(app).get('/api/settings');

      expect(res.status).toBe(200);
      expect(res.body.chunkedTransfers).toBeDefined();
      expect(res.body.chunkedTransfers.uploadEnabled).toBe(true);
      expect(res.body.chunkedTransfers.downloadEnabled).toBe(true);
      expect(res.body.chunkedTransfers.chunkSizeMB).toBe(20);
      expect(res.body.chunkedTransfers.envLocked).toBeUndefined();
    });

    it('does not return chunkedTransfers for unauthenticated requests', async () => {
      const app = buildApp();
      const res = await request(app).get('/api/settings');

      expect(res.status).toBe(200);
      expect(res.body.chunkedTransfers).toBeUndefined();
    });
  });

  describe('PATCH /api/settings (chunkedTransfers)', () => {
    it('allows admin to update uploadEnabled', async () => {
      const app = buildApp({ user: adminUser });

      const res = await request(app)
        .patch('/api/settings')
        .send({ chunkedTransfers: { uploadEnabled: false } });

      expect(res.status).toBe(200);
      expect(res.body.chunkedTransfers.uploadEnabled).toBe(false);
      // Other fields unchanged
      expect(res.body.chunkedTransfers.downloadEnabled).toBe(true);
    });

    it('allows admin to update downloadEnabled', async () => {
      const app = buildApp({ user: adminUser });

      const res = await request(app)
        .patch('/api/settings')
        .send({ chunkedTransfers: { downloadEnabled: false } });

      expect(res.status).toBe(200);
      expect(res.body.chunkedTransfers.downloadEnabled).toBe(false);
    });

    it('allows admin to update chunkSizeMB', async () => {
      const app = buildApp({ user: adminUser });

      const res = await request(app)
        .patch('/api/settings')
        .send({ chunkedTransfers: { chunkSizeMB: 50 } });

      expect(res.status).toBe(200);
      expect(res.body.chunkedTransfers.chunkSizeMB).toBe(50);
    });

    it('clamps chunkSizeMB to valid range (1-100)', async () => {
      const app = buildApp({ user: adminUser });

      const res1 = await request(app)
        .patch('/api/settings')
        .send({ chunkedTransfers: { chunkSizeMB: 0 } });
      expect(res1.body.chunkedTransfers.chunkSizeMB).toBe(1);

      const res2 = await request(app)
        .patch('/api/settings')
        .send({ chunkedTransfers: { chunkSizeMB: 200 } });
      expect(res2.body.chunkedTransfers.chunkSizeMB).toBe(100);
    });

    it('rejects non-admin update', async () => {
      const app = buildApp({ user: regularUser });

      const res = await request(app)
        .patch('/api/settings')
        .send({ chunkedTransfers: { uploadEnabled: false } });

      expect(res.status).toBe(403);
    });
  });

  describe('environment variable overrides', () => {
    let restore;

    afterEach(() => {
      if (restore) {
        restore();
        restore = null;
      }
    });

    it('CHUNKED_UPLOAD_ENABLED overrides DB value', async () => {
      restore = overrideEnv({ CHUNKED_UPLOAD_ENABLED: 'false' });

      const app = buildApp({ user: adminUser });
      const res = await request(app).get('/api/settings');

      expect(res.body.chunkedTransfers.uploadEnabled).toBe(false);
      expect(res.body.chunkedTransfers.envLocked.uploadEnabled).toBe(true);
    });

    it('CHUNKED_DOWNLOAD_ENABLED overrides DB value', async () => {
      restore = overrideEnv({ CHUNKED_DOWNLOAD_ENABLED: 'true' });

      const app = buildApp({ user: adminUser });
      const res = await request(app).get('/api/settings');

      expect(res.body.chunkedTransfers.downloadEnabled).toBe(true);
      expect(res.body.chunkedTransfers.envLocked.downloadEnabled).toBe(true);
    });

    it('CHUNK_SIZE_MB overrides DB value', async () => {
      restore = overrideEnv({ CHUNK_SIZE_MB: '10' });

      const app = buildApp({ user: adminUser });
      const res = await request(app).get('/api/settings');

      expect(res.body.chunkedTransfers.chunkSizeMB).toBe(10);
      expect(res.body.chunkedTransfers.envLocked.chunkSizeMB).toBe(true);
    });

    it('env-locked fields cannot be changed via PATCH', async () => {
      restore = overrideEnv({ CHUNKED_UPLOAD_ENABLED: 'false' });

      const app = buildApp({ user: adminUser });

      // Try to set uploadEnabled to true — should be ignored because env-locked
      const res = await request(app)
        .patch('/api/settings')
        .send({ chunkedTransfers: { uploadEnabled: true } });

      expect(res.status).toBe(200);
      // Still false because env var overrides
      expect(res.body.chunkedTransfers.uploadEnabled).toBe(false);
    });
  });
});

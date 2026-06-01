import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'chunked-upload-test-',
    modules: [
      'src/routes/chunkedUpload',
      'src/services/authorizationService',
      'src/utils/pathUtils',
      'src/utils/fsUtils',
      'src/middleware/errorHandler',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

const adminUser = { id: 'user-1', roles: ['admin'] };
const otherUser = { id: 'user-2', roles: ['user'] };

// Cached router + errorHandler so cross-user tests share the same activeUploads Map
let cachedRouter = null;
let cachedErrorHandler = null;

function ensureRouter() {
  if (cachedRouter) return;
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');
  clearModuleCache('src/routes/chunkedUpload');
  clearModuleCache('src/services/authorizationService');
  clearModuleCache('src/middleware/errorHandler');

  // Mock the authorization service to allow uploads to volumeDir
  const authModule = envContext.requireFresh('src/services/authorizationService');
  authModule.authorizeAndResolve = async (context, uploadTo, action) => ({
    allowed: true,
    accessInfo: { canAccess: true, canUpload: true },
    resolved: {
      absolutePath: envContext.volumeDir,
      relativePath: uploadTo || '',
    },
  });

  cachedRouter = envContext.requireFresh('src/routes/chunkedUpload');
  cachedErrorHandler = envContext.requireFresh('src/middleware/errorHandler').errorHandler;
}

/**
 * Build a test app with the chunked upload router mounted.
 * All apps share the same router module so activeUploads is shared (needed for cross-user tests).
 */
const buildApp = ({ user } = {}) => {
  ensureRouter();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api', cachedRouter);
  app.use(cachedErrorHandler);
  return app;
};

describe('Chunked Upload Routes', () => {
  // Clean the volume dir between tests
  beforeEach(async () => {
    const entries = await fs.readdir(envContext.volumeDir);
    await Promise.all(
      entries.map((e) => fs.rm(path.join(envContext.volumeDir, e), { recursive: true, force: true }))
    );
  });

  describe('POST /api/chunked-upload/init', () => {
    it('returns uploadId for valid request', async () => {
      const app = buildApp({ user: adminUser });
      const res = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 1024, uploadTo: '', relativePath: '' });

      expect(res.status).toBe(200);
      expect(res.body.uploadId).toBeDefined();
      expect(typeof res.body.uploadId).toBe('string');
      expect(res.body.uploadId.length).toBe(32); // 16 random bytes = 32 hex chars
    });

    it('creates a temp file on disk', async () => {
      const app = buildApp({ user: adminUser });
      const res = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 1024, uploadTo: '', relativePath: '' });

      const uploadId = res.body.uploadId;
      const files = await fs.readdir(envContext.volumeDir);
      const tempFile = files.find((f) => f.includes(`.chunked-${uploadId}`));
      expect(tempFile).toBeDefined();
    });

    it('rejects missing filename', async () => {
      const app = buildApp({ user: adminUser });
      const res = await request(app)
        .post('/api/chunked-upload/init')
        .send({ totalSize: 1024 });

      expect(res.status).toBe(400);
    });

    it('rejects invalid totalSize', async () => {
      const app = buildApp({ user: adminUser });

      const res1 = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 0 });
      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: -1 });
      expect(res2.status).toBe(400);

      const res3 = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 'abc' });
      expect(res3.status).toBe(400);
    });
  });

  describe('PATCH /api/chunked-upload/:uploadId', () => {
    it('writes chunk data at the correct offset', async () => {
      const app = buildApp({ user: adminUser });

      // Init
      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 10, uploadTo: '', relativePath: '' });
      const { uploadId } = initRes.body;

      // Write first 5 bytes
      const chunk1 = Buffer.from('Hello');
      await request(app)
        .patch(`/api/chunked-upload/${uploadId}`)
        .set('Content-Range', 'bytes 0-4/10')
        .set('Content-Type', 'application/octet-stream')
        .send(chunk1)
        .expect(200);

      // Write last 5 bytes
      const chunk2 = Buffer.from('World');
      const patchRes = await request(app)
        .patch(`/api/chunked-upload/${uploadId}`)
        .set('Content-Range', 'bytes 5-9/10')
        .set('Content-Type', 'application/octet-stream')
        .send(chunk2);

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.received).toBe(10);

      // Verify file contents
      const files = await fs.readdir(envContext.volumeDir);
      const tempFile = files.find((f) => f.includes(`.chunked-${uploadId}`));
      const content = await fs.readFile(path.join(envContext.volumeDir, tempFile), 'utf8');
      expect(content).toBe('HelloWorld');
    });

    it('returns 404 for unknown uploadId', async () => {
      const app = buildApp({ user: adminUser });
      const res = await request(app)
        .patch('/api/chunked-upload/nonexistent')
        .set('Content-Range', 'bytes 0-4/10')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      expect(res.status).toBe(404);
    });

    it('rejects missing Content-Range header', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 10, uploadTo: '', relativePath: '' });

      const res = await request(app)
        .patch(`/api/chunked-upload/${initRes.body.uploadId}`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      expect(res.status).toBe(400);
    });

    it('rejects malformed Content-Range header', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 10, uploadTo: '', relativePath: '' });

      const res = await request(app)
        .patch(`/api/chunked-upload/${initRes.body.uploadId}`)
        .set('Content-Range', 'bytes invalid')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      expect(res.status).toBe(400);
    });

    it('rejects chunk with wrong total size', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 10, uploadTo: '', relativePath: '' });

      const res = await request(app)
        .patch(`/api/chunked-upload/${initRes.body.uploadId}`)
        .set('Content-Range', 'bytes 0-4/999')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      expect(res.status).toBe(400);
    });

    it('rejects chunk with mismatched body size', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 10, uploadTo: '', relativePath: '' });

      // Claim bytes 0-9 (10 bytes) but only send 5
      const res = await request(app)
        .patch(`/api/chunked-upload/${initRes.body.uploadId}`)
        .set('Content-Range', 'bytes 0-9/10')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      expect(res.status).toBe(400);
    });

    it('rejects chunk from a different user', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 10, uploadTo: '', relativePath: '' });

      // Build a second app with a different user
      const app2 = buildApp({ user: otherUser });
      const res = await request(app2)
        .patch(`/api/chunked-upload/${initRes.body.uploadId}`)
        .set('Content-Range', 'bytes 0-4/10')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/chunked-upload/:uploadId/complete', () => {
    it('renames temp file to final path on success', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'result.txt', totalSize: 5, uploadTo: '', relativePath: '' });
      const { uploadId } = initRes.body;

      await request(app)
        .patch(`/api/chunked-upload/${uploadId}`)
        .set('Content-Range', 'bytes 0-4/5')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      const completeRes = await request(app)
        .post(`/api/chunked-upload/${uploadId}/complete`)
        .send();

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.name).toBe('result.txt');
      expect(completeRes.body.size).toBe(5);

      // Temp file should be gone, final file should exist
      const files = await fs.readdir(envContext.volumeDir);
      expect(files.find((f) => f.includes('.chunked-'))).toBeUndefined();
      expect(files).toContain('result.txt');

      const content = await fs.readFile(path.join(envContext.volumeDir, 'result.txt'), 'utf8');
      expect(content).toBe('Hello');
    });

    it('rejects completion when file size does not match', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'result.txt', totalSize: 10, uploadTo: '', relativePath: '' });
      const { uploadId } = initRes.body;

      // Only upload 5 of 10 bytes
      await request(app)
        .patch(`/api/chunked-upload/${uploadId}`)
        .set('Content-Range', 'bytes 0-4/10')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('Hello'));

      const res = await request(app)
        .post(`/api/chunked-upload/${uploadId}/complete`)
        .send();

      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown uploadId', async () => {
      const app = buildApp({ user: adminUser });
      const res = await request(app)
        .post('/api/chunked-upload/nonexistent/complete')
        .send();

      expect(res.status).toBe(404);
    });

    it('handles filename conflict by finding available name', async () => {
      const app = buildApp({ user: adminUser });

      // Create a file that conflicts
      await fs.writeFile(path.join(envContext.volumeDir, 'conflict.txt'), 'existing');

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'conflict.txt', totalSize: 3, uploadTo: '', relativePath: '' });
      const { uploadId } = initRes.body;

      await request(app)
        .patch(`/api/chunked-upload/${uploadId}`)
        .set('Content-Range', 'bytes 0-2/3')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('new'));

      const completeRes = await request(app)
        .post(`/api/chunked-upload/${uploadId}/complete`)
        .send();

      expect(completeRes.status).toBe(200);
      // The name should be different from 'conflict.txt'
      expect(completeRes.body.name).not.toBe('conflict.txt');
      // But the original file should still exist
      const original = await fs.readFile(path.join(envContext.volumeDir, 'conflict.txt'), 'utf8');
      expect(original).toBe('existing');
    });
  });

  describe('DELETE /api/chunked-upload/:uploadId', () => {
    it('removes the temp file and returns cancelled: true', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'cancel-me.bin', totalSize: 100, uploadTo: '', relativePath: '' });
      const { uploadId } = initRes.body;

      const delRes = await request(app)
        .delete(`/api/chunked-upload/${uploadId}`);

      expect(delRes.status).toBe(200);
      expect(delRes.body.cancelled).toBe(true);

      // Temp file should be gone
      const files = await fs.readdir(envContext.volumeDir);
      expect(files.find((f) => f.includes('.chunked-'))).toBeUndefined();
    });

    it('returns cancelled: false for unknown uploadId', async () => {
      const app = buildApp({ user: adminUser });
      const res = await request(app)
        .delete('/api/chunked-upload/nonexistent');

      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(false);
    });

    it('rejects cancel from a different user', async () => {
      const app = buildApp({ user: adminUser });

      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'test.bin', totalSize: 100, uploadTo: '', relativePath: '' });

      const app2 = buildApp({ user: otherUser });
      const res = await request(app2)
        .delete(`/api/chunked-upload/${initRes.body.uploadId}`);

      expect(res.status).toBe(403);
    });
  });

  describe('full upload flow', () => {
    it('successfully uploads a multi-chunk file', async () => {
      const app = buildApp({ user: adminUser });
      const content = 'A'.repeat(100);
      const totalSize = content.length;
      const chunkSize = 30;

      // Init
      const initRes = await request(app)
        .post('/api/chunked-upload/init')
        .send({ filename: 'big.txt', totalSize, uploadTo: '', relativePath: '' });
      expect(initRes.status).toBe(200);
      const { uploadId } = initRes.body;

      // Upload in chunks
      for (let start = 0; start < totalSize; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, totalSize - 1);
        const chunk = Buffer.from(content.slice(start, end + 1));
        const patchRes = await request(app)
          .patch(`/api/chunked-upload/${uploadId}`)
          .set('Content-Range', `bytes ${start}-${end}/${totalSize}`)
          .set('Content-Type', 'application/octet-stream')
          .send(chunk);
        expect(patchRes.status).toBe(200);
      }

      // Complete
      const completeRes = await request(app)
        .post(`/api/chunked-upload/${uploadId}/complete`)
        .send();
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.name).toBe('big.txt');
      expect(completeRes.body.size).toBe(totalSize);

      // Verify final file
      const finalContent = await fs.readFile(path.join(envContext.volumeDir, 'big.txt'), 'utf8');
      expect(finalContent).toBe(content);
    });
  });
});

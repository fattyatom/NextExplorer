import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

/**
 * The cap on zip downloads (MAX_DOWNLOAD_ZIP_SIZE, default 20G): a folder or
 * multi-file download whose files add up to more than the cap is refused with
 * 413 before anything is zipped. Single-file downloads are not zipped and are
 * not capped. The cap here is 100 bytes so the fixtures stay tiny.
 */

let envContext;
const testUser = { id: 'user-1', roles: ['user'] };
const MODULES = [
  'src/config/env',
  'src/config/index',
  'src/services/zipDownloadLimit',
  'src/routes/files/download',
  'src/services/accessManager',
  'src/services/preparedDownloads',
  'src/middleware/errorHandler',
];

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'zip-limit-test-',
    env: { MAX_DOWNLOAD_ZIP_SIZE: '100' },
    modules: MODULES,
  });
  const v = envContext.volumeDir;
  await fs.mkdir(path.join(v, 'small'), { recursive: true });
  await fs.writeFile(path.join(v, 'small', 'a.txt'), 'x'.repeat(40));
  await fs.writeFile(path.join(v, 'small', 'b.txt'), 'x'.repeat(40));
  await fs.mkdir(path.join(v, 'big', 'nested', 'deeper'), { recursive: true });
  await fs.writeFile(path.join(v, 'big', 'one.txt'), 'x'.repeat(60));
  await fs.writeFile(path.join(v, 'big', 'nested', 'deeper', 'two.txt'), 'x'.repeat(60));
  await fs.writeFile(path.join(v, 'huge.bin'), 'x'.repeat(500));
  await fs.writeFile(path.join(v, 'sixty-a.txt'), 'x'.repeat(60));
  await fs.writeFile(path.join(v, 'sixty-b.txt'), 'x'.repeat(60));
});

afterAll(async () => {
  await envContext.cleanup();
});

const buildApp = () => {
  for (const m of MODULES) clearModuleCache(m);
  const accessManager = envContext.requireFresh('src/services/accessManager');
  accessManager.resolvePathWithAccess = async (_context, relativePath) => ({
    accessInfo: { canAccess: true, canRead: true, canDownload: true },
    resolved: { absolutePath: path.join(envContext.volumeDir, relativePath), relativePath },
  });
  const downloadRoutes = envContext.requireFresh('src/routes/files/download');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = testUser;
    next();
  });
  app.use('/api', downloadRoutes);
  app.use(errorHandler);
  return app;
};

describe('zip download size cap', () => {
  it('zips a folder under the cap', async () => {
    const res = await request(buildApp())
      .post('/api/download')
      .send({ items: ['small'] });
    expect(res.status).toBe(202);
  });

  it('refuses a folder over the cap, counting nested files, with a readable message', async () => {
    const res = await request(buildApp())
      .post('/api/download')
      .send({ items: ['big'] });
    expect(res.status).toBe(413);
    expect(res.body.error.message).toMatch(/larger than the 100 B limit for zip downloads/);
    expect(res.body.downloadId).toBeUndefined();
  });

  it('adds up several selected files', async () => {
    const res = await request(buildApp())
      .post('/api/download')
      .send({ items: ['sixty-a.txt', 'sixty-b.txt'] });
    expect(res.status).toBe(413);
  });

  it('writes no temp zip when it refuses', async () => {
    const os = await import('node:os');
    const before = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('nextexplorer-dl-'));
    await request(buildApp())
      .post('/api/download')
      .send({ items: ['big'] });
    const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('nextexplorer-dl-'));
    expect(after.length).toBe(before.length);
  });

  it('does not cap a single file, which is streamed, not zipped', async () => {
    const res = await request(buildApp())
      .post('/api/download')
      .send({ items: ['huge.bin'] });
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(500);
  });
});

describe('measureZipInput', () => {
  it('stops at the cap and reports exceeded, or the full total when under it', async () => {
    const { measureZipInput } = envContext.requireFresh('src/services/zipDownloadLimit');
    const v = envContext.volumeDir;
    expect(await measureZipInput([path.join(v, 'small')], 100)).toEqual({
      totalBytes: 80,
      exceeded: false,
    });
    const over = await measureZipInput([path.join(v, 'big')], 100);
    expect(over.exceeded).toBe(true);
    expect(await measureZipInput([path.join(v, 'big')], 0)).toEqual({
      totalBytes: 120,
      exceeded: false,
    });
  });

  it('skips symlinks, which archiver stores as links, not their target', async () => {
    const { measureZipInput } = envContext.requireFresh('src/services/zipDownloadLimit');
    const v = envContext.volumeDir;
    await fs.mkdir(path.join(v, 'links'), { recursive: true });
    await fs.symlink(path.join(v, 'huge.bin'), path.join(v, 'links', 'huge-link'));
    expect(await measureZipInput([path.join(v, 'links')], 100)).toEqual({
      totalBytes: 0,
      exceeded: false,
    });
  });
});

describe('config', () => {
  it('defaults to 20G and treats "0" as no cap', async () => {
    const { archives } = envContext.requireFresh('src/config/index');
    expect(archives.maxDownloadZipBytes).toBe(100);
    const prev = process.env.MAX_DOWNLOAD_ZIP_SIZE;
    try {
      delete process.env.MAX_DOWNLOAD_ZIP_SIZE;
      clearModuleCache('src/config/env');
      expect(envContext.requireFresh('src/config/index').archives.maxDownloadZipBytes).toBe(
        20 * 1024 ** 3
      );
      process.env.MAX_DOWNLOAD_ZIP_SIZE = '0';
      clearModuleCache('src/config/env');
      expect(envContext.requireFresh('src/config/index').archives.maxDownloadZipBytes).toBe(0);
    } finally {
      process.env.MAX_DOWNLOAD_ZIP_SIZE = prev;
      clearModuleCache('src/config/env');
      clearModuleCache('src/config/index');
    }
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A zip made out of sight and fetched once it exists.
 *
 * `POST /api/download` builds the archive inside its own response, and behind a
 * proxy with a deadline on the first byte a large folder never arrives. The
 * prepared path answers at once and builds to a temp file, so what matters here
 * is that nothing is held across the build, that the finished file can be taken
 * in ranges, that it belongs to whoever asked, and that a selection past the
 * ceiling is refused before anything is written.
 */

let envContext;

const seed = async (env = {}) => {
  envContext = await setupTestEnv({
    tag: 'download-prepared-',
    env,
    modules: [
      'src/routes/files/download',
      'src/routes/shares',
      'src/services/sharesService',
      'src/services/downloadPlans',
      'src/services/preparedDownloads',
      'src/services/zipDownloadLimit',
      'src/middleware/errorHandler',
      'src/services/accessManager',
    ],
  });
  const { getDb } = envContext.requireFresh('src/services/db');
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES ('u1', 'u1@example.com', 1, 'u1', 'U1', '["admin"]', ?, ?)`
  ).run(now, now);

  const folder = path.join(envContext.volumeDir, 'Partage');
  await fs.mkdir(path.join(folder, 'Photos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'rapport.txt'), 'le rapport');
  await fs.writeFile(path.join(folder, 'notes.txt'), 'les notes');
  await fs.writeFile(path.join(folder, 'Photos', 'vue.jpg'), 'x'.repeat(4096));

  const shares = envContext.requireFresh('src/services/sharesService');
  const share = await shares.createShare({
    ownerId: 'u1',
    sourceSpace: 'volume',
    sourcePath: 'Partage',
    isDirectory: true,
    accessMode: 'readonly',
    sharingType: 'anyone',
  });
  return { share, db };
};

/** A visitor of the public link, with the guest session a typed password buys. */
const asVisitor = (share, sessionId = 'guest-1') => {
  const downloadRoutes = envContext.requireFresh('src/routes/files/download');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.guestSession = { id: sessionId, shareId: share.id };
    next();
  });
  app.use('/api', downloadRoutes);
  app.use(errorHandler);
  return app;
};

const counters = (db, shareId) =>
  db.prepare('SELECT download_count FROM shares WHERE id = ?').get(shareId);

const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const prepare = (app, share, names = ['Photos', 'notes.txt']) => {
  const root = `share/${share.shareToken}`;
  return request(app)
    .post('/api/download/prepare')
    .send({ paths: names.map((name) => `${root}/${name}`), basePath: root });
};

const ready = (app, id) => request(app).get(`/api/download/prepared/${id}?wait=1`);

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
  // The store these builds were registered in went away with the modules.
  const names = await fs.readdir(os.tmpdir());
  await Promise.all(
    names
      .filter((name) => name.startsWith('nextexplorer-dl-'))
      .map((name) => fs.rm(path.join(os.tmpdir(), name), { force: true }))
  );
});

describe('a zip prepared out of sight', () => {
  it('answers with an id at once and serves the zip once it is built', async () => {
    const { share } = await seed();
    const app = asVisitor(share);

    const asked = await prepare(app, share);
    expect(asked.status).toBe(202);
    expect(asked.body.id).toEqual(expect.any(String));
    expect(asked.body.name).toMatch(/\.zip$/);

    const zip = await ready(app, asked.body.id).buffer(true).parse(binary);
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toContain('zip');
    expect(zip.headers['accept-ranges']).toBe('bytes');
    expect(zip.headers['content-disposition']).toContain(asked.body.name);
    expect(Number(zip.headers['content-length'])).toBe(zip.body.length);
    // A zip opens with its local file header.
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
  });

  it('hands the same bytes over in ranges', async () => {
    const { share } = await seed();
    const app = asVisitor(share);
    const { body } = await prepare(app, share);

    const whole = await ready(app, body.id).buffer(true).parse(binary);
    const size = whole.body.length;
    const middle = Math.floor(size / 2);

    const first = await request(app)
      .get(`/api/download/prepared/${body.id}`)
      .set('Range', `bytes=0-${middle - 1}`)
      .buffer(true)
      .parse(binary);
    const second = await request(app)
      .get(`/api/download/prepared/${body.id}`)
      .set('Range', `bytes=${middle}-`)
      .buffer(true)
      .parse(binary);

    expect(first.status).toBe(206);
    expect(first.headers['content-range']).toBe(`bytes 0-${middle - 1}/${size}`);
    expect(second.status).toBe(206);
    expect(Buffer.concat([first.body, second.body]).equals(whole.body)).toBe(true);

    const beyond = await request(app)
      .get(`/api/download/prepared/${body.id}`)
      .set('Range', `bytes=${size + 10}-${size + 20}`);
    expect(beyond.status).toBe(416);
  });

  it('answers a HEAD with the length and no body', async () => {
    const { share } = await seed();
    const app = asVisitor(share);
    const { body } = await prepare(app, share);
    const whole = await ready(app, body.id).buffer(true).parse(binary);

    const head = await request(app).head(`/api/download/prepared/${body.id}`);
    expect(head.status).toBe(200);
    expect(Number(head.headers['content-length'])).toBe(whole.body.length);
  });

  it('counts one download however many ranges are fetched', async () => {
    const { share, db } = await seed();
    const app = asVisitor(share);
    const { body } = await prepare(app, share);

    await ready(app, body.id);
    await request(app).get(`/api/download/prepared/${body.id}`).set('Range', 'bytes=0-9');
    await request(app).get(`/api/download/prepared/${body.id}`).set('Range', 'bytes=10-19');

    expect(counters(db, share.id).download_count).toBe(1);
  });

  it('is absent to anybody but the one who asked', async () => {
    const { share } = await seed();
    const { body } = await prepare(asVisitor(share, 'guest-1'), share);
    await ready(asVisitor(share, 'guest-1'), body.id);

    const stranger = asVisitor(share, 'guest-2');
    expect((await request(stranger).get(`/api/download/prepared/${body.id}`)).status).toBe(404);

    // Nor can they remove it: the owner still has it afterwards.
    expect((await request(stranger).delete(`/api/download/prepared/${body.id}`)).status).toBe(204);
    const owner = await request(asVisitor(share, 'guest-1')).head(
      `/api/download/prepared/${body.id}`
    );
    expect(owner.status).toBe(200);
  });

  it('is gone, file and all, once its owner gives it up', async () => {
    const { share } = await seed();
    const app = asVisitor(share);
    const { body } = await prepare(app, share);
    await ready(app, body.id);

    const tempPath = path.join(os.tmpdir(), `nextexplorer-dl-${body.id}.zip`);
    await expect(fs.stat(tempPath)).resolves.toBeTruthy();

    expect((await request(app).delete(`/api/download/prepared/${body.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/download/prepared/${body.id}`)).status).toBe(404);
    await expect
      .poll(() =>
        fs.stat(tempPath).then(
          () => true,
          () => false
        )
      )
      .toBe(false);
  });

  it('refuses a single file, which downloads as itself', async () => {
    const { share } = await seed();
    const asked = await prepare(asVisitor(share), share, ['rapport.txt']);
    expect(asked.status).toBe(400);
  });

  it('refuses what the share does not allow, before anything is prepared', async () => {
    const { share } = await seed();
    const asked = await request(asVisitor(share))
      .post('/api/download/prepare')
      .send({ paths: ['Partage/Photos', 'Partage/notes.txt'] });
    expect(asked.status).toBe(403);
  });
});

describe('the folders of a selection taken as separate files', () => {
  it('are prepared from the plan, and counted by the plan alone', async () => {
    const { share, db } = await seed();
    const app = asVisitor(share);
    const root = `share/${share.shareToken}`;

    const plan = await request(app)
      .post('/api/download/plan')
      .send({ paths: [`${root}/Photos`, `${root}/notes.txt`], basePath: root });
    expect(plan.status).toBe(200);
    expect(counters(db, share.id).download_count).toBe(1);

    const asked = await request(app).post('/api/download/prepare').send({ plan: plan.body.token });
    expect(asked.status).toBe(202);
    expect(asked.body.name).toBe(plan.body.archive.name);

    const zip = await ready(app, asked.body.id).buffer(true).parse(binary);
    expect(zip.status).toBe(200);
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
    expect(counters(db, share.id).download_count).toBe(1);
  });

  it("are nobody else's to prepare, and nothing without folders", async () => {
    const { share } = await seed();
    const root = `share/${share.shareToken}`;
    const app = asVisitor(share);

    const withFolder = await request(app)
      .post('/api/download/plan')
      .send({ paths: [`${root}/Photos`, `${root}/notes.txt`], basePath: root });
    const stranger = await request(asVisitor(share, 'guest-2'))
      .post('/api/download/prepare')
      .send({ plan: withFolder.body.token });
    expect(stranger.status).toBe(404);

    const filesOnly = await request(app)
      .post('/api/download/plan')
      .send({ paths: [`${root}/rapport.txt`, `${root}/notes.txt`], basePath: root });
    const nothing = await request(app)
      .post('/api/download/prepare')
      .send({ plan: filesOnly.body.token });
    expect(nothing.status).toBe(404);
  });
});

describe('the ceiling on a zip download', () => {
  it('tells whoever asks for a prepared zip past it, and writes nothing', async () => {
    const { share, db } = await seed({ MAX_DOWNLOAD_ZIP_SIZE: '1K' });
    const app = asVisitor(share);

    const asked = await prepare(app, share);
    expect(asked.status).toBe(202);

    const answer = await ready(app, asked.body.id);
    expect(answer.status).toBe(413);
    expect(JSON.stringify(answer.body)).toContain('ZIP_TOO_LARGE');
    // A download that was refused is not a download.
    expect(counters(db, share.id).download_count).toBe(0);
  });

  it('refuses the streamed zip with an ordinary error rather than half an archive', async () => {
    const { share } = await seed({ MAX_DOWNLOAD_ZIP_SIZE: '1K' });
    const root = `share/${share.shareToken}`;

    const streamed = await request(asVisitor(share))
      .post('/api/download')
      .send({ paths: [`${root}/Photos`], basePath: root });
    expect(streamed.status).toBe(413);
    expect(streamed.headers['content-type']).toContain('json');
  });

  it('lets through what fits, and everything when it is turned off', async () => {
    const { share } = await seed({ MAX_DOWNLOAD_ZIP_SIZE: '0' });
    const root = `share/${share.shareToken}`;

    const streamed = await request(asVisitor(share))
      .post('/api/download')
      .send({ paths: [`${root}/Photos`], basePath: root });
    expect(streamed.status).toBe(200);
  });

  it('never applies to a single file', async () => {
    const { share } = await seed({ MAX_DOWNLOAD_ZIP_SIZE: '1K' });
    const root = `share/${share.shareToken}`;

    const file = await request(asVisitor(share))
      .post('/api/download')
      .send({ paths: [`${root}/Photos/vue.jpg`], basePath: root });
    expect(file.status).toBe(200);
  });

  it('defaults to 20G and reads a size with a suffix', async () => {
    await seed();
    expect(envContext.requireFresh('src/config/index').archives.maxDownloadZipBytes).toBe(
      20 * 1024 ** 3
    );
    await envContext.cleanup();
    await seed({ MAX_DOWNLOAD_ZIP_SIZE: '5G' });
    expect(envContext.requireFresh('src/config/index').archives.maxDownloadZipBytes).toBe(
      5 * 1024 ** 3
    );
  });
});

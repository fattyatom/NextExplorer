const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const logger = require('../utils/logger');

/**
 * Archives built out of sight, and fetched once they exist.
 *
 * A zip made as it is sent is one long response, and its first byte waits on
 * the walk of everything that goes into it. Behind a proxy with a deadline on
 * that first byte — Cloudflare answers 524 after a hundred seconds — a large
 * folder never arrives, however healthy the server is.
 *
 * So the archive is written to the temp directory with no request held open
 * across the build: the caller is handed an id at once, asks whether it is
 * ready, and then takes the finished file — whole, or in ranges, so that a
 * part that fails is asked for again rather than the transfer started over.
 *
 * An entry belongs to whoever asked for it and is absent to anybody else. It
 * lives in memory and in the temp directory, and is worth minutes: a restart
 * loses it, and what it left on disk is removed the next time one is made.
 */

/** How long an archive is kept after it was last touched. */
const IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** A bound on what an unattended process can accumulate. Oldest first out. */
const MAX_PREPARED = 50;

const FILE_PREFIX = 'nextexplorer-dl-';

const entries = new Map();
let sweepTimer = null;
let leftoversCleared = false;

const tempPathFor = (id) => path.join(os.tmpdir(), `${FILE_PREFIX}${id}.zip`);

const discard = (id) => {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  // A build still running is stopped; it removes nothing itself.
  entry.controller.abort();
  entry.settle();
  fs.rm(entry.tempPath, { force: true }).catch(() => {});
};

const sweep = (now = Date.now()) => {
  for (const [id, entry] of entries) {
    // One being read is in use, however long ago the read began: a large zip
    // over a slow line is a long download and a perfectly ordinary one.
    if (entry.activeReads > 0) continue;
    if (now - entry.lastUsedAt > IDLE_MS) {
      logger.info({ downloadId: id }, 'Prepared download expired');
      discard(id);
    }
  }
  while (entries.size > MAX_PREPARED) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    discard(oldest.value);
  }
};

/**
 * What an earlier process left in the temp directory. Nothing in memory names
 * those files any more, so nothing would ever remove them.
 */
const clearLeftovers = async () => {
  if (leftoversCleared) return;
  leftoversCleared = true;
  try {
    const names = await fs.readdir(os.tmpdir());
    await Promise.all(
      names
        .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith('.zip'))
        .filter((name) => !entries.has(name.slice(FILE_PREFIX.length, -'.zip'.length)))
        .map((name) => fs.rm(path.join(os.tmpdir(), name), { force: true }).catch(() => {}))
    );
  } catch (error) {
    logger.debug({ err: error }, 'Could not look for leftover prepared downloads');
  }
};

/** Register an archive about to be built. The caller does the building. */
const createPrepared = ({ ownerKey, name }) => {
  if (!ownerKey) throw new Error('A prepared download needs an owner.');

  sweep();
  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }
  clearLeftovers();

  const id = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  let settle;
  const settled = new Promise((resolve) => {
    settle = resolve;
  });

  const entry = {
    id,
    ownerKey,
    name,
    tempPath: tempPathFor(id),
    state: 'building',
    percent: 0,
    size: null,
    error: null,
    activeReads: 0,
    controller: new AbortController(),
    settled,
    settle,
    createdAt: now,
    lastUsedAt: now,
  };
  entries.set(id, entry);
  return entry;
};

/** The entry behind an id, for this requester, or null. Reading it keeps it. */
const readPrepared = (id, ownerKey) => {
  if (!id || !ownerKey) return null;
  const entry = entries.get(id);
  if (!entry || entry.ownerKey !== ownerKey) return null;

  const now = Date.now();
  if (entry.activeReads === 0 && now - entry.lastUsedAt > IDLE_MS) {
    discard(id);
    return null;
  }
  entry.lastUsedAt = now;
  return entry;
};

/**
 * Say that the archive is being read, and get back the way to say it no longer
 * is. An archive is never expired from under somebody still taking it.
 */
const holdForRead = (entry) => {
  entry.activeReads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.activeReads -= 1;
    entry.lastUsedAt = Date.now();
  };
};

const markReady = (entry, size) => {
  if (entries.get(entry.id) !== entry) return;
  entry.state = 'ready';
  entry.percent = 100;
  entry.size = size;
  entry.lastUsedAt = Date.now();
  entry.settle();
};

/**
 * A build that ended without an archive. The reason is kept so the caller who
 * asks next is told it — a refusal for size reads as that refusal, not as a
 * download that vanished.
 */
const markFailed = (entry, error) => {
  fs.rm(entry.tempPath, { force: true }).catch(() => {});
  if (entries.get(entry.id) !== entry) return;
  entry.state = 'failed';
  entry.error = {
    message: error?.isOperational ? error.message : 'Failed to create archive.',
    statusCode: error?.isOperational ? error.statusCode : 500,
    code: error?.isOperational ? error.code : null,
  };
  entry.lastUsedAt = Date.now();
  entry.settle();
};

/** Wait for a build to end, for at most `ms`. Resolves either way. */
const waitUntilSettled = (entry, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    entry.settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

const removePrepared = (id) => discard(id);

/** Tests reach for this; nothing in the application does. */
const resetPrepared = () => {
  for (const id of [...entries.keys()]) discard(id);
};

module.exports = {
  createPrepared,
  readPrepared,
  holdForRead,
  markReady,
  markFailed,
  waitUntilSettled,
  removePrepared,
  resetPrepared,
  IDLE_MS,
  MAX_PREPARED,
};

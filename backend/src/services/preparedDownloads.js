const fs = require('fs/promises');
const logger = require('../utils/logger');

const store = new Map();

const TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, dl] of store) {
    if (now - dl.createdAt > TTL_MS) {
      fs.rm(dl.tempPath, { force: true }).catch(() => {});
      store.delete(id);
      logger.info({ downloadId: id }, 'Cleaned up expired prepared download');
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

function get(downloadId) {
  return store.get(downloadId) || null;
}

function set(downloadId, data) {
  store.set(downloadId, { ...data, createdAt: Date.now() });
}

function remove(downloadId) {
  const dl = store.get(downloadId);
  if (dl) {
    fs.rm(dl.tempPath, { force: true }).catch(() => {});
    store.delete(downloadId);
  }
}

module.exports = { get, set, remove };

// /api/folderSize.api.js

import { encodePath, normalizePath, requestJson } from './http';

// POST /api/folder-size/batch — one index lookup per path, so a list view is
// populated in a single round trip instead of N.
async function getFolderSizesBatch(paths = [], options = {}) {
  return requestJson('/api/folder-size/batch', {
    ...options,
    method: 'POST',
    body: JSON.stringify({ paths }),
  });
}

// GET /api/folder-size/<path> — the indexed recursive size of one folder.
// Answers indexed:false rather than an error when the path is not indexed yet.
async function getFolderSize(path = '', options = {}) {
  const encodedPath = encodePath(normalizePath(path));
  return requestJson(`/api/folder-size/${encodedPath}`, { ...options, method: 'GET' });
}

// POST /api/folder-size/refresh/<path> — authoritative rescan of one subtree,
// for a folder changed outside NextExplorer. Answers 202 with refreshPending.
async function refreshFolderSize(path = '', options = {}) {
  const encodedPath = encodePath(normalizePath(path));
  return requestJson(`/api/folder-size/refresh/${encodedPath}`, { ...options, method: 'POST' });
}

export { getFolderSize, getFolderSizesBatch, refreshFolderSize };

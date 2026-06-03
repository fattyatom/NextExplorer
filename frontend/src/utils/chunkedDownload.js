import { buildUrl, normalizePath } from '@/api/http';
import { getCommonHeaders, checkAborted } from './chunkedTransfer';

const supportsFileSystemAccess =
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildRangeDownloadUrl(filePath, downloadId) {
  if (downloadId) {
    return buildUrl(`/api/range-download?downloadId=${encodeURIComponent(downloadId)}`);
  }
  const normalized = normalizePath(filePath);
  const params = new URLSearchParams({ path: normalized });
  return buildUrl(`/api/range-download?${params.toString()}`);
}

function parseFilenameFromHeaders(headers) {
  const disposition = headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Stream a fetch Response body directly to a file on disk using the
 * File System Access API.  Works for any size because nothing is held
 * in memory — chunks are written to the writable stream as they arrive.
 */
async function streamResponseToDisk(response, filename, onProgress, signal) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    startIn: 'downloads',
  });
  const writable = await handle.createWritable();

  const totalStr = response.headers.get('content-length');
  const total = totalStr && Number(totalStr) > 0 ? Number(totalStr) : 0;

  try {
    const reader = response.body.getReader();
    let received = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      checkAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      onProgress?.(received, total > 0 ? total : received);
    }
  } finally {
    await writable.close();
  }
}

/**
 * Read a fetch Response body into an in-memory Blob.
 * Only suitable for small/medium responses.
 */
async function streamResponseToBlob(response, onProgress, signal, fallbackTotal = 0) {
  const totalStr = response.headers.get('content-length');
  const total = (totalStr && Number(totalStr) > 0) ? Number(totalStr) : fallbackTotal;

  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(blob.size, blob.size);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    checkAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received, total > 0 ? total : received);
  }

  return new Blob(chunks);
}

function triggerBlobDownload(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

/**
 * Trigger a native browser download via the range-download endpoint.
 * The browser's download manager streams the file to disk — zero JS memory.
 * No progress tracking, but works for any size on any browser.
 */
function triggerNativeDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---------------------------------------------------------------------------
// Resume helpers — used when the client disconnects mid-stream and a
// server-side temp file exists (identified by downloadId).
// ---------------------------------------------------------------------------

const RESUME_POLL_INTERVAL_MS = 3000;
const RESUME_MAX_ATTEMPTS = 200; // ~10 minutes to build large archives

async function fetchFileSize(url, signal) {
  const res = await fetch(url, {
    method: 'HEAD',
    credentials: 'include',
    headers: getCommonHeaders(),
    signal,
  });
  if (!res.ok) {
    throw new Error(`HEAD request failed: ${res.status} ${res.statusText}`);
  }
  const size = Number(res.headers.get('content-length'));
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Server did not return a valid Content-Length');
  }
  return size;
}

async function resumeWithRangeDownload(downloadId, filename, onProgress, signal) {
  const url = buildRangeDownloadUrl(null, downloadId);

  // Poll until the server has finished building the temp file
  let fileSize;
  for (let attempt = 0; attempt < RESUME_MAX_ATTEMPTS; attempt++) {
    checkAborted(signal);
    try {
      fileSize = await fetchFileSize(url, signal);
      break;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const isNotReady =
        err.message?.includes('404') || err.message?.includes('still being prepared');
      if (!isNotReady || attempt === RESUME_MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, RESUME_POLL_INTERVAL_MS));
    }
  }

  // Prefer FSAA — stream the completed file to disk
  if (supportsFileSystemAccess) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: getCommonHeaders(),
        signal,
      });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      await streamResponseToDisk(res, filename, onProgress, signal);
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // SecurityError / NotAllowedError → gesture expired; fall through
      if (err.name !== 'SecurityError' && err.name !== 'NotAllowedError') throw err;
    }
  }

  // Native browser download — zero memory, any browser.
  // The browser's own download manager shows progress.
  triggerNativeDownload(url, filename);
  onProgress?.(fileSize, fileSize);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Download a single file.
 *
 * Strategy:
 *  1. FSAA — stream response body directly to disk (any size, Chromium).
 *  2. In-memory Blob — for small files or non-FSAA browsers.
 *
 * @param {Object} opts
 * @param {string}   opts.path       - File path
 * @param {string}   opts.filename   - Suggested filename
 * @param {number}  [opts.size]      - Known file size (used for progress)
 * @param {Function}[opts.onProgress]- (downloaded, total) callback
 * @param {AbortSignal}[opts.signal] - Cancellation signal
 */
export async function download({ path: filePath, filename, size, onProgress, signal }) {
  checkAborted(signal);

  const url = buildRangeDownloadUrl(filePath);
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: getCommonHeaders(),
    signal,
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const resolvedName = parseFilenameFromHeaders(res.headers) || filename;

  // Prefer FSAA for zero-memory streaming to disk
  if (supportsFileSystemAccess) {
    try {
      await streamResponseToDisk(res, resolvedName, onProgress, signal);
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // SecurityError / NotAllowedError → gesture expired; fall through to blob
      if (err.name !== 'SecurityError' && err.name !== 'NotAllowedError') throw err;
    }
  }

  // Fallback: in-memory blob (fine for single files on non-FSAA browsers)
  const blob = await streamResponseToBlob(res, onProgress, signal, size || 0);
  triggerBlobDownload(blob, resolvedName);
}

/**
 * Download multiple files / directories as a streaming zip.
 *
 * The server creates the zip and streams bytes as they're produced.
 * Headers are flushed immediately so reverse proxies don't timeout.
 * A temp file is kept server-side so the download can be resumed via
 * range-download if the stream is interrupted.
 *
 * Strategy (in order of preference):
 *  1. FSAA — stream zip bytes directly to disk as they arrive (any size).
 *  2. Resume via range-download — abort the stream, let the server finish the
 *     temp file, then download via a native GET (zero memory, any browser).
 *
 * @param {Object} opts
 * @param {string[]} opts.paths       - File/directory paths to include
 * @param {string}   opts.basePath    - Common base path for entry names
 * @param {string}   opts.filename    - Suggested zip filename
 * @param {Function}[opts.onProgress] - (downloaded, total) callback
 * @param {AbortSignal}[opts.signal]  - Cancellation signal
 * @param {boolean} [opts.chunkedEnabled] - false disables resume fallback
 */
export async function streamZipDownload({
  paths,
  basePath,
  filename,
  onProgress,
  signal,
  chunkedEnabled,
}) {
  checkAborted(signal);

  const res = await fetch(buildUrl('/api/download'), {
    method: 'POST',
    credentials: 'include',
    headers: { ...getCommonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: paths, basePath }),
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Stream failed: ${res.status}`);
  }

  const downloadId = res.headers.get('X-Download-Id');
  const resolvedFilename = parseFilenameFromHeaders(res.headers) || filename;

  // --- Path 1: FSAA — stream directly to disk (any size) ---
  if (supportsFileSystemAccess) {
    try {
      await streamResponseToDisk(res, resolvedFilename, onProgress, signal);
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Any failure (gesture error or mid-stream) → try resume
      if (downloadId && chunkedEnabled !== false) {
        await resumeWithRangeDownload(downloadId, resolvedFilename, onProgress, signal);
        return;
      }
      throw err;
    }
  }

  // --- Path 2: No FSAA — abort stream, resume via range-download ---
  if (downloadId && chunkedEnabled !== false) {
    // Discard the response body so the connection closes cleanly.
    // The server detects the disconnect and continues writing to the temp file.
    res.body?.cancel().catch(() => {});
    await resumeWithRangeDownload(downloadId, resolvedFilename, onProgress, signal);
    return;
  }

  // Last resort (chunked disabled, no FSAA): in-memory blob
  const blob = await streamResponseToBlob(res, onProgress, signal);
  triggerBlobDownload(blob, resolvedFilename);
}

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
  // 202 = accepted but still building — caller should retry
  if (res.status === 202) {
    const err = new Error('still being prepared');
    err.retryable = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`HEAD request failed: ${res.status} ${res.statusText}`);
  }
  const size = Number(res.headers.get('content-length'));
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Server did not return a valid Content-Length');
  }
  return size;
}

async function cancelPreparedDownload(downloadId) {
  try {
    const url = buildRangeDownloadUrl(null, downloadId);
    await fetch(url, {
      method: 'DELETE',
      credentials: 'include',
      headers: getCommonHeaders(),
    });
  } catch {
    // Best-effort — server TTL will clean up regardless
  }
}

async function resumeWithRangeDownload(downloadId, filename, onProgress, signal) {
  const url = buildRangeDownloadUrl(null, downloadId);

  // If the caller aborts, cancel the server-side build + temp file
  const onAbort = () => cancelPreparedDownload(downloadId);
  signal?.addEventListener('abort', onAbort, { once: true });

  // Poll until the server has finished building the temp file
  let fileSize;
  try {
    for (let attempt = 0; attempt < RESUME_MAX_ATTEMPTS; attempt++) {
      checkAborted(signal);
      try {
        fileSize = await fetchFileSize(url, signal);
        break;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        const isNotReady = err.retryable || err.message?.includes('still being prepared');
        if (!isNotReady || attempt === RESUME_MAX_ATTEMPTS - 1) throw err;
        await new Promise((r) => setTimeout(r, RESUME_POLL_INTERVAL_MS));
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  // Use native browser download for prepared zips.
  // After the polling phase the user gesture has expired, so FSAA's
  // showSaveFilePicker() would fail anyway.  More importantly, fetch()-based
  // streaming through Cloudflare can still 524 on very large files.
  // The browser's own download manager handles large files reliably with
  // built-in retry/resume support and shows its own progress.
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
 * Download multiple files / directories as a zip.
 *
 * The server accepts the request, returns 202 { downloadId, filename }
 * immediately, and builds the zip to a temp file in the background.
 * The client polls GET /api/range-download?downloadId=… until the file
 * is ready, then downloads it.  This avoids all reverse-proxy streaming
 * timeouts (Cloudflare 524, nginx proxy_read_timeout, etc.).
 *
 * @param {Object} opts
 * @param {string[]} opts.paths       - File/directory paths to include
 * @param {string}   opts.basePath    - Common base path for entry names
 * @param {string}   opts.filename    - Suggested zip filename
 * @param {Function}[opts.onProgress] - (downloaded, total) callback
 * @param {Function}[opts.onStatus]   - (statusText) callback for UI status updates
 * @param {AbortSignal}[opts.signal]  - Cancellation signal
 */
export async function streamZipDownload({
  paths,
  basePath,
  filename,
  onProgress,
  onStatus,
  signal,
}) {
  checkAborted(signal);

  // 1. Ask the server to start building the zip (returns immediately)
  const res = await fetch(buildUrl('/api/download'), {
    method: 'POST',
    credentials: 'include',
    headers: { ...getCommonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: paths, basePath }),
    signal,
  });

  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Download request failed: ${res.status}`);
  }

  const body = await res.json();
  const downloadId = body.downloadId;
  const resolvedFilename = body.filename || filename;

  if (!downloadId) {
    throw new Error('Server did not return a downloadId');
  }

  // 2. Tell the UI we're preparing the archive
  onStatus?.('Preparing zip…');

  // 3. Poll until the zip is built, then download the completed file
  await resumeWithRangeDownload(downloadId, resolvedFilename, onProgress, signal);
}

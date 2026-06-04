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
// Prepared-download helpers — poll a server-side temp file (identified by a
// downloadId) until the background zip build finishes, then hand the completed
// file to the browser's native download manager.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 600; // ~10 minutes to build very large archives

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

async function waitForPreparedDownload(downloadId, signal) {
  const url = buildRangeDownloadUrl(null, downloadId);

  // If the caller aborts, cancel the server-side build + temp file
  const onAbort = () => cancelPreparedDownload(downloadId);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      checkAborted(signal);
      try {
        return await fetchFileSize(url, signal); // resolves once the zip is ready
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        const isNotReady = err.retryable || err.message?.includes('still being prepared');
        if (!isNotReady || attempt === POLL_MAX_ATTEMPTS - 1) throw err;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  throw new Error('Timed out waiting for the archive to build');
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
 * Flow (designed to survive reverse proxies like Cloudflare):
 *  1. POST /api/download → 202 { downloadId, filename }. The server starts
 *     building the zip to a temp file in the background and responds instantly,
 *     so there's no long-running request to time out (no 524).
 *  2. Poll HEAD /api/range-download?downloadId=… (202 while building, 200 when
 *     ready). Cancelling aborts the build and removes the temp file.
 *  3. Hand the finished file to the browser's native download manager. The
 *     browser owns the transfer from here — it streams a ready static file to
 *     disk with its own progress UI and resume support, which is the only
 *     reliable way to move multi-GB files through a CDN.
 *
 * Returns 'native-handoff' once the browser has taken over — the caller can't
 * track native progress, so it should show a terminal "download started" state
 * rather than a fake 100%.
 *
 * @param {Object} opts
 * @param {string[]} opts.paths       - File/directory paths to include
 * @param {string}   opts.basePath    - Common base path for entry names
 * @param {string}   opts.filename    - Suggested zip filename
 * @param {Function}[opts.onStatus]   - (statusText) callback for UI status updates
 * @param {AbortSignal}[opts.signal]  - Cancellation signal
 */
export async function streamZipDownload({ paths, basePath, filename, onStatus, signal }) {
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

  const { downloadId, filename: serverFilename } = await res.json();
  if (!downloadId) {
    throw new Error('Server did not return a downloadId');
  }

  // 2. Wait for the background build to finish (toast shows "Preparing zip…")
  onStatus?.('Preparing zip…');
  await waitForPreparedDownload(downloadId, signal);

  // 3. Hand the completed file to the browser's download manager
  triggerNativeDownload(buildRangeDownloadUrl(null, downloadId), serverFilename || filename);
  return 'native-handoff';
}

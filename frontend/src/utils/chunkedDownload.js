import { buildUrl, normalizePath } from '@/api/http';
import { getCommonHeaders, checkAborted } from './chunkedTransfer';

const supportsFileSystemAccess = () =>
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

/**
 * Append the guest-session token to a URL as a query param.
 *
 * Browser-initiated downloads (<a download>) can't send the X-Guest-Session
 * header, so shared-link / guest downloads must carry the session in the URL.
 */
function withGuestSession(url) {
  try {
    const guestSessionId =
      typeof sessionStorage !== 'undefined' && sessionStorage.getItem('guestSessionId');
    if (guestSessionId) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}guestSession=${encodeURIComponent(guestSessionId)}`;
    }
  } catch {
    /* sessionStorage unavailable — fall through */
  }
  return url;
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
// downloadId) until the background zip build finishes, then save it to disk.
// ---------------------------------------------------------------------------

// Each poll long-polls server-side (the server holds the request open until the
// build finishes, up to ~20s), so we only need a brief breather between requests
// and far fewer of them. This avoids per-request CDN latency dominating the wait.
const POLL_INTERVAL_MS = 250;
const POLL_MAX_ATTEMPTS = 90; // ~30 minutes worst case (server waits ~20s/attempt)

// Size of each ranged GET when streaming a prepared file to disk. Small enough
// that a CDN (Cloudflare) streams each chunk immediately instead of buffering
// the whole multi-GB response before forwarding the first byte.
const DOWNLOAD_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MB

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
  // wait=1 makes the server long-poll: it holds the request open until the
  // build finishes (or its bounded timeout), instead of returning 202 instantly.
  const url = `${buildRangeDownloadUrl(null, downloadId)}&wait=1`;

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

/**
 * Stream a ready prepared download to an open FileSystemWritableFileStream
 * using a sequence of ranged GETs. Each request transfers a bounded chunk, so a
 * CDN streams it immediately (no whole-file buffering) and we get real progress.
 * Nothing larger than one chunk is ever held in memory.
 */
async function downloadPreparedToDisk(downloadId, fileHandle, totalSize, onProgress, signal) {
  const url = buildRangeDownloadUrl(null, downloadId); // fetch carries auth via headers
  const writable = await fileHandle.createWritable();
  let received = 0;

  try {
    while (received < totalSize) {
      checkAborted(signal);
      const end = Math.min(received + DOWNLOAD_CHUNK_BYTES - 1, totalSize - 1);
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { ...getCommonHeaders(), Range: `bytes=${received}-${end}` },
        signal,
      });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`Download failed: ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) break;
      await writable.write(buf);
      received += buf.byteLength;
      onProgress?.(received, totalSize);
      // Server ignored the Range header and sent the whole file in one shot.
      if (res.status === 200) break;
    }
    await writable.close();
  } catch (err) {
    try {
      await writable.abort?.();
    } catch {
      /* ignore */
    }
    throw err;
  }
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
  if (supportsFileSystemAccess()) {
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
 *  0. If the File System Access API is available, ask for the save location
 *     up front — while the user's click gesture is still valid. (After the
 *     build/poll the gesture has expired, so this must happen first.)
 *  1. POST /api/download → 202 { downloadId, filename }. The server starts
 *     building the zip to a temp file in the background and responds instantly,
 *     so there's no long-running request to time out (no 524).
 *  2. Long-poll the readiness check until the build finishes.
 *  3a. With a save handle: stream the file to disk in bounded ranged GETs. Each
 *      chunk is small enough that a CDN forwards it immediately (no whole-file
 *      buffering, which was delaying the save dialog by minutes), and we report
 *      real progress. Returns undefined → caller marks the transfer complete.
 *  3b. Without FSAA (Firefox/Safari): hand off to the browser's native download
 *      manager via <a download>. Returns 'native-handoff'.
 *
 * @param {Object} opts
 * @param {string[]} opts.paths       - File/directory paths to include
 * @param {string}   opts.basePath    - Common base path for entry names
 * @param {string}   opts.filename    - Suggested zip filename
 * @param {Function}[opts.onProgress] - (downloaded, total) callback
 * @param {Function}[opts.onStatus]   - (statusText) callback for UI status updates
 * @param {AbortSignal}[opts.signal]  - Cancellation signal
 */
export async function streamZipDownload({ paths, basePath, filename, onProgress, onStatus, signal }) {
  checkAborted(signal);

  // 0. Grab the save handle NOW, before any await, so the click gesture is
  //    still valid. showSaveFilePicker must run synchronously from the gesture.
  let fileHandle = null;
  if (supportsFileSystemAccess()) {
    try {
      fileHandle = await window.showSaveFilePicker({ suggestedName: filename, startIn: 'downloads' });
    } catch (err) {
      // User dismissed the picker → cancel the whole download.
      if (err?.name === 'AbortError') throw new DOMException('Transfer cancelled', 'AbortError');
      // SecurityError / NotAllowedError / unsupported → fall back to native <a>.
      fileHandle = null;
    }
  }

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
  const fileSize = await waitForPreparedDownload(downloadId, signal);

  // 3a. Stream to the chosen file in bounded chunks (real progress, CDN-safe).
  if (fileHandle) {
    onStatus?.('Downloading…');
    await downloadPreparedToDisk(downloadId, fileHandle, fileSize, onProgress, signal);
    // Temp file has served its purpose — free it now instead of waiting for TTL.
    cancelPreparedDownload(downloadId);
    return; // real completion
  }

  // 3b. No FSAA — hand off to the browser's native download manager.
  //     The <a download> GET can't send the X-Guest-Session header, so carry
  //     the guest session in the URL for shared-link downloads.
  triggerNativeDownload(
    withGuestSession(buildRangeDownloadUrl(null, downloadId)),
    serverFilename || filename
  );
  return 'native-handoff';
}

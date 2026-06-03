import { buildUrl, normalizePath } from '@/api/http';
import {
  CHUNK_SIZE,
  CHUNKED_TRANSFER_THRESHOLD,
  iterateChunks,
  withRetry,
  getCommonHeaders,
  checkAborted,
} from './chunkedTransfer';

const supportsFileSystemAccess =
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

function buildDownloadUrl(filePath, downloadId) {
  if (downloadId) {
    return buildUrl(`/api/range-download?downloadId=${encodeURIComponent(downloadId)}`);
  }
  const normalized = normalizePath(filePath);
  const params = new URLSearchParams({ path: normalized });
  return buildUrl(`/api/range-download?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Internals shared by streamed and chunked paths
// ---------------------------------------------------------------------------

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

async function fetchChunk(url, start, end, signal) {
  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { ...getCommonHeaders(), Range: `bytes=${start}-${end}` },
      signal,
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`Chunk fetch failed: ${res.status}`);
    }
    return res.arrayBuffer();
  });
}

function parseFilenameFromHeaders(headers) {
  const disposition = headers.get('content-disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

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

// ---------------------------------------------------------------------------
// Chunked download (Range requests, for files > CHUNKED_TRANSFER_THRESHOLD)
// ---------------------------------------------------------------------------

async function downloadWithFileSystemAccess(url, filename, fileSize, onProgress, signal, chunkSize) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    startIn: 'downloads',
  });
  const writable = await handle.createWritable();
  let downloaded = 0;

  try {
    for (const { start, end } of iterateChunks(fileSize, chunkSize)) {
      checkAborted(signal);
      const chunk = await fetchChunk(url, start, end, signal);
      await writable.write(new Uint8Array(chunk));
      downloaded += chunk.byteLength;
      onProgress?.(downloaded, fileSize);
    }
  } finally {
    await writable.close();
  }
}

async function downloadWithBlobFallback(url, filename, fileSize, onProgress, signal, chunkSize) {
  const chunks = [];
  let downloaded = 0;

  for (const { start, end } of iterateChunks(fileSize, chunkSize)) {
    checkAborted(signal);
    const chunk = await fetchChunk(url, start, end, signal);
    chunks.push(chunk);
    downloaded += chunk.byteLength;
    onProgress?.(downloaded, fileSize);
  }

  const blob = new Blob(chunks);
  triggerBlobDownload(blob, filename);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stream a multi-file/directory zip download.
 * The server creates the zip and streams bytes as they're produced, avoiding
 * Cloudflare 524 timeouts. A temp file is kept server-side so the download
 * can be resumed via chunked range-download if the stream is interrupted.
 */
export async function streamZipDownload({
  paths,
  basePath,
  filename,
  onProgress,
  signal,
  chunkSize,
  chunkedEnabled,
}) {
  checkAborted(signal);

  const res = await fetch(buildUrl('/api/download/zip-stream'), {
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

  try {
    const blob = await streamResponseToBlob(res, onProgress, signal);
    triggerBlobDownload(blob, resolvedFilename);
  } catch (err) {
    if (err.name === 'AbortError') throw err;

    if (downloadId && chunkedEnabled !== false) {
      await resumeWithChunkedDownload(downloadId, resolvedFilename, onProgress, signal, chunkSize);
      return;
    }
    throw err;
  }
}

const RESUME_POLL_INTERVAL_MS = 3000;
const RESUME_MAX_ATTEMPTS = 40;

async function resumeWithChunkedDownload(downloadId, filename, onProgress, signal, chunkSize) {
  const url = buildDownloadUrl(null, downloadId);

  for (let attempt = 0; attempt < RESUME_MAX_ATTEMPTS; attempt++) {
    checkAborted(signal);
    try {
      const fileSize = await fetchFileSize(url, signal);
      await downloadWithBlobFallback(url, filename, fileSize, onProgress, signal, chunkSize);
      return;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const isNotReady =
        err.message?.includes('404') || err.message?.includes('still being prepared');
      if (!isNotReady || attempt === RESUME_MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, RESUME_POLL_INTERVAL_MS));
    }
  }
}

/**
 * Download a file with progress tracking.
 * Provide either `path` (single file) or `downloadId` (prepared zip).
 * Automatically selects chunked vs streamed based on file size.
 *
 * @param {Object} opts
 * @param {string}  [opts.path]           - File path (single file download)
 * @param {string}  [opts.downloadId]     - Prepared zip download ID
 * @param {string}   opts.filename        - Suggested filename
 * @param {number}  [opts.size]           - Known file size (avoids HEAD)
 * @param {Function}[opts.onProgress]     - (downloaded, total) callback
 * @param {AbortSignal}[opts.signal]      - Cancellation signal
 * @param {number}  [opts.chunkSize]      - Override chunk size in bytes
 * @param {boolean} [opts.chunkedEnabled] - false to force streamed download
 */
export async function download({ path, downloadId, filename, size, onProgress, signal, chunkSize, chunkedEnabled }) {
  const url = buildDownloadUrl(path, downloadId);
  const fileSize = size || (await fetchFileSize(url, signal));

  const useChunked = chunkedEnabled !== false && fileSize > CHUNKED_TRANSFER_THRESHOLD;

  if (useChunked) {
    // showSaveFilePicker requires a live user gesture. Prepared downloads
    // (downloadId) always lose the gesture during the async prepare step,
    // so skip it for those. Also catch SecurityError for edge cases where
    // the gesture expired (slow network, permissions policy, etc.).
    if (supportsFileSystemAccess && !downloadId) {
      try {
        await downloadWithFileSystemAccess(url, filename, fileSize, onProgress, signal, chunkSize);
        return;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (err.name !== 'SecurityError') throw err;
      }
    }
    await downloadWithBlobFallback(url, filename, fileSize, onProgress, signal, chunkSize);
    return;
  }

  checkAborted(signal);
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: getCommonHeaders(),
    signal,
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const resolvedName = parseFilenameFromHeaders(res.headers) || filename;
  const blob = await streamResponseToBlob(res, onProgress, signal, fileSize);
  triggerBlobDownload(blob, resolvedName);
}

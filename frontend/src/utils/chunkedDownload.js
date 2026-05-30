import { buildUrl, normalizePath } from '@/api/http';

const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const supportsFileSystemAccess =
  typeof window !== 'undefined' &&
  typeof window.showSaveFilePicker === 'function';

function buildRangeUrl(filePath) {
  const normalized = normalizePath(filePath);
  const params = new URLSearchParams({ path: normalized });
  return buildUrl(`/api/files/range-download?${params.toString()}`);
}

function getCommonHeaders() {
  const headers = {};
  const guestSessionId = sessionStorage.getItem('guestSessionId');
  if (guestSessionId) {
    headers['X-Guest-Session'] = guestSessionId;
  }
  return headers;
}

async function fetchFileSize(url) {
  const res = await fetch(url, {
    method: 'HEAD',
    credentials: 'include',
    headers: getCommonHeaders(),
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

async function fetchChunk(url, start, end, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          ...getCommonHeaders(),
          Range: `bytes=${start}-${end}`,
        },
      });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`Chunk fetch failed: ${res.status}`);
      }
      return await res.arrayBuffer();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
}

async function downloadWithFileSystemAccess(url, filename, fileSize, onProgress, signal) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    startIn: 'downloads',
  });
  const writable = await handle.createWritable();
  let downloaded = 0;

  try {
    for (let start = 0; start < fileSize; start += CHUNK_SIZE) {
      if (signal?.aborted) {
        throw new DOMException('Download cancelled', 'AbortError');
      }
      const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
      const chunk = await fetchChunk(url, start, end);
      await writable.write(new Uint8Array(chunk));
      downloaded += chunk.byteLength;
      onProgress?.(downloaded, fileSize);
    }
  } finally {
    await writable.close();
  }
}

async function downloadWithBlobFallback(url, filename, fileSize, onProgress, signal) {
  const chunks = [];
  let downloaded = 0;

  for (let start = 0; start < fileSize; start += CHUNK_SIZE) {
    if (signal?.aborted) {
      throw new DOMException('Download cancelled', 'AbortError');
    }
    const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
    const chunk = await fetchChunk(url, start, end);
    chunks.push(chunk);
    downloaded += chunk.byteLength;
    onProgress?.(downloaded, fileSize);
  }

  const blob = new Blob(chunks);
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

export async function chunkedDownload(filePath, filename, knownSize, onProgress, signal) {
  const url = buildRangeUrl(filePath);
  const fileSize = knownSize || (await fetchFileSize(url));

  if (supportsFileSystemAccess) {
    await downloadWithFileSystemAccess(url, filename, fileSize, onProgress, signal);
  } else {
    await downloadWithBlobFallback(url, filename, fileSize, onProgress, signal);
  }
}

export const CHUNKED_DOWNLOAD_THRESHOLD = 100 * 1024 * 1024; // 100 MB

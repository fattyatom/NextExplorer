import { buildUrl, normalizePath } from '@/api/http';
import {
  CHUNK_SIZE,
  iterateChunks,
  withRetry,
  getCommonHeaders,
  checkAborted,
} from './chunkedTransfer';

const supportsFileSystemAccess =
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

function buildRangeUrl(filePath) {
  const normalized = normalizePath(filePath);
  const params = new URLSearchParams({ path: normalized });
  return buildUrl(`/api/files/range-download?${params.toString()}`);
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

async function fetchChunk(url, start, end) {
  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { ...getCommonHeaders(), Range: `bytes=${start}-${end}` },
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`Chunk fetch failed: ${res.status}`);
    }
    return res.arrayBuffer();
  });
}

async function downloadWithFileSystemAccess(url, filename, fileSize, onProgress, signal) {
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    startIn: 'downloads',
  });
  const writable = await handle.createWritable();
  let downloaded = 0;

  try {
    for (const { start, end } of iterateChunks(fileSize)) {
      checkAborted(signal);
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

  for (const { start, end } of iterateChunks(fileSize)) {
    checkAborted(signal);
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

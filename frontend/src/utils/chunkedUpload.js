import { buildUrl, normalizePath } from '@/api/http';
import {
  CHUNK_SIZE,
  iterateChunks,
  withRetry,
  getCommonHeaders,
  checkAborted,
} from './chunkedTransfer';

async function initUpload(file, uploadTo, relativePath) {
  const res = await fetch(buildUrl('/api/chunked-upload/init'), {
    method: 'POST',
    credentials: 'include',
    headers: { ...getCommonHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      totalSize: file.size,
      uploadTo: normalizePath(uploadTo || ''),
      relativePath: normalizePath(relativePath || '') || file.name,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || `Init failed: ${res.status}`);
  }
  return res.json();
}

async function uploadChunk(uploadId, file, start, end, totalSize) {
  const chunkBlob = file.slice(start, end + 1);

  return withRetry(async () => {
    const res = await fetch(buildUrl(`/api/chunked-upload/${uploadId}`), {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        ...getCommonHeaders(),
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      },
      body: chunkBlob,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || `Chunk upload failed: ${res.status}`);
    }
    return res.json();
  });
}

async function completeUpload(uploadId) {
  const res = await fetch(buildUrl(`/api/chunked-upload/${uploadId}/complete`), {
    method: 'POST',
    credentials: 'include',
    headers: { ...getCommonHeaders(), 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Complete failed: ${res.status}`);
  }
  return res.json();
}

export async function chunkedUpload(file, uploadTo, relativePath, onProgress, signal) {
  checkAborted(signal);

  const { uploadId } = await initUpload(file, uploadTo, relativePath);
  let uploaded = 0;

  for (const { start, end } of iterateChunks(file.size, CHUNK_SIZE)) {
    checkAborted(signal);
    await uploadChunk(uploadId, file, start, end, file.size);
    uploaded += end - start + 1;
    onProgress?.(uploaded, file.size);
  }

  return completeUpload(uploadId);
}

import { buildUrl, normalizePath } from '@/api/http';
import {
  CHUNK_SIZE,
  iterateChunks,
  withRetry,
  getCommonHeaders,
  checkAborted,
} from './chunkedTransfer';

async function initUpload(file, uploadTo, relativePath, signal) {
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
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error || `Init failed: ${res.status}`);
  }
  return res.json();
}

function uploadChunkXHR(uploadId, chunkBlob, start, end, totalSize, signal, onChunkProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', buildUrl(`/api/chunked-upload/${uploadId}`));
    xhr.withCredentials = true;

    const headers = getCommonHeaders();
    for (const [k, v] of Object.entries(headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);

    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Transfer cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onChunkProgress?.(start + e.loaded, totalSize);
      }
    };

    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          resolve({});
        }
      } else {
        let msg = `Chunk upload failed: ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          msg = body?.error?.message || msg;
        } catch { /* ignore */ }
        reject(new Error(msg));
      }
    };

    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Network error during chunk upload'));
    };

    xhr.onabort = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Transfer cancelled', 'AbortError'));
    };

    xhr.send(chunkBlob);
  });
}

async function uploadChunk(uploadId, file, start, end, totalSize, signal, onChunkProgress) {
  const chunkBlob = file.slice(start, end + 1);

  return withRetry(async () => {
    return uploadChunkXHR(uploadId, chunkBlob, start, end, totalSize, signal, onChunkProgress);
  });
}

async function completeUpload(uploadId, signal) {
  const res = await fetch(buildUrl(`/api/chunked-upload/${uploadId}/complete`), {
    method: 'POST',
    credentials: 'include',
    headers: { ...getCommonHeaders(), 'Content-Type': 'application/json' },
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Complete failed: ${res.status}`);
  }
  return res.json();
}

async function cancelUpload(uploadId) {
  try {
    await fetch(buildUrl(`/api/chunked-upload/${uploadId}`), {
      method: 'DELETE',
      credentials: 'include',
      headers: getCommonHeaders(),
    });
  } catch {
    // best-effort cleanup
  }
}

export async function chunkedUpload(file, uploadTo, relativePath, onProgress, signal) {
  checkAborted(signal);

  const { uploadId } = await initUpload(file, uploadTo, relativePath, signal);

  try {
    for (const { start, end } of iterateChunks(file.size, CHUNK_SIZE)) {
      checkAborted(signal);
      await uploadChunk(uploadId, file, start, end, file.size, signal, onProgress);
    }

    return await completeUpload(uploadId, signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      await cancelUpload(uploadId);
    }
    throw err;
  }
}

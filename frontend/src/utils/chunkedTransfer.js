export const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
export const CHUNKED_TRANSFER_THRESHOLD = 100 * 1024 * 1024; // 100 MB

export function* iterateChunks(totalSize, chunkSize = CHUNK_SIZE) {
  let index = 0;
  for (let start = 0; start < totalSize; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, totalSize - 1);
    yield { index: index++, start, end, length: end - start + 1 };
  }
}

export async function withRetry(fn, retries = MAX_RETRIES, delayMs = RETRY_DELAY_MS) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

export function getCommonHeaders() {
  const headers = {};
  const guestSessionId = sessionStorage.getItem('guestSessionId');
  if (guestSessionId) {
    headers['X-Guest-Session'] = guestSessionId;
  }
  return headers;
}

export function checkAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Transfer cancelled', 'AbortError');
  }
}

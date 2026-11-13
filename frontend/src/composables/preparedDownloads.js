import { fetchPreparedDownload, preparedDownloadUrl } from '@/api';

/**
 * Taking away a zip the server made out of sight.
 *
 * Two things a browser can do with one, and they are not the same thing.
 *
 * Where the File System Access API exists, the reader says where the zip goes
 * before anything is asked of the server, and it is then written there in
 * ranges: each request is small enough that a proxy passes it straight on
 * instead of holding a response of several gigabytes, a range that fails is
 * asked for again rather than the transfer started over, and the progress
 * figure comes from the bytes.
 *
 * Everywhere else the finished zip is handed to the browser's own downloads,
 * which is one ordinary request for a file that already exists. What happens to
 * it after that is the browser's to show; this application cannot see it and
 * does not pretend to.
 */

/** Bytes asked for in one request. */
export const RANGE_BYTES = 8 * 1024 * 1024;

/** Ranges in flight at once, so the next request overlaps the current write. */
export const RANGES_IN_FLIGHT = 4;

/** How often a range is asked for again before the download is given up. */
const RANGE_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [500, 2000, 5000];

/** The least time between two "is it ready" questions the server did not hold. */
const MIN_POLL_SPACING_MS = 1000;

/** A build that has not ended after this long is not one worth waiting on. */
const BUILD_DEADLINE_MS = 2 * 60 * 60 * 1000;

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Whether the reader can be asked where to save a file. */
export const canChooseSaveFile = () =>
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

/**
 * Ask where the zip goes. Null means the reader closed the picker, which is an
 * answer and not a failure; anything else is thrown.
 *
 * This has to be the first thing a click leads to: a picker opened after a
 * request has been waited on is a picker the browser refuses to open.
 */
export const chooseSaveFile = async (name) => {
  try {
    return await window.showSaveFilePicker({
      id: 'nextexplorer-download',
      suggestedName: name,
      startIn: 'downloads',
      types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    throw error;
  }
};

/** The whole length, from `Content-Range: bytes a-b/TOTAL`. */
const totalFrom = (response) => {
  const match = /\/\s*(\d+)\s*$/.exec(response.headers.get('content-range') || '');
  return match ? Number(match[1]) : null;
};

/**
 * One range, asked for again when it fails for a reason that may pass: a
 * gateway that gave up, a connection that dropped. A refusal — the archive is
 * gone, the session is over — is not asked twice.
 */
const fetchRange = async (id, range, { signal, wait: hold = false } = {}) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchPreparedDownload(id, {
        range,
        wait: hold,
        signal,
        suppressErrorHandler: true,
      });
      if (response.status === 202) return { building: await response.json().catch(() => ({})) };
      return {
        whole: response.status === 200,
        total: totalFrom(response),
        buffer: await response.arrayBuffer(),
      };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      const passing = !error?.statusCode || error.statusCode >= 500 || error.statusCode === 429;
      if (!passing || attempt >= RANGE_ATTEMPTS - 1) throw error;
      await wait(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)], signal);
    }
  }
};

/**
 * Wait for the archive, and come back with its first range.
 *
 * The question and the first read are the same request: 202 while the server
 * is still building, the opening bytes — and with them the total — once it is
 * not. `onBuilding(percent)` is called for every "not yet".
 */
export const awaitFirstRange = async ({
  id,
  signal,
  onBuilding,
  rangeBytes = RANGE_BYTES,
  deadlineMs = BUILD_DEADLINE_MS,
  minSpacingMs = MIN_POLL_SPACING_MS,
} = {}) => {
  const startedAt = Date.now();
  for (;;) {
    const askedAt = Date.now();
    const answer = await fetchRange(id, { start: 0, end: rangeBytes - 1 }, { signal, wait: true });
    if (!answer.building) return answer;

    onBuilding?.(Number(answer.building.percent) || 0);
    if (Date.now() - startedAt > deadlineMs) {
      throw new Error('The archive took too long to prepare.');
    }
    // The server holds the question itself; this only matters where something
    // in between answered for it, and then it keeps the asking polite.
    const spent = Date.now() - askedAt;
    if (spent < minSpacingMs) await wait(minSpacingMs - spent, signal);
  }
};

/**
 * Write a ready archive into the file the reader picked, range by range.
 *
 * `first` is what `awaitFirstRange` came back with. The rest are fetched a few
 * at a time and written in order, so nothing larger than that window is ever
 * held in memory. `onProgress(writtenBytes, totalBytes)` follows the writes.
 */
export const writePreparedToFile = async ({
  id,
  first,
  fileHandle,
  signal,
  onProgress,
  rangeBytes = RANGE_BYTES,
  inFlight = RANGES_IN_FLIGHT,
} = {}) => {
  const writable = await fileHandle.createWritable();
  const pending = new Map();
  let written = 0;

  try {
    const total = first.whole ? first.buffer.byteLength : (first.total ?? first.buffer.byteLength);
    if (first.buffer.byteLength > 0) {
      await writable.write(first.buffer);
      written += first.buffer.byteLength;
    }
    onProgress?.(written, total);

    const ranges = [];
    for (let start = written; start < total; start += rangeBytes) {
      ranges.push({ start, end: Math.min(start + rangeBytes, total) - 1 });
    }

    let next = 0;
    const launch = () => {
      const index = next;
      next += 1;
      const request = fetchRange(id, ranges[index], { signal });
      // Looked at when its turn comes; until then a failure must not go unheard.
      request.catch(() => {});
      pending.set(index, request);
    };
    while (next < Math.min(inFlight, ranges.length)) launch();

    for (let index = 0; index < ranges.length; index += 1) {
      const { buffer } = await pending.get(index);
      pending.delete(index);
      if (next < ranges.length) launch();

      const expected = ranges[index].end - ranges[index].start + 1;
      if (buffer.byteLength !== expected) {
        throw new Error('The archive arrived incomplete.');
      }
      await writable.write(buffer);
      written += buffer.byteLength;
      onProgress?.(written, total);
    }

    await writable.close();
    return { writtenBytes: written };
  } catch (error) {
    await Promise.allSettled([...pending.values()]);
    // Nothing of this file was committed, but the name was taken the moment the
    // reader picked it. An empty zip left behind would look like a download
    // that worked, so it is taken back where the browser allows.
    await writable.abort?.().catch(() => {});
    await fileHandle.remove?.().catch(() => {});
    throw error;
  }
};

/** Hand a ready archive to the browser's own downloads. */
export const handPreparedToBrowser = ({ id, name }) => {
  const anchor = document.createElement('a');
  anchor.href = preparedDownloadUrl(id);
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
};

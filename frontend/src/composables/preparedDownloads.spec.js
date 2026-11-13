import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Taking away a zip the server made out of sight.
 *
 * What can go wrong quietly is the same as for any file this application
 * writes on somebody's disk: an archive with a piece missing that still looks
 * like an archive, and an empty file left behind by a download that failed.
 * The rest is patience — a range that failed once is asked for again, and a
 * build still running is waited on, not reported as a failure.
 */

const api = vi.hoisted(() => ({ fetchPreparedDownload: vi.fn(), preparedDownloadUrl: vi.fn() }));
vi.mock('@/api', () => ({
  fetchPreparedDownload: (...args) => api.fetchPreparedDownload(...args),
  preparedDownloadUrl: (...args) => api.preparedDownloadUrl(...args),
}));

import { awaitFirstRange, handPreparedToBrowser, writePreparedToFile } from './preparedDownloads';

const CONTENT = new TextEncoder().encode('0123456789abcdefghijklmnopqrstuvwxyz');

const building = (percent) => ({
  status: 202,
  json: async () => ({ status: 'building', percent }),
});

const rangeOf = ({ start, end }) => {
  const last = Math.min(end, CONTENT.length - 1);
  return {
    status: 206,
    headers: { get: () => `bytes ${start}-${last}/${CONTENT.length}` },
    arrayBuffer: async () => CONTENT.slice(start, last + 1).buffer,
  };
};

/** The server, once the archive exists: every range answered from CONTENT. */
const serveRanges = () =>
  api.fetchPreparedDownload.mockImplementation(async (_id, { range }) => rangeOf(range));

const failure = (statusCode) => Object.assign(new Error(`status ${statusCode}`), { statusCode });

const fileHandle = () => {
  const written = [];
  const writable = {
    write: vi.fn(async (buffer) => written.push(...new Uint8Array(buffer))),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return {
    handle: { createWritable: async () => writable, remove: vi.fn(async () => {}) },
    writable,
    text: () => new TextDecoder().decode(new Uint8Array(written)),
  };
};

beforeEach(() => {
  api.fetchPreparedDownload.mockReset();
  api.preparedDownloadUrl.mockReset();
});

describe('waiting for the archive', () => {
  it('keeps asking while it is being built, and says how far along it is', async () => {
    api.fetchPreparedDownload
      .mockResolvedValueOnce(building(10))
      .mockResolvedValueOnce(building(60))
      .mockImplementation(async (_id, { range }) => rangeOf(range));
    const seen = [];

    const first = await awaitFirstRange({
      id: 'abc',
      rangeBytes: 8,
      minSpacingMs: 0,
      onBuilding: (percent) => seen.push(percent),
    });

    expect(seen).toEqual([10, 60]);
    expect(first.total).toBe(CONTENT.length);
    expect(new TextDecoder().decode(first.buffer)).toBe('01234567');
    // The server holds the question, so it is asked to.
    expect(api.fetchPreparedDownload.mock.calls[0][1]).toMatchObject({
      wait: true,
      range: { start: 0, end: 7 },
    });
  });

  it('gives up when the build was refused, without asking again', async () => {
    api.fetchPreparedDownload.mockRejectedValue(failure(413));

    await expect(awaitFirstRange({ id: 'abc', minSpacingMs: 0 })).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(api.fetchPreparedDownload).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the reader cancels', async () => {
    const controller = new AbortController();
    api.fetchPreparedDownload.mockImplementation(async () => {
      controller.abort();
      return building(5);
    });

    await expect(
      awaitFirstRange({ id: 'abc', signal: controller.signal, minSpacingMs: 50 })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('writing the archive where the reader said', () => {
  const firstRange = (rangeBytes) => ({
    whole: false,
    total: CONTENT.length,
    buffer: CONTENT.slice(0, rangeBytes).buffer,
  });

  it('writes every range, in order, whatever order they arrive in', async () => {
    // Later ranges answer sooner: the file must still read from start to end.
    api.fetchPreparedDownload.mockImplementation(async (_id, { range }) => {
      await new Promise((resolve) => setTimeout(resolve, 40 - range.start));
      return rangeOf(range);
    });
    const file = fileHandle();
    const progress = [];

    const result = await writePreparedToFile({
      id: 'abc',
      first: firstRange(8),
      fileHandle: file.handle,
      rangeBytes: 8,
      onProgress: (written, total) => progress.push([written, total]),
    });

    expect(file.text()).toBe(new TextDecoder().decode(CONTENT));
    expect(result.writtenBytes).toBe(CONTENT.length);
    expect(file.writable.close).toHaveBeenCalled();
    expect(progress.at(-1)).toEqual([CONTENT.length, CONTENT.length]);
  });

  it('asks again for a range a gateway gave up on, rather than starting over', async () => {
    vi.useFakeTimers();
    let failedOnce = false;
    api.fetchPreparedDownload.mockImplementation(async (_id, { range }) => {
      if (range.start === 16 && !failedOnce) {
        failedOnce = true;
        throw failure(524);
      }
      return rangeOf(range);
    });
    const file = fileHandle();

    const writing = writePreparedToFile({
      id: 'abc',
      first: firstRange(8),
      fileHandle: file.handle,
      rangeBytes: 8,
      inFlight: 1,
    });
    await vi.runAllTimersAsync();
    await writing;
    vi.useRealTimers();

    expect(file.text()).toBe(new TextDecoder().decode(CONTENT));
    const asked = api.fetchPreparedDownload.mock.calls.map(([, { range }]) => range.start);
    expect(asked).toEqual([8, 16, 16, 24, 32]);
  });

  it('takes the file back when the archive stops arriving', async () => {
    api.fetchPreparedDownload.mockRejectedValue(failure(404));
    const file = fileHandle();

    await expect(
      writePreparedToFile({
        id: 'abc',
        first: firstRange(8),
        fileHandle: file.handle,
        rangeBytes: 8,
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(file.writable.close).not.toHaveBeenCalled();
    expect(file.writable.abort).toHaveBeenCalled();
    expect(file.handle.remove).toHaveBeenCalled();
  });

  it('refuses a range that came back short, which would be a broken zip', async () => {
    api.fetchPreparedDownload.mockImplementation(async (_id, { range }) => ({
      ...rangeOf(range),
      arrayBuffer: async () => CONTENT.slice(range.start, range.start + 2).buffer,
    }));
    const file = fileHandle();

    await expect(
      writePreparedToFile({
        id: 'abc',
        first: firstRange(8),
        fileHandle: file.handle,
        rangeBytes: 8,
      })
    ).rejects.toThrow();
    expect(file.writable.close).not.toHaveBeenCalled();
  });

  it('writes an archive that fitted in the first range without asking for more', async () => {
    serveRanges();
    const file = fileHandle();

    await writePreparedToFile({
      id: 'abc',
      first: { whole: false, total: CONTENT.length, buffer: CONTENT.buffer },
      fileHandle: file.handle,
      rangeBytes: 1024,
    });

    expect(api.fetchPreparedDownload).not.toHaveBeenCalled();
    expect(file.text()).toBe(new TextDecoder().decode(CONTENT));
  });
});

describe('handing the archive to the browser', () => {
  it('clicks an anchor that names the zip', () => {
    api.preparedDownloadUrl.mockReturnValue('/api/download/prepared/abc');
    const clicked = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function capture() {
        clicked.push({ href: this.getAttribute('href'), download: this.download });
      });

    handPreparedToBrowser({ id: 'abc', name: 'Photos.zip' });

    expect(clicked).toEqual([{ href: '/api/download/prepared/abc', download: 'Photos.zip' }]);
    click.mockRestore();
  });
});

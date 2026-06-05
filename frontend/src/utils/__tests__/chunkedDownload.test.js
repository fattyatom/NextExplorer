import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup — must happen before importing the module under test.
//
// We intentionally do NOT use jsdom.  The module under test checks
// `typeof window` at import time for FSAA support, so we provide a
// minimal window/document shim instead of pulling in a full DOM env.
// ---------------------------------------------------------------------------

vi.mock('@/api/http', () => ({
  buildUrl: (path) => `http://test${path}`,
  normalizePath: (p) => p,
}));

// Capture <a> elements created for downloads. We spy on document.createElement
// in beforeEach so this works whether or not the test env provides a real DOM
// (jsdom's real <a>.click() throws "navigation not implemented", so we always
// substitute our own fake anchor with a no-op click).
const anchors = [];
function makeAnchor() {
  const a = { href: '', download: '', style: {}, click: vi.fn() };
  anchors.push(a);
  return a;
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { createElement: () => ({}), body: {} };
}

if (typeof globalThis.sessionStorage === 'undefined') {
  const store = {};
  globalThis.sessionStorage = {
    getItem: (key) => store[key] ?? null,
    setItem: (key, val) => { store[key] = val; },
    removeItem: (key) => { delete store[key]; },
  };
}

if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = {};
}
globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
globalThis.URL.revokeObjectURL = vi.fn();

// Ensure FSAA is NOT available
delete globalThis.showSaveFilePicker;
delete globalThis.window.showSaveFilePicker;

// Helper: ReadableStream from chunks
function createReadableStream(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

// Helper: mock fetch Response
function mockResponse(body, headers = {}, status = 200) {
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  const chunks =
    typeof body === 'string' ? [new TextEncoder().encode(body)] : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headerMap.get(key.toLowerCase()) ?? null },
    body: createReadableStream(chunks),
    json: () => Promise.resolve({}),
  };
}

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  anchors.length = 0;
  // Always substitute our fake anchor for <a> so .click() never navigates.
  vi.spyOn(document, 'createElement').mockImplementation((tag) =>
    tag === 'a' ? makeAnchor() : {}
  );
  vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);
  vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// download() — single file
// ---------------------------------------------------------------------------

describe('download()', () => {
  it('fetches from range-download endpoint with correct path', async () => {
    const { download } = await import('../chunkedDownload');

    fetchMock.mockResolvedValue(
      mockResponse('file content', {
        'content-disposition': 'attachment; filename="test.txt"',
        'content-length': '12',
      })
    );

    await download({
      path: 'docs/readme.txt',
      filename: 'readme.txt',
      size: 12,
      onProgress: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('/api/range-download');
    expect(url).toContain('path=docs%2Freadme.txt');
    // Should trigger blob download via <a>
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0].click).toHaveBeenCalledOnce();
  });

  it('reports progress during blob accumulation', async () => {
    const { download } = await import('../chunkedDownload');

    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    fetchMock.mockResolvedValue(
      mockResponse([chunk1, chunk2], {
        'content-disposition': 'attachment; filename="data.bin"',
        'content-length': '5',
      })
    );

    const progress = vi.fn();
    await download({ path: 'data.bin', filename: 'data.bin', size: 5, onProgress: progress });

    expect(progress).toHaveBeenCalledWith(3, 5);
    expect(progress).toHaveBeenCalledWith(5, 5);
  });

  it('throws on failed fetch', async () => {
    const { download } = await import('../chunkedDownload');
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    await expect(
      download({ path: 'missing.txt', filename: 'missing.txt' })
    ).rejects.toThrow('Download failed: 404');
  });

  it('respects abort signal', async () => {
    const { download } = await import('../chunkedDownload');
    const controller = new AbortController();
    controller.abort();

    await expect(
      download({ path: 'file.txt', filename: 'file.txt', signal: controller.signal })
    ).rejects.toThrow('Transfer cancelled');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers Content-Disposition filename over provided filename', async () => {
    const { download } = await import('../chunkedDownload');

    fetchMock.mockResolvedValue(
      mockResponse('data', {
        'content-disposition': "attachment; filename*=UTF-8''server-name.bin",
      })
    );

    await download({ path: 'f.bin', filename: 'client-name.bin' });
    expect(anchors[0].download).toBe('server-name.bin');
  });
});

// ---------------------------------------------------------------------------
// streamZipDownload() — multi-file / directory
// ---------------------------------------------------------------------------

describe('streamZipDownload()', () => {
  // POST /api/download → 202 { downloadId, filename }
  function mockAcceptResponse({ downloadId = 'abc123', filename = 'photos.zip' } = {}) {
    return {
      ok: true,
      status: 202,
      headers: { get: () => null },
      json: () => Promise.resolve({ downloadId, filename }),
    };
  }

  // HEAD /api/range-download → 200 with Content-Length (build finished)
  function mockReadyResponse(size = 1000) {
    return {
      ok: true,
      status: 200,
      headers: { get: (key) => (key.toLowerCase() === 'content-length' ? String(size) : null) },
    };
  }

  it('POSTs to /api/download with correct body', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(mockAcceptResponse())
      .mockResolvedValueOnce(mockReadyResponse());

    await streamZipDownload({
      paths: ['photos/a.jpg', 'photos/b.jpg'],
      basePath: 'photos',
      filename: 'photos.zip',
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://test/api/download');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.items).toEqual(['photos/a.jpg', 'photos/b.jpg']);
    expect(body.basePath).toBe('photos');
  });

  it('uses the server-provided filename for the native download', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(mockAcceptResponse({ downloadId: 'id-1', filename: 'My Album.zip' }))
      .mockResolvedValueOnce(mockReadyResponse());

    await streamZipDownload({ paths: ['album'], basePath: '', filename: 'fallback.zip' });

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[anchors.length - 1].download).toBe('My Album.zip');
  });

  it('returns "native-handoff" once the browser takes over', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(mockAcceptResponse({ downloadId: 'id-2' }))
      .mockResolvedValueOnce(mockReadyResponse());

    const result = await streamZipDownload({ paths: ['x'], basePath: '', filename: 't.zip' });
    expect(result).toBe('native-handoff');
  });

  it('succeeds when the readiness response has no Content-Length (Safari/CDN)', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(mockAcceptResponse({ downloadId: 'id-safari', filename: 'f.zip' }))
      // HEAD readiness: 200 but no Content-Length header (Safari/Cloudflare).
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null } });

    const result = await streamZipDownload({ paths: ['x'], basePath: '', filename: 'f.zip' });

    // Must not throw "valid Content-Length"; proceeds to the native handoff.
    expect(result).toBe('native-handoff');
    expect(anchors[anchors.length - 1].click).toHaveBeenCalledOnce();
  });

  it('polls range-download with the downloadId, then triggers native download', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(mockAcceptResponse({ downloadId: 'resume-id-1', filename: 'big.zip' }))
      .mockResolvedValueOnce(mockReadyResponse(1000));

    await streamZipDownload({ paths: ['big-folder'], basePath: '', filename: 'big.zip' });

    // First call POST, second call HEAD poll
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headCall = fetchMock.mock.calls[1];
    expect(headCall[0]).toContain('/api/range-download');
    expect(headCall[0]).toContain('downloadId=resume-id-1');
    expect(headCall[1].method).toBe('HEAD');

    // Native download triggered via <a> click, pointing at the prepared file
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[anchors.length - 1].click).toHaveBeenCalledOnce();
    expect(anchors[anchors.length - 1].href).toContain('downloadId=resume-id-1');
  });

  it('carries the guest session in the native download URL (shared links)', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    sessionStorage.setItem('guestSessionId', 'guest-abc');
    try {
      fetchMock
        .mockResolvedValueOnce(mockAcceptResponse({ downloadId: 'share-id', filename: 's.zip' }))
        .mockResolvedValueOnce(mockReadyResponse());

      await streamZipDownload({ paths: ['shared-folder'], basePath: '', filename: 's.zip' });

      const href = anchors[anchors.length - 1].href;
      expect(href).toContain('downloadId=share-id');
      expect(href).toContain('guestSession=guest-abc');
    } finally {
      sessionStorage.removeItem('guestSessionId');
    }
  });

  it('reports "Preparing zip…" via onStatus', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(mockAcceptResponse())
      .mockResolvedValueOnce(mockReadyResponse());

    const onStatus = vi.fn();
    await streamZipDownload({ paths: ['x'], basePath: '', filename: 't.zip', onStatus });
    expect(onStatus).toHaveBeenCalledWith('Preparing zip…');
  });

  it('throws when the server does not return a downloadId', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });

    await expect(
      streamZipDownload({ paths: ['x'], basePath: '', filename: 't.zip' })
    ).rejects.toThrow('downloadId');
  });

  it('throws on failed POST', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: () => Promise.resolve({ error: { message: 'Forbidden' } }),
    });

    await expect(
      streamZipDownload({ paths: ['secret'], basePath: '', filename: 'test.zip' })
    ).rejects.toThrow('Forbidden');
  });

  it('respects abort signal before fetch', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');
    const controller = new AbortController();
    controller.abort();

    await expect(
      streamZipDownload({
        paths: ['a'],
        basePath: '',
        filename: 'test.zip',
        signal: controller.signal,
      })
    ).rejects.toThrow('Transfer cancelled');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// streamZipDownload() — File System Access path (Chromium)
// ---------------------------------------------------------------------------

describe('streamZipDownload() with File System Access', () => {
  let writable;
  let pickerMock;

  beforeEach(() => {
    writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    pickerMock = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue(writable),
    });
    window.showSaveFilePicker = pickerMock;
  });

  afterEach(() => {
    delete window.showSaveFilePicker;
  });

  const accept = ({ downloadId = 'fsaa-1', filename = 'f.zip' } = {}) => ({
    ok: true,
    status: 202,
    headers: { get: () => null },
    json: () => Promise.resolve({ downloadId, filename }),
  });
  // HEAD readiness — status only; no Content-Length needed (Safari/CDN-safe).
  const ready = () => ({ ok: true, status: 200, headers: { get: () => null } });
  // 206 chunk; total size is conveyed via Content-Range (the CDN-safe source).
  const chunk = (bytes, total) => ({
    ok: true,
    status: 206,
    headers: {
      get: (k) => (k.toLowerCase() === 'content-range' ? `bytes 0-${bytes - 1}/${total}` : null),
    },
    arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
  });

  it('grabs the save handle up front and streams the file in ranged chunks', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(accept({ downloadId: 'fsaa-1' })) // POST
      .mockResolvedValueOnce(ready()) // HEAD readiness
      .mockResolvedValueOnce(chunk(1000, 1000)) // ranged GET (whole file in one chunk)
      .mockResolvedValueOnce({ ok: true, status: 204 }); // cleanup DELETE

    const onProgress = vi.fn();
    const result = await streamZipDownload({
      paths: ['folder'],
      basePath: '',
      filename: 'f.zip',
      chunkSize: 1000,
      onProgress,
    });

    // Picker requested before the build, with the suggested name
    expect(pickerMock).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'f.zip' })
    );

    // Ranged GET carried a Range header
    const getCall = fetchMock.mock.calls.find(
      (c) => c[1]?.method === 'GET' && c[1]?.headers?.Range
    );
    expect(getCall).toBeTruthy();
    expect(getCall[1].headers.Range).toBe('bytes=0-999');

    // Bytes written to disk, progress reported, stream closed
    expect(writable.write).toHaveBeenCalledOnce();
    expect(writable.close).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(1000, 1000);

    // Not a native handoff — this path tracks real completion
    expect(result).toBeUndefined();
  });

  it('cancels the whole download if the user dismisses the save picker', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');
    pickerMock.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    );

    await expect(
      streamZipDownload({ paths: ['folder'], basePath: '', filename: 'f.zip' })
    ).rejects.toThrow('Transfer cancelled');

    // Never even started the build
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits the download into ranged GETs sized by the chunkSize setting', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    // 250-byte file with a 100-byte chunk size → 3 ranges: 0-99, 100-199, 200-249
    fetchMock
      .mockResolvedValueOnce(accept({ downloadId: 'fsaa-2' })) // POST
      .mockResolvedValueOnce(ready()) // HEAD readiness
      .mockResolvedValueOnce(chunk(100, 250)) // 0-99 (Content-Range reveals total=250)
      .mockResolvedValueOnce(chunk(100, 250)) // 100-199
      .mockResolvedValueOnce(chunk(50, 250)) // 200-249
      .mockResolvedValueOnce({ ok: true, status: 204 }); // cleanup DELETE

    const onProgress = vi.fn();
    await streamZipDownload({
      paths: ['folder'],
      basePath: '',
      filename: 'f.zip',
      chunkSize: 100,
      onProgress,
    });

    const ranges = fetchMock.mock.calls
      .filter((c) => c[1]?.method === 'GET' && c[1]?.headers?.Range)
      .map((c) => c[1].headers.Range);
    expect(ranges).toEqual(['bytes=0-99', 'bytes=100-199', 'bytes=200-249']);

    expect(writable.write).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(250, 250);
  });

  it('pipelines: remaining range requests overlap the writes', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    // 400-byte file, 100-byte chunks → first chunk standalone (reveals total),
    // then chunks 2-4 are fetched concurrently.
    fetchMock
      .mockResolvedValueOnce(accept({ downloadId: 'fsaa-3' })) // POST
      .mockResolvedValueOnce(ready()) // HEAD readiness
      .mockResolvedValue(chunk(100, 400)); // every ranged GET (and cleanup DELETE)

    // Record how many ranged GETs had been issued at each disk write.
    const getsPerWrite = [];
    writable.write.mockImplementation(async () => {
      getsPerWrite.push(fetchMock.mock.calls.filter((c) => c[1]?.headers?.Range).length);
    });

    await streamZipDownload({ paths: ['folder'], basePath: '', filename: 'f.zip', chunkSize: 100 });

    // By the 2nd write, the remaining chunks (3 and 4) have been prefetched —
    // more GETs are in flight than sequential fetching (which would show 2).
    expect(getsPerWrite.length).toBe(4);
    expect(getsPerWrite[1]).toBeGreaterThan(2);
  });

  it('falls back to native download when chunked downloads are disabled', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock
      .mockResolvedValueOnce(accept({ downloadId: 'native-1', filename: 'f.zip' })) // POST
      .mockResolvedValueOnce(ready()); // HEAD readiness

    const result = await streamZipDownload({
      paths: ['folder'],
      basePath: '',
      filename: 'f.zip',
      chunkedEnabled: false,
    });

    // Picker never shown, no ranged GETs, native <a> handoff instead
    expect(pickerMock).not.toHaveBeenCalled();
    expect(writable.write).not.toHaveBeenCalled();
    expect(result).toBe('native-handoff');
    expect(anchors[anchors.length - 1].click).toHaveBeenCalledOnce();
  });
});

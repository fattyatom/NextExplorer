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

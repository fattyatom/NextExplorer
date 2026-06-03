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

// Minimal DOM shim
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
  globalThis.document = {
    createElement: (tag) => (tag === 'a' ? makeAnchor() : {}),
    body: {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    },
  };
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
  it('POSTs to /api/files/download with correct body', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock.mockResolvedValue(
      mockResponse('zipdata', {
        'content-disposition': 'attachment; filename="photos.zip"',
        'x-download-id': 'abc123',
      })
    );

    // With no FSAA and chunkedEnabled=false → blob fallback
    await streamZipDownload({
      paths: ['photos/a.jpg', 'photos/b.jpg'],
      basePath: 'photos',
      filename: 'photos.zip',
      onProgress: vi.fn(),
      chunkedEnabled: false,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://test/api/files/download');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.items).toEqual(['photos/a.jpg', 'photos/b.jpg']);
    expect(body.basePath).toBe('photos');
  });

  it('parses filename from Content-Disposition header', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock.mockResolvedValue(
      mockResponse('zipdata', {
        'content-disposition': "attachment; filename*=UTF-8''My%20Album.zip",
        'x-download-id': 'abc123',
      })
    );

    await streamZipDownload({
      paths: ['album'],
      basePath: '',
      filename: 'fallback.zip',
      chunkedEnabled: false,
    });

    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0].download).toBe('My Album.zip');
  });

  it('throws on failed POST', async () => {
    const { streamZipDownload } = await import('../chunkedDownload');

    fetchMock.mockResolvedValue({
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

  describe('without FSAA, chunkedEnabled=true', () => {
    it('cancels response body and polls range-download for resume', async () => {
      const { streamZipDownload } = await import('../chunkedDownload');

      const cancelSpy = vi.fn().mockResolvedValue(undefined);

      // First call: POST /api/files/download
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (key) => {
            const k = key.toLowerCase();
            if (k === 'x-download-id') return 'resume-id-1';
            if (k === 'content-disposition') return 'attachment; filename="big.zip"';
            return null;
          },
        },
        body: { cancel: cancelSpy },
        json: () => Promise.resolve({}),
      });

      // Second call: HEAD /api/range-download (poll for file size)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (key) => (key.toLowerCase() === 'content-length' ? '1000' : null),
        },
      });

      const progress = vi.fn();
      await streamZipDownload({
        paths: ['big-folder'],
        basePath: '',
        filename: 'big.zip',
        onProgress: progress,
        chunkedEnabled: true,
      });

      // Should have cancelled the stream body
      expect(cancelSpy).toHaveBeenCalledOnce();

      // Should have polled HEAD for size
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const headCall = fetchMock.mock.calls[1];
      expect(headCall[0]).toContain('/api/range-download');
      expect(headCall[0]).toContain('downloadId=resume-id-1');
      expect(headCall[1].method).toBe('HEAD');

      // Should have triggered native download via <a> click
      expect(anchors.length).toBeGreaterThan(0);
      expect(anchors[anchors.length - 1].click).toHaveBeenCalledOnce();
      expect(anchors[anchors.length - 1].href).toContain('downloadId=resume-id-1');

      // Should have reported progress as complete
      expect(progress).toHaveBeenCalledWith(1000, 1000);
    });
  });
});

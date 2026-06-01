import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CHUNK_SIZE,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  CHUNKED_TRANSFER_THRESHOLD,
  iterateChunks,
  withRetry,
  checkAborted,
} from '../chunkedTransfer';

describe('chunkedTransfer constants', () => {
  it('CHUNK_SIZE is 20 MB', () => {
    expect(CHUNK_SIZE).toBe(20 * 1024 * 1024);
  });

  it('CHUNKED_TRANSFER_THRESHOLD is 100 MB', () => {
    expect(CHUNKED_TRANSFER_THRESHOLD).toBe(100 * 1024 * 1024);
  });

  it('MAX_RETRIES defaults to 3', () => {
    expect(MAX_RETRIES).toBe(3);
  });

  it('RETRY_DELAY_MS defaults to 1000', () => {
    expect(RETRY_DELAY_MS).toBe(1000);
  });
});

describe('iterateChunks', () => {
  it('yields a single chunk for a file smaller than chunkSize', () => {
    const chunks = [...iterateChunks(100, 1024)];
    expect(chunks).toEqual([{ index: 0, start: 0, end: 99, length: 100 }]);
  });

  it('yields a single chunk for a file exactly chunkSize', () => {
    const chunks = [...iterateChunks(1024, 1024)];
    expect(chunks).toEqual([{ index: 0, start: 0, end: 1023, length: 1024 }]);
  });

  it('yields two chunks for a file slightly over chunkSize', () => {
    const chunks = [...iterateChunks(1025, 1024)];
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ index: 0, start: 0, end: 1023, length: 1024 });
    expect(chunks[1]).toEqual({ index: 1, start: 1024, end: 1024, length: 1 });
  });

  it('yields correct chunks for an evenly divisible file', () => {
    const chunks = [...iterateChunks(3072, 1024)];
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ index: 0, start: 0, end: 1023, length: 1024 });
    expect(chunks[1]).toEqual({ index: 1, start: 1024, end: 2047, length: 1024 });
    expect(chunks[2]).toEqual({ index: 2, start: 2048, end: 3071, length: 1024 });
  });

  it('uses default CHUNK_SIZE when none specified', () => {
    const totalSize = CHUNK_SIZE * 2 + 1;
    const chunks = [...iterateChunks(totalSize)];
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(CHUNK_SIZE);
    expect(chunks[1].length).toBe(CHUNK_SIZE);
    expect(chunks[2].length).toBe(1);
  });

  it('yields nothing for zero-sized file', () => {
    const chunks = [...iterateChunks(0, 1024)];
    expect(chunks).toHaveLength(0);
  });

  it('consecutive chunks cover the entire file with no gaps or overlaps', () => {
    const totalSize = 5000;
    const chunkSize = 1024;
    const chunks = [...iterateChunks(totalSize, chunkSize)];

    // Verify no gaps
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end + 1);
    }

    // Verify full coverage
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(totalSize - 1);

    // Verify total bytes
    const totalBytes = chunks.reduce((sum, c) => sum + c.length, 0);
    expect(totalBytes).toBe(totalSize);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on second attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, 3, 100);

    // Advance past the first retry delay (100ms * attempt 1)
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries', async () => {
    const error = new Error('persistent fail');
    const fn = vi.fn().mockRejectedValue(error);

    const promise = withRetry(fn, 3, 100);
    // Catch to prevent unhandled rejection warning; we assert below
    promise.catch(() => {});

    // Advance through retry delays
    await vi.advanceTimersByTimeAsync(100); // attempt 2 delay
    await vi.advanceTimersByTimeAsync(200); // attempt 3 delay

    await expect(promise).rejects.toThrow('persistent fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('immediately rethrows AbortError without retrying', async () => {
    const abortError = new DOMException('Transfer cancelled', 'AbortError');
    const fn = vi.fn().mockRejectedValue(abortError);

    await expect(withRetry(fn, 3, 100)).rejects.toThrow('Transfer cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff (delayMs * attempt)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, 3, 100);

    // After attempt 1 fails, delay = 100 * 1 = 100ms
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // After attempt 2 fails, delay = 100 * 2 = 200ms
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(3);

    const result = await promise;
    expect(result).toBe('ok');
  });

  it('passes attempt number to the function', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await withRetry(fn);
    expect(fn).toHaveBeenCalledWith(1);
  });
});

describe('checkAborted', () => {
  it('does nothing when signal is undefined', () => {
    expect(() => checkAborted(undefined)).not.toThrow();
  });

  it('does nothing when signal is null', () => {
    expect(() => checkAborted(null)).not.toThrow();
  });

  it('does nothing when signal is not aborted', () => {
    const controller = new AbortController();
    expect(() => checkAborted(controller.signal)).not.toThrow();
  });

  it('throws AbortError when signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => checkAborted(controller.signal)).toThrow();
    try {
      checkAborted(controller.signal);
    } catch (err) {
      expect(err.name).toBe('AbortError');
      expect(err.message).toBe('Transfer cancelled');
    }
  });
});

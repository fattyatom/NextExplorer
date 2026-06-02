import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const mockAddNotification = vi.fn();

// Mock the notifications store before importing transferStore
vi.mock('../notifications', () => ({
  useNotificationsStore: () => ({
    addNotification: mockAddNotification,
  }),
}));

import { useTransferStore } from '../transferStore';

describe('transferStore', () => {
  let store;

  beforeEach(() => {
    vi.useFakeTimers();
    mockAddNotification.mockClear();
    setActivePinia(createPinia());
    store = useTransferStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('add()', () => {
    it('creates a transfer with correct initial state', () => {
      const id = store.add('upload', 'test.txt', 1024);
      const t = store.transfers.get(id);

      expect(t).toBeDefined();
      expect(t.direction).toBe('upload');
      expect(t.filename).toBe('test.txt');
      expect(t.totalBytes).toBe(1024);
      expect(t.transferredBytes).toBe(0);
      expect(t.percentage).toBe(0);
      expect(t.status).toBe('active');
      expect(t.statusText).toBeNull();
      expect(t.error).toBeNull();
      expect(t.abortController).toBeInstanceOf(AbortController);
    });

    it('accepts an optional statusText', () => {
      const id = store.add('download', 'archive.zip', 0, 'Preparing zip…');
      const t = store.transfers.get(id);
      expect(t.statusText).toBe('Preparing zip…');
    });

    it('generates unique IDs', () => {
      const id1 = store.add('upload', 'a.txt', 100);
      const id2 = store.add('upload', 'b.txt', 200);
      expect(id1).not.toBe(id2);
    });

    it('increases transfer count', () => {
      expect(store.transfers.size).toBe(0);
      store.add('upload', 'a.txt', 100);
      expect(store.transfers.size).toBe(1);
      store.add('download', 'b.txt', 200);
      expect(store.transfers.size).toBe(2);
    });
  });

  describe('updateProgress()', () => {
    it('updates transferred bytes and percentage', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.updateProgress(id, 500, 1000);

      const t = store.transfers.get(id);
      expect(t.transferredBytes).toBe(500);
      expect(t.percentage).toBe(50);
    });

    it('updates totalBytes when provided', () => {
      const id = store.add('download', 'test.txt', 0);
      store.updateProgress(id, 100, 2000);

      const t = store.transfers.get(id);
      expect(t.totalBytes).toBe(2000);
    });

    it('clears statusText on first progress update', () => {
      const id = store.add('download', 'archive.zip', 0, 'Preparing zip…');
      expect(store.transfers.get(id).statusText).toBe('Preparing zip…');

      store.updateProgress(id, 100, 5000);
      expect(store.transfers.get(id).statusText).toBeNull();
    });

    it('does not clear statusText when transferredBytes is 0', () => {
      const id = store.add('download', 'archive.zip', 0, 'Preparing zip…');
      store.updateProgress(id, 0, 5000);
      expect(store.transfers.get(id).statusText).toBe('Preparing zip…');
    });

    it('is a no-op for unknown ID', () => {
      expect(() => store.updateProgress('nonexistent', 100, 200)).not.toThrow();
    });

    it('computes percentage as 0 when totalBytes is 0', () => {
      const id = store.add('upload', 'test.txt', 0);
      store.updateProgress(id, 50);
      expect(store.transfers.get(id).percentage).toBe(0);
    });
  });

  describe('complete()', () => {
    it('sets status to complete and percentage to 100', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.updateProgress(id, 500, 1000);
      store.complete(id);

      const t = store.transfers.get(id);
      expect(t.status).toBe('complete');
      expect(t.percentage).toBe(100);
      expect(t.transferredBytes).toBe(1000);
    });

    it('fires a success notification', () => {
      const id = store.add('upload', 'photo.jpg', 5000);
      store.complete(id);

      expect(mockAddNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          heading: 'photo.jpg uploaded',
        })
      );
    });

    it('fires correct verb for downloads', () => {
      const id = store.add('download', 'report.pdf', 5000);
      store.complete(id);

      expect(mockAddNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          heading: 'report.pdf downloaded',
        })
      );
    });

    it('auto-removes transfer after linger period', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.complete(id);

      // Still present immediately
      expect(store.transfers.has(id)).toBe(true);

      // Gone after 2 seconds
      vi.advanceTimersByTime(2000);
      expect(store.transfers.has(id)).toBe(false);
    });

    it('is a no-op for unknown ID', () => {
      expect(() => store.complete('nonexistent')).not.toThrow();
    });
  });

  describe('fail()', () => {
    it('sets status to error with message', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.fail(id, 'Network timeout');

      const t = store.transfers.get(id);
      expect(t.status).toBe('error');
      expect(t.error).toBe('Network timeout');
    });

    it('accepts an Error object', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.fail(id, new Error('Chunk upload failed: 500'));

      expect(store.transfers.get(id).error).toBe('Chunk upload failed: 500');
    });

    it('fires an error notification', () => {
      const id = store.add('download', 'data.zip', 5000);
      store.fail(id, 'Server error');

      expect(mockAddNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          heading: 'Download failed: data.zip',
          body: 'Server error',
        })
      );
    });

    it('auto-removes transfer after linger period', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.fail(id, 'error');

      expect(store.transfers.has(id)).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(store.transfers.has(id)).toBe(false);
    });

    it('is a no-op for unknown ID', () => {
      expect(() => store.fail('nonexistent', 'error')).not.toThrow();
    });
  });

  describe('cancel()', () => {
    it('aborts the controller and removes the transfer', () => {
      const id = store.add('upload', 'test.txt', 1000);
      const signal = store.transfers.get(id).abortController.signal;

      expect(signal.aborted).toBe(false);
      store.cancel(id);
      expect(signal.aborted).toBe(true);
      expect(store.transfers.has(id)).toBe(false);
    });

    it('is a no-op for unknown ID', () => {
      expect(() => store.cancel('nonexistent')).not.toThrow();
    });
  });

  describe('remove()', () => {
    it('removes a transfer immediately', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.remove(id);
      expect(store.transfers.has(id)).toBe(false);
    });

    it('clears linger timer if one was scheduled', () => {
      const id = store.add('upload', 'test.txt', 1000);
      store.complete(id); // schedules linger timer

      // Manually remove before linger expires
      store.remove(id);
      expect(store.transfers.has(id)).toBe(false);

      // Advancing time should not cause errors
      vi.advanceTimersByTime(3000);
    });
  });

  describe('clearCompleted()', () => {
    it('removes all complete and error transfers', () => {
      const id1 = store.add('upload', 'a.txt', 100);
      const id2 = store.add('upload', 'b.txt', 200);
      const id3 = store.add('download', 'c.txt', 300);

      store.complete(id1);
      store.fail(id2, 'error');
      // id3 stays active

      store.clearCompleted();

      expect(store.transfers.has(id1)).toBe(false);
      expect(store.transfers.has(id2)).toBe(false);
      expect(store.transfers.has(id3)).toBe(true);
    });

    it('is a no-op when there are no completed transfers', () => {
      store.add('upload', 'a.txt', 100);
      const sizeBefore = store.transfers.size;
      store.clearCompleted();
      expect(store.transfers.size).toBe(sizeBefore);
    });
  });

  describe('computed properties', () => {
    it('hasActive is true when at least one transfer is active', () => {
      expect(store.hasActive).toBe(false);
      const id = store.add('upload', 'test.txt', 1000);
      expect(store.hasActive).toBe(true);
      store.complete(id);
      expect(store.hasActive).toBe(false);
    });

    it('visible is true when there are any transfers', () => {
      expect(store.visible).toBe(false);
      const id = store.add('upload', 'test.txt', 1000);
      expect(store.visible).toBe(true);
      store.remove(id);
      expect(store.visible).toBe(false);
    });

    it('counts tracks active, complete, and failed', () => {
      expect(store.counts).toEqual({ active: 0, complete: 0, failed: 0, total: 0 });

      const id1 = store.add('upload', 'a.txt', 100);
      store.add('download', 'b.txt', 200);

      expect(store.counts.active).toBe(2);

      store.complete(id1);
      expect(store.counts).toEqual({ active: 1, complete: 1, failed: 0, total: 2 });
    });

    it('overallProgress computes weighted percentage', () => {
      const id1 = store.add('upload', 'a.txt', 1000);
      const id2 = store.add('upload', 'b.txt', 1000);

      store.updateProgress(id1, 500, 1000);
      store.updateProgress(id2, 500, 1000);

      // 1000 of 2000 bytes = 50%
      expect(store.overallProgress).toBe(50);
    });

    it('overallProgress is 0 when no transfers', () => {
      expect(store.overallProgress).toBe(0);
    });
  });
});

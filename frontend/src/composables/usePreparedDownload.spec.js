import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The order the steps are in.
 *
 * Asking the server to prepare the archive is what counts the download, so
 * whatever can still end in nothing — the save picker — comes before it. And an
 * archive nobody is going to take is given up, so it does not sit in the
 * server's temp directory until it expires.
 */

const m = vi.hoisted(() => ({
  prepareDownload: vi.fn(),
  cancelPreparedDownload: vi.fn(),
  canChooseSaveFile: vi.fn(),
  chooseSaveFile: vi.fn(),
  awaitFirstRange: vi.fn(),
  writePreparedToFile: vi.fn(),
  handPreparedToBrowser: vi.fn(),
  addNotification: vi.fn(),
  startOperation: vi.fn(),
  updateOperation: vi.fn(),
  finishOperation: vi.fn(),
}));

vi.mock('@/api', () => ({
  prepareDownload: (...a) => m.prepareDownload(...a),
  cancelPreparedDownload: (...a) => m.cancelPreparedDownload(...a),
}));
vi.mock('@/i18n', () => ({ default: { global: { t: (key) => key } } }));
vi.mock('@/stores/notifications', () => ({
  useNotificationsStore: () => ({ addNotification: m.addNotification }),
}));
vi.mock('@/stores/operationTasks', () => ({
  useOperationTasksStore: () => ({
    startOperation: m.startOperation,
    updateOperation: m.updateOperation,
    finishOperation: m.finishOperation,
  }),
}));
vi.mock('@/composables/preparedDownloads', () => ({
  canChooseSaveFile: (...a) => m.canChooseSaveFile(...a),
  chooseSaveFile: (...a) => m.chooseSaveFile(...a),
  awaitFirstRange: (...a) => m.awaitFirstRange(...a),
  writePreparedToFile: (...a) => m.writePreparedToFile(...a),
  handPreparedToBrowser: (...a) => m.handPreparedToBrowser(...a),
}));

import { usePreparedDownload } from './usePreparedDownload';

const ask = { paths: ['Docs/Photos'], basePath: 'Docs', name: 'Photos.zip', itemCount: 1 };
const FIRST = { whole: false, total: 100, buffer: new ArrayBuffer(10) };
const handle = () => ({ name: 'Photos.zip', remove: vi.fn(async () => {}) });

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.startOperation.mockReturnValue('op-1');
  m.prepareDownload.mockResolvedValue({ id: 'abc', name: 'Photos.zip' });
  m.awaitFirstRange.mockResolvedValue(FIRST);
  m.writePreparedToFile.mockResolvedValue({ writtenBytes: 100 });
  m.cancelPreparedDownload.mockResolvedValue(null);
  m.canChooseSaveFile.mockReturnValue(false);
});

describe('where there is no save picker', () => {
  it('waits for the archive and hands it to the browser, without removing it', async () => {
    const outcome = await usePreparedDownload().run(ask);

    expect(outcome).toBe('handed-off');
    expect(m.prepareDownload).toHaveBeenCalledWith(['Docs/Photos'], 'Docs', expect.any(Object));
    expect(m.handPreparedToBrowser).toHaveBeenCalledWith({ id: 'abc', name: 'Photos.zip' });
    // The browser has yet to fetch it.
    expect(m.cancelPreparedDownload).not.toHaveBeenCalled();
    expect(m.finishOperation).toHaveBeenCalledWith('op-1');
    // Nothing is claimed about a download this application cannot see.
    expect(m.addNotification).not.toHaveBeenCalled();
  });

  it('shows the build moving while it waits', async () => {
    m.awaitFirstRange.mockImplementation(async ({ onBuilding }) => {
      onBuilding(40);
      return FIRST;
    });

    await usePreparedDownload().run(ask);

    expect(m.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'download', preparing: true })
    );
    expect(m.updateOperation).toHaveBeenCalledWith('op-1', { percent: 40 });
  });
});

describe('where the reader can say where it goes', () => {
  beforeEach(() => m.canChooseSaveFile.mockReturnValue(true));

  it('asks where before asking the server for anything', async () => {
    const order = [];
    m.chooseSaveFile.mockImplementation(async () => {
      order.push('picker');
      return handle();
    });
    m.prepareDownload.mockImplementation(async () => {
      order.push('prepare');
      return { id: 'abc', name: 'Photos.zip' };
    });

    await usePreparedDownload().run(ask);

    expect(order).toEqual(['picker', 'prepare']);
  });

  it('prepares nothing when the reader closes the picker', async () => {
    m.chooseSaveFile.mockResolvedValue(null);

    expect(await usePreparedDownload().run(ask)).toBe('cancelled');
    expect(m.prepareDownload).not.toHaveBeenCalled();
    expect(m.startOperation).not.toHaveBeenCalled();
  });

  it('goes the other way when the picker would not open', async () => {
    m.chooseSaveFile.mockRejectedValue(Object.assign(new Error('no'), { name: 'SecurityError' }));

    expect(await usePreparedDownload().run(ask)).toBe('handed-off');
    expect(m.handPreparedToBrowser).toHaveBeenCalled();
  });

  it('writes the archive, says so, and gives the server its temp file back', async () => {
    const file = handle();
    m.chooseSaveFile.mockResolvedValue(file);
    m.writePreparedToFile.mockImplementation(async ({ onProgress }) => {
      onProgress(50, 100);
      return { writtenBytes: 100 };
    });

    expect(await usePreparedDownload().run(ask)).toBe('done');

    expect(m.updateOperation).toHaveBeenCalledWith(
      'op-1',
      expect.objectContaining({ preparing: false, totalBytes: 100 })
    );
    expect(m.updateOperation).toHaveBeenCalledWith('op-1', { copiedBytes: 50 });
    expect(m.addNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(m.cancelPreparedDownload).toHaveBeenCalledWith('abc');
    expect(file.remove).not.toHaveBeenCalled();
  });

  it('reports a refusal once, and leaves no empty file behind', async () => {
    const file = handle();
    m.chooseSaveFile.mockResolvedValue(file);
    m.awaitFirstRange.mockRejectedValue(
      Object.assign(new Error('larger than the 20 GB limit'), { statusCode: 413 })
    );

    expect(await usePreparedDownload().run(ask)).toBe('failed');

    expect(m.addNotification).toHaveBeenCalledTimes(1);
    expect(m.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', body: 'larger than the 20 GB limit' })
    );
    expect(file.remove).toHaveBeenCalled();
    expect(m.cancelPreparedDownload).toHaveBeenCalledWith('abc');
    expect(m.finishOperation).toHaveBeenCalledWith('op-1');
  });

  it('says nothing when the reader cancelled, and gives the archive up', async () => {
    m.chooseSaveFile.mockResolvedValue(handle());
    m.awaitFirstRange.mockImplementation(async ({ signal }) => {
      // The cancel button the transfers panel was given.
      m.startOperation.mock.calls[0][0].cancel();
      expect(signal.aborted).toBe(true);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    expect(await usePreparedDownload().run(ask)).toBe('cancelled');
    expect(m.addNotification).not.toHaveBeenCalled();
    expect(m.cancelPreparedDownload).toHaveBeenCalledWith('abc');
  });
});

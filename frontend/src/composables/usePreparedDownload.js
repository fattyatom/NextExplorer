import i18n from '@/i18n';
import { cancelPreparedDownload, prepareDownload } from '@/api';
import { useNotificationsStore } from '@/stores/notifications';
import { useOperationTasksStore } from '@/stores/operationTasks';
import {
  awaitFirstRange,
  canChooseSaveFile,
  chooseSaveFile,
  handPreparedToBrowser,
  writePreparedToFile,
} from '@/composables/preparedDownloads';

/**
 * Downloading a folder or a selection as one zip, from the click to the last byte.
 *
 * The zip is made by the server out of sight and fetched once it exists, so no
 * request is held open while it is built — which is what a proxy with a
 * deadline on the first byte needs, and what the form this replaces could not
 * give it.
 *
 * The order of the steps matters. The save picker comes first, while the click
 * is still fresh enough for the browser to open one. Asking the server to
 * prepare the archive is what counts the download, so it comes only after the
 * reader has not backed out.
 */
export function usePreparedDownload() {
  const notifications = useNotificationsStore();
  const operationTasks = useOperationTasksStore();

  /**
   * @returns {'done'|'handed-off'|'cancelled'|'failed'} — 'handed-off' is a zip
   * given to the browser's own downloads, which is as much as can be known
   * about it from here.
   */
  const run = async ({ paths, basePath = '', name = 'download.zip', itemCount = 1 } = {}) => {
    if (!Array.isArray(paths) || paths.length === 0) return 'cancelled';
    const { t } = i18n.global;

    // Closing the picker and the picker refusing to open are not the same
    // answer: the first stops here, the second leaves the other way, which works.
    let fileHandle = null;
    if (canChooseSaveFile()) {
      let closedIt = false;
      try {
        fileHandle = await chooseSaveFile(name);
        closedIt = fileHandle === null;
      } catch (_) {
        fileHandle = null;
      }
      if (closedIt) return 'cancelled';
    }

    const controller = new AbortController();
    let preparedId = null;
    let saved = false;
    const operationId = operationTasks.startOperation({
      type: 'download',
      preparing: true,
      itemCount,
      name,
      percent: 0,
      cancellable: true,
      cancel: () => controller.abort(),
    });

    try {
      // Every refusal on the way is reported once, below, in the same words.
      const prepared = await prepareDownload(paths, basePath, {
        signal: controller.signal,
        suppressErrorHandler: true,
      });
      if (!prepared?.id) throw new Error('The server did not prepare the download.');
      preparedId = prepared.id;
      const zipName = prepared.name || name;

      const first = await awaitFirstRange({
        id: preparedId,
        signal: controller.signal,
        // With a file to write, the bar is for the bytes; without one, the
        // build is the only thing there is to show.
        onBuilding: (percent) => operationTasks.updateOperation(operationId, { percent }),
        ...(fileHandle ? {} : { rangeBytes: 1 }),
      });

      if (!fileHandle) {
        // Not removed: the browser is about to ask for it. The server lets it
        // go by itself once nobody is reading it any more.
        handPreparedToBrowser({ id: preparedId, name: zipName });
        preparedId = null;
        return 'handed-off';
      }

      operationTasks.updateOperation(operationId, {
        preparing: false,
        percent: null,
        totalBytes: first.whole ? first.buffer.byteLength : first.total || 0,
        copiedBytes: 0,
      });

      await writePreparedToFile({
        id: preparedId,
        first,
        fileHandle,
        signal: controller.signal,
        onProgress: (writtenBytes) =>
          operationTasks.updateOperation(operationId, { copiedBytes: writtenBytes }),
      });

      saved = true;
      notifications.addNotification({
        type: 'success',
        heading: t('download.saved', { name: fileHandle.name || zipName }),
      });
      return 'done';
    } catch (error) {
      // The picker made the file the moment it was chosen. An empty zip left
      // behind would look like a download that worked.
      if (fileHandle && !saved) await fileHandle.remove?.().catch(() => {});
      if (controller.signal.aborted || error?.name === 'AbortError') return 'cancelled';

      notifications.addNotification({
        type: 'error',
        heading: t('download.failed'),
        body: error?.message || '',
      });
      return 'failed';
    } finally {
      operationTasks.finishOperation(operationId);
      if (preparedId) cancelPreparedDownload(preparedId);
    }
  };

  return { run };
}

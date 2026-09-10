import { computed } from 'vue';
import { useFileStore } from '@/stores/fileStore';
import { normalizePath } from '@/api';
import { download, streamZipDownload } from '@/utils/chunkedDownload';
import { useTransferStore } from '@/stores/transferStore';
import { useAppSettings } from '@/stores/appSettings';

function isEditableElement(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

function resolveItemPath(item) {
  if (!item || !item.name) return '';
  const parent = normalizePath(item.path || '');
  const combined = parent ? `${parent}/${item.name}` : item.name;
  return normalizePath(combined);
}

export function useFileActions() {
  const fileStore = useFileStore();

  const selectedItems = computed(() => fileStore.selectedItems);
  const hasSelection = computed(() => fileStore.hasSelection);
  const isSingleItemSelected = computed(() => selectedItems.value.length === 1);
  const primaryItem = computed(() => selectedItems.value[0] ?? null);

  const locationCanWrite = computed(() => fileStore.currentPathData?.canWrite ?? true);
  const locationCanUpload = computed(() => fileStore.currentPathData?.canUpload ?? true);
  const locationCanDelete = computed(() => fileStore.currentPathData?.canDelete ?? true);
  const locationCanDownload = computed(() => fileStore.currentPathData?.canDownload ?? true);
  const currentDirectoryPath = computed(() => normalizePath(fileStore.getCurrentPath || ''));
  const currentPathIsDirectory = computed(() => fileStore.currentPathData?.isDirectory === true);
  const isSharePath = computed(() => currentDirectoryPath.value.startsWith('share/'));

  const isZipSelected = computed(() => {
    if (!isSingleItemSelected.value || !primaryItem.value) return false;
    const kind = String(primaryItem.value.kind || '').toLowerCase();
    if (kind === 'zip') return true;
    const name = String(primaryItem.value.name || '').toLowerCase();
    return name.endsWith('.zip');
  });

  const selectionHasUniformParent = computed(() => {
    if (!hasSelection.value) return false;
    const parents = new Set(
      selectedItems.value.map((item) => normalizePath(item?.path || '')).filter(Boolean)
    );
    if (parents.size === 1) return true;
    // Special case: items in the root of a volume have empty parent path ("")
    const rawParents = new Set(selectedItems.value.map((item) => normalizePath(item?.path || '')));
    return rawParents.size === 1;
  });

  const canCut = computed(
    () => hasSelection.value && locationCanWrite.value && locationCanDelete.value
  );
  const canCopy = computed(() => hasSelection.value);
  const canPaste = computed(
    () => fileStore.hasClipboardItems && (locationCanWrite.value || locationCanUpload.value)
  );
  const canDelete = computed(() => hasSelection.value && locationCanDelete.value);
  const canRename = computed(
    () =>
      isSingleItemSelected.value && primaryItem.value?.kind !== 'volume' && locationCanWrite.value
  );
  const canExtractZip = computed(
    () => isZipSelected.value && locationCanWrite.value && primaryItem.value?.kind !== 'volume'
  );
  const canCompressToZip = computed(
    () =>
      hasSelection.value &&
      locationCanWrite.value &&
      selectionHasUniformParent.value &&
      selectedItems.value.every((item) => item?.kind !== 'volume')
  );
  const canDownloadCurrentFolder = computed(
    () =>
      isSharePath.value &&
      locationCanDownload.value &&
      currentPathIsDirectory.value &&
      Boolean(currentDirectoryPath.value)
  );

  const isCutActive = computed(() => fileStore.cutItems.length > 0);
  const isCopyActive = computed(() => fileStore.copiedItems.length > 0);

  const runCut = () => {
    if (canCut.value) fileStore.cut();
  };
  const runCopy = () => {
    if (canCopy.value) fileStore.copy();
  };
  const runPasteToDestination = async (destinationPath) => {
    if (!canPaste.value) return;
    const dest = typeof destinationPath === 'string' ? destinationPath : '';
    await fileStore.paste(dest || undefined);
  };
  const runPasteIntoCurrent = async () => runPasteToDestination('');

  const runRename = () => {
    if (!canRename.value || !primaryItem.value) return;
    fileStore.beginRename(primaryItem.value);
  };

  const runExtractZip = async () => {
    if (!canExtractZip.value || !primaryItem.value) return;
    const zipPath = resolveItemPath(primaryItem.value);
    if (!zipPath) return;
    await fileStore.extractZipArchive(zipPath);
  };

  const runCompressToZip = async () => {
    if (!canCompressToZip.value) return;
    await fileStore.compressSelectionToZip();
  };

  const deleteNow = async () => {
    if (!canDelete.value) return;
    await fileStore.del();
  };

  const trackedDownload = async (name, size, downloadFn, statusText) => {
    const store = useTransferStore();
    const id = store.add('download', name, size || 0, statusText);
    try {
      const t = store.transfers.get(id);
      const result = await downloadFn(
        (downloaded, total) => store.updateProgress(id, downloaded, total),
        t?.abortController?.signal,
        (text) => store.updateStatus(id, text)
      );
      if (result === 'native-handoff') {
        // Browser's download manager owns the transfer now — show an honest
        // terminal state instead of a misleading "downloaded" message.
        store.handoff(id);
      } else {
        store.complete(id);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      store.fail(id, err.message || 'Download failed');
    }
  };

  const submitDownloadRequest = async (paths, basePath = '') => {
    if (!paths.length) return;

    const currentPath = normalizePath(basePath || '');
    const zipName =
      paths.length === 1
        ? `${paths[0].split('/').filter(Boolean).pop() || 'download'}.zip`
        : 'download.zip';

    // Mirror the upload path: chunk size + enable toggle come from app settings.
    const ct = useAppSettings().systemSettings?.chunkedTransfers;
    const chunkedEnabled = ct?.downloadEnabled !== false;
    const chunkSize = ct?.chunkSizeMB ? ct.chunkSizeMB * 1024 * 1024 : undefined;

    await trackedDownload(zipName, 0, (onProgress, signal, onStatus) =>
      streamZipDownload({
        paths,
        basePath: currentPath,
        filename: zipName,
        chunkSize,
        chunkedEnabled,
        onProgress,
        onStatus,
        signal,
      })
    , 'Preparing zip…');
  };

  const runDownload = async () => {
    if (!hasSelection.value) return;

    const items = selectedItems.value;

    // A lone file needs no zip — stream it straight through, so the transfer
    // reports the real size instead of an archive built for one entry.
    const isSingleFile =
      items.length === 1 && items[0].kind !== 'directory' && items[0].kind !== 'volume';

    if (isSingleFile) {
      const item = items[0];
      const filePath = resolveItemPath(item);
      if (!filePath) return;

      await trackedDownload(item.name, item.size, (onProgress, signal) =>
        download({ path: filePath, filename: item.name, size: item.size, onProgress, signal })
      );
      return;
    }

    const paths = items.map(resolveItemPath).filter(Boolean);
    await submitDownloadRequest(paths, currentDirectoryPath.value);
  };

  const runDownloadCurrentFolder = () => {
    if (!canDownloadCurrentFolder.value) return;
    submitDownloadRequest([currentDirectoryPath.value], currentDirectoryPath.value);
  };

  return {
    // state
    selectedItems,
    primaryItem,
    isSingleItemSelected,
    // guards
    hasSelection,
    locationCanWrite,
    locationCanUpload,
    locationCanDelete,
    locationCanDownload,
    canCut,
    canCopy,
    canPaste,
    canDelete,
    canRename,
    canExtractZip,
    canCompressToZip,
    canDownloadCurrentFolder,
    isCutActive,
    isCopyActive,
    // helpers
    resolveItemPath,
    isEditableElement,
    // actions
    runCut,
    runCopy,
    runPasteToDestination,
    runPasteIntoCurrent,
    runRename,
    runExtractZip,
    runCompressToZip,
    deleteNow,
    runDownload,
    runDownloadCurrentFolder,
  };
}

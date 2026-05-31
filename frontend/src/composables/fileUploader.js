import { ref, onMounted, onBeforeUnmount, markRaw } from 'vue';
import Uppy from '@uppy/core';
import XHRUpload from '@uppy/xhr-upload';
import { useUppyStore } from '@/stores/uppyStore';
import { useFileStore } from '@/stores/fileStore';
import { useNotificationsStore } from '@/stores/notifications';
import { useTransferStore } from '@/stores/transferStore';
import { apiBase, normalizePath } from '@/api';
import { isDisallowedUpload } from '@/utils/uploads';
import { chunkedUpload } from '@/utils/chunkedUpload';
import { CHUNKED_TRANSFER_THRESHOLD } from '@/utils/chunkedTransfer';
import DropTarget from '@uppy/drop-target';

export function useFileUploader() {
  const uppyStore = useUppyStore();
  const fileStore = useFileStore();
  const notificationsStore = useNotificationsStore();
  const transferStore = useTransferStore();
  const inputRef = ref(null);
  const files = ref([]);

  const uppyToTransferId = new Map();

  let lastNotifyAt = 0;
  let lastNotifyHeading = '';

  const canUploadToCurrentPath = () => {
    const access = fileStore.currentPathData;
    if (!access) {
      return !String(fileStore.currentPath || '').startsWith('share/');
    }
    return access.canUpload !== false;
  };

  const uploadBlockedMessage = () => {
    const access = fileStore.currentPathData;
    if (!access && String(fileStore.currentPath || '').startsWith('share/')) {
      return 'Share is still loading. Please try again in a moment.';
    }
    if (access?.shareInfo?.accessMode === 'readonly') {
      return 'This share is read-only. Uploads are disabled.';
    }
    return 'You do not have permission to upload to this location.';
  };

  const notifyErrorOnce = (heading, extra = {}) => {
    const now = Date.now();
    if (heading === lastNotifyHeading && now - lastNotifyAt < 1500) return;
    lastNotifyAt = now;
    lastNotifyHeading = heading;
    notificationsStore.addNotification({ type: 'error', heading, ...extra });
  };

  async function handleChunkedUpload(rawFile) {
    const uploadTo = normalizePath(fileStore.currentPath || '');
    const relativePath =
      rawFile.webkitRelativePath || rawFile.name;
    const id = transferStore.add('upload', rawFile.name, rawFile.size);

    try {
      const t = transferStore.transfers.get(id);
      await chunkedUpload(
        rawFile,
        uploadTo,
        relativePath,
        (uploaded, total) => transferStore.updateProgress(id, uploaded, total),
        t?.abortController?.signal
      );
      transferStore.complete(id);
      fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
    } catch (err) {
      if (err.name === 'AbortError') return;
      transferStore.fail(id, err.message || 'Upload failed');
    }
  }

  let uppy = uppyStore.uppy;
  const createdHere = ref(false);

  if (!uppy) {
    uppy = new Uppy({
      debug: true,
      autoProceed: true,
      store: uppyStore,
    });

    uppy.use(XHRUpload, {
      endpoint: `${apiBase}/api/upload`,
      formData: true,
      fieldName: 'filedata',
      bundle: false,
      responseType: 'json',
      allowedMetaFields: true,
      withCredentials: true,
    });

    uppy.on('file-added', (file) => {
      if (!canUploadToCurrentPath()) {
        uppy.removeFile?.(file.id);
        notifyErrorOnce(uploadBlockedMessage(), { durationMs: 5000 });
        return;
      }

      if (isDisallowedUpload(file?.name)) {
        uppy.removeFile?.(file.id);
        return;
      }

      const rawFile = file?.data;
      if (rawFile && rawFile.size > CHUNKED_TRANSFER_THRESHOLD) {
        uppy.removeFile?.(file.id);
        handleChunkedUpload(rawFile);
        return;
      }

      const inferredRelativePath =
        file?.meta?.relativePath ||
        file?.data?.webkitRelativePath ||
        file?.name ||
        (file?.data && file?.data.name) ||
        '';

      if (!file?.name && file?.data?.name && typeof uppy.setFileName === 'function') {
        try {
          uppy.setFileName(file.id, file.data.name);
        } catch (_) {
          /* noop */
        }
      }

      uppy.setFileMeta(file.id, {
        uploadTo: normalizePath(fileStore.currentPath || ''),
        relativePath: inferredRelativePath,
      });

      const tid = transferStore.add('upload', file.name || rawFile?.name || 'file', rawFile?.size || 0);
      uppyToTransferId.set(file.id, tid);
    });

    uppy.on('upload-progress', (file, progress) => {
      const tid = uppyToTransferId.get(file?.id);
      if (tid && progress) {
        transferStore.updateProgress(tid, progress.bytesUploaded || 0, progress.bytesTotal || 0);
      }
    });

    uppy.on('upload', (_uploadID, batchFiles) => {
      const current = normalizePath(fileStore.currentPath || '');
      const batchList = Array.isArray(batchFiles) ? batchFiles : [];
      const targetsCurrentPath =
        batchList.length > 0 &&
        batchList.every((f) => normalizePath(f?.meta?.uploadTo || '') === current);

      if (!targetsCurrentPath) return;
      if (canUploadToCurrentPath()) return;

      try {
        uppy.cancelAll?.();
      } catch (_) {
        /* noop */
      }
      notifyErrorOnce(uploadBlockedMessage(), { durationMs: 5000 });
    });

    uppy.on('upload-success', (file) => {
      const tid = uppyToTransferId.get(file?.id);
      if (tid) {
        transferStore.complete(tid);
        uppyToTransferId.delete(file?.id);
      }
      fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
    });

    uppy.on('upload-error', (file, error, response) => {
      const tid = uppyToTransferId.get(file?.id);
      if (tid) {
        const body = response?.body;
        const nested = body && typeof body === 'object' ? body?.error : null;
        const msg = (nested && typeof nested === 'object' ? nested.message : nested) || error?.message || 'Upload failed';
        transferStore.fail(tid, msg);
        uppyToTransferId.delete(file?.id);
      } else {
        const body = response?.body;
        const nested = body && typeof body === 'object' ? body?.error : null;
        const heading =
          (nested && typeof nested === 'object' ? nested.message : nested) ||
          error?.message ||
          'Upload failed';
        notifyErrorOnce(heading);
      }
      if (fileStore.currentPath) {
        fileStore.fetchPathItems(fileStore.currentPath).catch(() => {});
      }
    });

    uppy.on('error', (error) => {
      const message = error?.message || 'Upload error';
      notifyErrorOnce(message);
    });

    uppyStore.uppy = markRaw(uppy);
    createdHere.value = true;
  }

  function uppyFile(file) {
    return {
      name: file.name,
      type: file.type,
      data: file,
    };
  }

  function setDialogAttributes(options) {
    inputRef.value.accept = options.accept;
    inputRef.value.multiple = options.multiple;
    inputRef.value.webkitdirectory = !!options.directory;
    inputRef.value.directory = !!options.directory;
    inputRef.value.mozdirectory = !!options.directory;
  }

  function openDialog(opts) {
    const defaultDialogOptions = {
      multiple: true,
      accept: '*',
    };

    if (!canUploadToCurrentPath()) {
      notifyErrorOnce(uploadBlockedMessage(), { durationMs: 5000 });
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      if (!inputRef.value) {
        notificationsStore.addNotification({
          type: 'error',
          heading: 'File picker is not ready yet. Please try again.',
          durationMs: 3000,
        });
        resolve();
        return;
      }

      files.value = [];
      const options = { ...defaultDialogOptions, ...opts };

      setDialogAttributes(options);

      inputRef.value.onchange = (e) => {
        const selectedFiles = Array.from(e.target.files || []).filter(
          (file) => !isDisallowedUpload(file.name)
        );

        files.value = selectedFiles.map((file) => uppyFile(file));
        files.value.forEach((file) => uppy.addFile(file));

        e.target.value = '';
        resolve();
      };

      inputRef.value.click();
    });
  }

  onMounted(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'hidden';
    document.body.appendChild(input);
    inputRef.value = input;
  });

  onBeforeUnmount(() => {
    inputRef.value?.remove();
    if (createdHere.value) {
      uppy.destroy?.();
      uppy.close?.();
      if (uppyStore.uppy === uppy) {
        uppyStore.uppy = null;
      }
    }
  });

  return {
    files,
    openDialog,
  };
}

export function useUppyDropTarget(targetRef) {
  const uppyStore = useUppyStore();

  onMounted(() => {
    const el = targetRef && 'value' in targetRef ? targetRef.value : null;
    const uppy = uppyStore.uppy;
    if (el && uppy) {
      try {
        const existing = uppy.getPlugin && uppy.getPlugin('DropTarget');
        if (existing) uppy.removePlugin(existing);
        uppy.use(DropTarget, { target: el });
      } catch (_) {
        // ignore if plugin cannot be mounted
      }
    }
  });

  onBeforeUnmount(() => {
    const uppy = uppyStore.uppy;
    if (uppy) {
      const plugin = uppy.getPlugin && uppy.getPlugin('DropTarget');
      if (plugin) uppy.removePlugin(plugin);
    }
  });
}

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useDownloadProgressStore = defineStore('downloadProgress', () => {
  const downloads = ref(new Map());

  const activeDownloads = computed(() =>
    Array.from(downloads.value.values()).filter((d) => d.status === 'active')
  );

  const hasActive = computed(() => activeDownloads.value.length > 0);

  function start(id, filename, totalBytes) {
    downloads.value.set(id, {
      id,
      filename,
      totalBytes,
      downloadedBytes: 0,
      percentage: 0,
      status: 'active',
      abortController: new AbortController(),
    });
    downloads.value = new Map(downloads.value);
  }

  function updateProgress(id, downloadedBytes, totalBytes) {
    const dl = downloads.value.get(id);
    if (!dl) return;
    dl.downloadedBytes = downloadedBytes;
    dl.totalBytes = totalBytes;
    dl.percentage = Math.round((downloadedBytes / totalBytes) * 100);
    downloads.value = new Map(downloads.value);
  }

  function complete(id) {
    const dl = downloads.value.get(id);
    if (!dl) return;
    dl.status = 'complete';
    dl.percentage = 100;
    downloads.value = new Map(downloads.value);
    setTimeout(() => remove(id), 3000);
  }

  function fail(id, error) {
    const dl = downloads.value.get(id);
    if (!dl) return;
    dl.status = 'error';
    dl.error = error;
    downloads.value = new Map(downloads.value);
  }

  function cancel(id) {
    const dl = downloads.value.get(id);
    if (!dl) return;
    dl.abortController.abort();
    remove(id);
  }

  function remove(id) {
    downloads.value.delete(id);
    downloads.value = new Map(downloads.value);
  }

  return {
    downloads,
    activeDownloads,
    hasActive,
    start,
    updateProgress,
    complete,
    fail,
    cancel,
    remove,
  };
});

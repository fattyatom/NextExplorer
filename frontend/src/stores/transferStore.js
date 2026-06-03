import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useNotificationsStore } from './notifications';

const COMPLETED_LINGER_MS = 2000;

export const useTransferStore = defineStore('transfer', () => {
  const transfers = ref(new Map());
  const lingerTimers = new Map();

  const activeTransfers = computed(() =>
    Array.from(transfers.value.values()).filter(
      (t) => t.status === 'active' || t.status === 'complete' || t.status === 'error'
    )
  );

  const hasActive = computed(() =>
    Array.from(transfers.value.values()).some((t) => t.status === 'active')
  );

  const visible = computed(() => transfers.value.size > 0);

  const overallProgress = computed(() => {
    const items = Array.from(transfers.value.values()).filter(
      (t) => t.status === 'active' || t.status === 'complete'
    );
    if (items.length === 0) return 0;
    const totalBytes = items.reduce((s, t) => s + t.totalBytes, 0);
    const doneBytes = items.reduce((s, t) => s + t.transferredBytes, 0);
    return totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0;
  });

  const counts = computed(() => {
    let active = 0;
    let complete = 0;
    let failed = 0;
    for (const t of transfers.value.values()) {
      if (t.status === 'active') active++;
      else if (t.status === 'complete') complete++;
      else if (t.status === 'error') failed++;
    }
    return { active, complete, failed, total: active + complete + failed };
  });

  let nextId = 1;

  function generateId() {
    return `transfer-${nextId++}-${Date.now().toString(36)}`;
  }

  function scheduleRemoval(id) {
    if (lingerTimers.has(id)) clearTimeout(lingerTimers.get(id));
    lingerTimers.set(id, setTimeout(() => {
      lingerTimers.delete(id);
      transfers.value.delete(id);
      transfers.value = new Map(transfers.value);
    }, COMPLETED_LINGER_MS));
  }

  function add(direction, filename, totalBytes, statusText) {
    const id = generateId();
    const abortController = new AbortController();
    transfers.value.set(id, {
      id,
      direction,
      filename,
      totalBytes,
      transferredBytes: 0,
      percentage: 0,
      status: 'active',
      statusText: statusText || null,
      error: null,
      abortController,
    });
    transfers.value = new Map(transfers.value);
    return id;
  }

  function updateProgress(id, transferredBytes, totalBytes) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.transferredBytes = transferredBytes;
    if (totalBytes !== undefined) t.totalBytes = totalBytes;
    t.percentage = t.totalBytes > 0 ? Math.round((transferredBytes / t.totalBytes) * 100) : 0;
    if (t.statusText && transferredBytes > 0) t.statusText = null;
    transfers.value = new Map(transfers.value);
  }

  function updateStatus(id, statusText) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.statusText = statusText || null;
    transfers.value = new Map(transfers.value);
  }

  function complete(id) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.status = 'complete';
    t.percentage = 100;
    t.transferredBytes = t.totalBytes;
    transfers.value = new Map(transfers.value);

    const notifications = useNotificationsStore();
    const verb = t.direction === 'upload' ? 'uploaded' : 'downloaded';
    notifications.addNotification({
      type: 'success',
      heading: `${t.filename} ${verb}`,
      durationMs: 3000,
    });

    scheduleRemoval(id);
  }

  function fail(id, error) {
    const t = transfers.value.get(id);
    if (!t) return;

    const msg = typeof error === 'string' ? error : error?.message || 'Transfer failed';
    t.status = 'error';
    t.error = msg;
    transfers.value = new Map(transfers.value);

    const notifications = useNotificationsStore();
    const verb = t.direction === 'upload' ? 'Upload' : 'Download';
    notifications.addNotification({
      type: 'error',
      heading: `${verb} failed: ${t.filename}`,
      body: msg,
      durationMs: 5000,
    });

    scheduleRemoval(id);
  }

  function cancel(id) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.abortController.abort();
    remove(id);
  }

  function remove(id) {
    if (lingerTimers.has(id)) {
      clearTimeout(lingerTimers.get(id));
      lingerTimers.delete(id);
    }
    transfers.value.delete(id);
    transfers.value = new Map(transfers.value);
  }

  function clearCompleted() {
    for (const [id, t] of transfers.value) {
      if (t.status === 'complete' || t.status === 'error') {
        if (lingerTimers.has(id)) {
          clearTimeout(lingerTimers.get(id));
          lingerTimers.delete(id);
        }
        transfers.value.delete(id);
      }
    }
    transfers.value = new Map(transfers.value);
  }

  function onBeforeUnload(e) {
    if (hasActive.value) {
      e.preventDefault();
      e.returnValue = '';
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  return {
    transfers,
    activeTransfers,
    hasActive,
    visible,
    overallProgress,
    counts,
    add,
    updateProgress,
    updateStatus,
    complete,
    fail,
    cancel,
    remove,
    clearCompleted,
  };
});

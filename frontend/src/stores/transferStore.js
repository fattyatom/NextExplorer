import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useTransferStore = defineStore('transfer', () => {
  const transfers = ref(new Map());
  const panelCollapsed = ref(false);

  const activeTransfers = computed(() =>
    Array.from(transfers.value.values()).filter(
      (t) => t.status === 'active' || t.status === 'complete'
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

  function add(direction, filename, totalBytes) {
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
      error: null,
      abortController,
    });
    transfers.value = new Map(transfers.value);
    panelCollapsed.value = false;
    return id;
  }

  function updateProgress(id, transferredBytes, totalBytes) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.transferredBytes = transferredBytes;
    if (totalBytes !== undefined) t.totalBytes = totalBytes;
    t.percentage = t.totalBytes > 0 ? Math.round((transferredBytes / t.totalBytes) * 100) : 0;
    transfers.value = new Map(transfers.value);
  }

  function complete(id) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.status = 'complete';
    t.percentage = 100;
    t.transferredBytes = t.totalBytes;
    transfers.value = new Map(transfers.value);
  }

  function fail(id, error) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.status = 'error';
    t.error = typeof error === 'string' ? error : error?.message || 'Transfer failed';
    transfers.value = new Map(transfers.value);
  }

  function cancel(id) {
    const t = transfers.value.get(id);
    if (!t) return;
    t.abortController.abort();
    remove(id);
  }

  function remove(id) {
    transfers.value.delete(id);
    transfers.value = new Map(transfers.value);
  }

  function clearCompleted() {
    for (const [id, t] of transfers.value) {
      if (t.status === 'complete' || t.status === 'error') {
        transfers.value.delete(id);
      }
    }
    transfers.value = new Map(transfers.value);
  }

  function toggleCollapse() {
    panelCollapsed.value = !panelCollapsed.value;
  }

  return {
    transfers,
    activeTransfers,
    hasActive,
    visible,
    overallProgress,
    counts,
    panelCollapsed,
    add,
    updateProgress,
    complete,
    fail,
    cancel,
    remove,
    clearCompleted,
    toggleCollapse,
  };
});

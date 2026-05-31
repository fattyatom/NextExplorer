<script setup>
import { ref, computed } from 'vue';
import { storeToRefs } from 'pinia';
import { onClickOutside } from '@vueuse/core';
import { TransitionRoot, TransitionChild } from '@headlessui/vue';
import {
  XMarkIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/vue/24/outline';
import { useNotificationsStore } from '@/stores/notifications';
import { useTransferStore } from '@/stores/transferStore';
import { formatBytes } from '@/utils';
import NotificationItem from './NotificationItem.vue';

const notificationsStore = useNotificationsStore();
const transferStore = useTransferStore();
const { isPanelOpen, filteredNotifications, filters } = storeToRefs(notificationsStore);
const { closePanel, clearAll, toggleFilter, copyNotification, removeNotification } =
  notificationsStore;

const activeTransfers = computed(() =>
  Array.from(transferStore.transfers.values())
);

// Filter chip data
const filterTypes = [
  {
    key: 'error',
    labelKey: 'notifications.filters.error',
    colorClass:
      'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400 border-red-200 dark:border-red-900/50',
  },
  {
    key: 'warning',
    labelKey: 'notifications.filters.warning',
    colorClass:
      'bg-amber-100 text-amber-800 dark:bg-amber-900/20 dark:text-amber-400 border-amber-200 dark:border-amber-900/50',
  },
  {
    key: 'success',
    labelKey: 'notifications.filters.success',
    colorClass:
      'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400 border-green-200 dark:border-green-900/50',
  },
  {
    key: 'info',
    labelKey: 'notifications.filters.info',
    colorClass:
      'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400 border-blue-200 dark:border-blue-900/50',
  },
];

// Reference to the panel element
const panelRef = ref(null);

function handleCopy(id) {
  copyNotification(id);
}

function transferBarClass(t) {
  if (t.status === 'complete') return 'tf-bar--complete';
  if (t.status === 'error') return 'tf-bar--error';
  return 'tf-bar--active tf-bar--animated';
}

// Setup click outside listener with VueUse
onClickOutside(panelRef, () => {
  if (isPanelOpen.value) {
    closePanel();
  }
});
</script>

<template>
  <Teleport to="body">
    <TransitionRoot :show="isPanelOpen" as="template">
      <div class="relative z-50">
        <!-- Backdrop -->
        <TransitionChild
          enter="ease-in-out duration-300"
          enter-from="opacity-0"
          enter-to="opacity-100"
          leave="ease-in-out duration-300"
          leave-from="opacity-100"
          leave-to="opacity-0"
        >
          <div class="fixed inset-0 bg-black/30 dark:bg-black/50" @click="closePanel" />
        </TransitionChild>

        <!-- Panel -->
        <div class="fixed inset-0 overflow-hidden">
          <div class="absolute inset-0 overflow-hidden">
            <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
              <TransitionChild
                enter="transform transition ease-in-out duration-300"
                enter-from="translate-x-full"
                enter-to="translate-x-0"
                leave="transform transition ease-in-out duration-300"
                leave-from="translate-x-0"
                leave-to="translate-x-full"
              >
                <div ref="panelRef" class="pointer-events-auto w-screen max-w-md h-screen">
                  <div
                    class="flex h-full flex-col border-l bg-white/90 shadow-2xl backdrop-blur-md dark:border-white/10 dark:bg-zinc-900/80"
                  >
                    <!-- Header -->
                    <div class="px-4 py-6 border-b border-gray-200 dark:border-gray-700">
                      <div class="flex items-center justify-between mb-4">
                        <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
                          {{ $t('titles.notifications') }}
                        </h2>
                        <div class="flex items-center gap-3">
                          <button
                            v-if="filteredNotifications.length > 0"
                            @click="clearAll"
                            class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 focus:outline-hidden transition-colors duration-200"
                          >
                            {{ $t('actions.clearAll') }}
                          </button>
                          <button
                            @click="closePanel"
                            class="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:focus:ring-offset-zinc-900 rounded-lg p-1 transition-colors duration-200"
                          >
                            <span class="sr-only">{{ $t('notifications.closePanel') }}</span>
                            <XMarkIcon class="h-6 w-6" />
                          </button>
                        </div>
                      </div>

                      <!-- Filter chips -->
                      <div class="flex flex-wrap gap-2">
                        <button
                          v-for="filter in filterTypes"
                          :key="filter.key"
                          @click="toggleFilter(filter.key)"
                          class="px-3 py-1 rounded-full text-xs font-medium border transition-all duration-200"
                          :class="[
                            filters[filter.key]
                              ? filter.colorClass
                              : 'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 opacity-50 hover:opacity-75',
                          ]"
                        >
                          {{ $t(filter.labelKey) }}
                        </button>
                      </div>
                    </div>

                    <!-- Content -->
                    <div class="flex-1 overflow-y-auto px-4 py-4">
                      <!-- Active transfers -->
                      <div v-if="activeTransfers.length > 0" class="mb-4">
                        <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
                          Transfers
                        </h3>
                        <div class="space-y-3">
                          <div
                            v-for="t in activeTransfers"
                            :key="'t-' + t.id"
                            class="rounded-lg border p-4 bg-white dark:bg-zinc-800"
                            :class="t.status === 'error' ? 'border-red-200 dark:border-red-900/50' : t.status === 'complete' ? 'border-green-200 dark:border-green-900/50' : 'border-indigo-200 dark:border-indigo-900/50'"
                          >
                            <div class="flex items-start gap-3">
                              <component
                                :is="t.status === 'complete' ? CheckCircleIcon : t.status === 'error' ? ExclamationCircleIcon : t.direction === 'upload' ? ArrowUpTrayIcon : ArrowDownTrayIcon"
                                class="h-5 w-5 shrink-0"
                                :class="t.status === 'complete' ? 'text-green-500 dark:text-green-400' : t.status === 'error' ? 'text-red-500 dark:text-red-400' : 'text-indigo-500 dark:text-indigo-400'"
                              />
                              <div class="flex-1 min-w-0">
                                <p class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                  {{ t.filename }}
                                </p>
                                <p v-if="t.status === 'error'" class="text-xs text-red-500 dark:text-red-400 mt-0.5">
                                  {{ t.error }}
                                </p>
                                <p v-else class="text-xs tabular-nums text-gray-500 dark:text-gray-400 mt-0.5">
                                  <template v-if="t.status === 'complete'">
                                    {{ formatBytes(t.totalBytes) }}
                                  </template>
                                  <template v-else-if="t.totalBytes > 0">
                                    {{ t.percentage }}% &middot; {{ formatBytes(t.transferredBytes) }} / {{ formatBytes(t.totalBytes) }}
                                  </template>
                                  <template v-else>
                                    {{ formatBytes(t.transferredBytes) }}
                                  </template>
                                </p>
                                <div v-if="t.status !== 'error'" class="mt-2 w-full h-1.5 rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-700">
                                  <div
                                    class="h-full rounded-full tf-bar transition-all duration-300"
                                    :class="[transferBarClass(t), { 'tf-bar--indeterminate': t.status === 'active' && t.totalBytes <= 0 }]"
                                    :style="`width: ${t.totalBytes > 0 ? t.percentage : 100}%`"
                                  />
                                </div>
                              </div>
                              <button
                                v-if="t.status === 'active'"
                                @click="transferStore.cancel(t.id)"
                                title="Cancel"
                                class="p-1 rounded hover:bg-gray-100 dark:hover:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 shrink-0"
                              >
                                <XMarkIcon class="h-4 w-4" />
                              </button>
                              <button
                                v-else
                                @click="transferStore.remove(t.id)"
                                title="Dismiss"
                                class="p-1 rounded hover:bg-gray-100 dark:hover:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 shrink-0"
                              >
                                <XMarkIcon class="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <!-- Notifications -->
                      <div v-if="filteredNotifications.length === 0 && activeTransfers.length === 0" class="text-center py-12">
                        <p class="text-gray-500 dark:text-gray-400">
                          {{ $t('notifications.empty') }}
                        </p>
                      </div>

                      <div v-if="filteredNotifications.length > 0" class="space-y-3">
                        <NotificationItem
                          v-for="notification in filteredNotifications"
                          :key="notification.id"
                          v-bind="notification"
                          @copy="handleCopy"
                          @dismiss="removeNotification"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </TransitionChild>
            </div>
          </div>
        </div>
      </div>
    </TransitionRoot>
  </Teleport>
</template>

<style scoped>
.tf-bar {
  position: relative;
  overflow: hidden;
}
.tf-bar--active {
  background: linear-gradient(90deg, #4f46e5, #6366f1, #818cf8);
}
.tf-bar--complete {
  background: linear-gradient(90deg, #10b981, #34d399);
}
.tf-bar--error {
  background: linear-gradient(90deg, #ef4444, #f87171);
}
.tf-bar--animated::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
  animation: tfShimmer 1.8s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .tf-bar--animated::after { animation: none; }
}
@keyframes tfShimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.tf-bar--indeterminate {
  animation: tfPulse 1.5s ease-in-out infinite;
}
@keyframes tfPulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tf-bar--indeterminate { animation: none; }
}
</style>

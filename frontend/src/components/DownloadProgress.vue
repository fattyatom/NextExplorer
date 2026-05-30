<script setup>
import { computed } from 'vue';
import { XMarkIcon, ArrowDownTrayIcon } from '@heroicons/vue/24/outline';
import { useDownloadProgressStore } from '@/stores/downloadProgress';
import { formatBytes } from '@/utils';

const store = useDownloadProgressStore();

const downloads = computed(() => store.activeDownloads);
const visible = computed(() => store.hasActive);
</script>

<template>
  <Transition
    enter-active-class="transform ease-out duration-300 transition"
    enter-from-class="translate-y-2 opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition ease-in duration-200"
    leave-from-class="opacity-100"
    leave-to-class="translate-y-2 opacity-0"
  >
    <div
      v-if="visible"
      class="fixed bottom-4 right-4 min-w-[320px] max-w-sm rounded-2xl border border-zinc-200/70 dark:border-white/10 bg-white/85 dark:bg-zinc-700/90 backdrop-blur-md shadow-xl ring-1 ring-black/5"
      role="status"
      aria-live="polite"
    >
      <div class="p-4 space-y-3">
        <div v-for="dl in downloads" :key="dl.id" class="space-y-2">
          <div class="flex items-center gap-2">
            <ArrowDownTrayIcon class="h-4 w-4 shrink-0 text-indigo-500" />
            <span
              class="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100"
              :title="dl.filename"
            >
              {{ dl.filename }}
            </span>
            <span class="ml-auto text-xs tabular-nums text-zinc-500 shrink-0">
              {{ dl.status === 'error' ? 'Failed' : dl.percentage + '%' }}
            </span>
            <button
              type="button"
              title="Cancel download"
              aria-label="Cancel download"
              @click="store.cancel(dl.id)"
              class="h-6 w-6 rounded-full grid place-items-center hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <XMarkIcon class="h-4 w-4" />
            </button>
          </div>

          <div
            class="w-full h-2 rounded-full overflow-hidden border border-zinc-200/70 dark:border-zinc-700/50 bg-zinc-100/80 dark:bg-zinc-800/70"
          >
            <div
              class="h-full rounded-full dl-bar transition-all duration-300"
              :class="[
                dl.status === 'complete' ? 'dl-bar--complete' : '',
                dl.status === 'error' ? 'dl-bar--error' : '',
                dl.status === 'active' ? 'dl-bar--active dl-bar--animated' : '',
              ]"
              :style="`width: ${dl.percentage}%`"
            />
          </div>

          <div class="flex justify-between text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
            <span>{{ formatBytes(dl.downloadedBytes) }} / {{ formatBytes(dl.totalBytes) }}</span>
            <span v-if="dl.status === 'error'" class="text-red-500">{{ dl.error }}</span>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.dl-bar {
  position: relative;
  overflow: hidden;
}
.dl-bar--active {
  background: linear-gradient(90deg, #4f46e5, #6366f1, #818cf8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.dl-bar--complete {
  background: linear-gradient(90deg, #10b981, #34d399, #6ee7b7);
}
.dl-bar--error {
  background: linear-gradient(90deg, #ef4444, #f87171);
}
.dl-bar--animated::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -120px;
  width: 120px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
  animation: dlShimmer 1.6s ease-in-out infinite;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .dl-bar--animated::before {
    animation: none;
  }
}
@keyframes dlShimmer {
  0% { left: -120px; opacity: 0; }
  15% { opacity: 0.85; }
  100% { left: calc(100% + 120px); opacity: 0; }
}
</style>

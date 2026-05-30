<script setup>
import { computed } from 'vue';
import {
  XMarkIcon,
  ChevronDownIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/vue/24/outline';
import { useTransferStore } from '@/stores/transferStore';
import { formatBytes } from '@/utils';

const store = useTransferStore();

const transfers = computed(() => store.activeTransfers);
const visible = computed(() => store.visible);
const collapsed = computed(() => store.panelCollapsed);
const progress = computed(() => store.overallProgress);
const counts = computed(() => store.counts);

const headerText = computed(() => {
  const c = counts.value;
  if (c.active > 0) {
    return `${progress.value}% · ${c.active} transfer${c.active !== 1 ? 's' : ''} in progress`;
  }
  if (c.complete > 0 && c.failed === 0) {
    return `${c.complete} transfer${c.complete !== 1 ? 's' : ''} complete`;
  }
  if (c.failed > 0) {
    return `${c.failed} failed, ${c.complete} complete`;
  }
  return 'Transfers';
});

function directionIcon(t) {
  if (t.status === 'complete') return CheckCircleIcon;
  if (t.status === 'error') return ExclamationCircleIcon;
  return t.direction === 'upload' ? ArrowUpTrayIcon : ArrowDownTrayIcon;
}

function directionColor(t) {
  if (t.status === 'complete') return 'text-emerald-500';
  if (t.status === 'error') return 'text-red-500';
  return 'text-indigo-500';
}

function barClass(t) {
  if (t.status === 'complete') return 'tf-bar--complete';
  if (t.status === 'error') return 'tf-bar--error';
  return 'tf-bar--active tf-bar--animated';
}
</script>

<template>
  <Transition
    enter-active-class="transform ease-out duration-300 transition"
    enter-from-class="translate-y-4 opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition ease-in duration-200"
    leave-from-class="opacity-100"
    leave-to-class="translate-y-4 opacity-0"
  >
    <div
      v-if="visible"
      class="fixed bottom-4 right-4 w-[380px] rounded-xl border border-zinc-200/70 dark:border-white/10 bg-white dark:bg-zinc-800 shadow-2xl ring-1 ring-black/5 overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <!-- Header bar -->
      <div
        class="flex items-center gap-2 px-4 py-3 bg-zinc-50 dark:bg-zinc-800/80 border-b border-zinc-200/70 dark:border-zinc-700/50 cursor-pointer select-none"
        @click="store.toggleCollapse()"
      >
        <!-- Overall progress ring -->
        <div class="relative h-5 w-5 shrink-0" v-if="counts.active > 0">
          <svg class="h-5 w-5 -rotate-90" viewBox="0 0 20 20">
            <circle
              cx="10" cy="10" r="8"
              fill="none" stroke="currentColor"
              class="text-zinc-200 dark:text-zinc-600"
              stroke-width="2.5"
            />
            <circle
              cx="10" cy="10" r="8"
              fill="none" stroke="currentColor"
              class="text-indigo-500 transition-all duration-300"
              stroke-width="2.5"
              stroke-linecap="round"
              :stroke-dasharray="`${progress * 0.5027} 50.27`"
            />
          </svg>
        </div>
        <CheckCircleIcon v-else-if="counts.complete > 0 && counts.failed === 0" class="h-5 w-5 text-emerald-500 shrink-0" />
        <ExclamationCircleIcon v-else-if="counts.failed > 0" class="h-5 w-5 text-red-500 shrink-0" />

        <span class="text-sm font-medium text-zinc-700 dark:text-zinc-200 truncate">
          {{ headerText }}
        </span>

        <div class="ml-auto flex items-center gap-1">
          <button
            v-if="!counts.active"
            type="button"
            title="Dismiss"
            aria-label="Dismiss completed transfers"
            @click.stop="store.clearCompleted()"
            class="h-7 w-7 rounded-full grid place-items-center hover:bg-zinc-200 dark:hover:bg-zinc-700"
          >
            <XMarkIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            :title="collapsed ? 'Expand' : 'Collapse'"
            :aria-label="collapsed ? 'Expand transfer panel' : 'Collapse transfer panel'"
            @click.stop="store.toggleCollapse()"
            class="h-7 w-7 rounded-full grid place-items-center hover:bg-zinc-200 dark:hover:bg-zinc-700"
          >
            <ChevronDownIcon
              class="h-4 w-4 transition-transform duration-200"
              :class="collapsed ? 'rotate-180' : ''"
            />
          </button>
        </div>
      </div>

      <!-- Transfer list -->
      <div
        v-if="!collapsed"
        class="max-h-[280px] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-700/40"
      >
        <div
          v-for="t in transfers"
          :key="t.id"
          class="px-4 py-3 hover:bg-zinc-50/50 dark:hover:bg-zinc-700/30 transition-colors"
        >
          <div class="flex items-center gap-2.5">
            <component
              :is="directionIcon(t)"
              class="h-4 w-4 shrink-0"
              :class="directionColor(t)"
            />
            <span
              class="truncate text-sm text-zinc-800 dark:text-zinc-100 flex-1"
              :title="t.filename"
            >
              {{ t.filename }}
            </span>
            <span class="text-xs tabular-nums text-zinc-400 shrink-0">
              <template v-if="t.status === 'active'">{{ t.percentage }}%</template>
              <template v-else-if="t.status === 'complete'">Done</template>
              <template v-else-if="t.status === 'error'">Failed</template>
            </span>
            <button
              v-if="t.status === 'active'"
              type="button"
              title="Cancel"
              aria-label="Cancel transfer"
              @click="store.cancel(t.id)"
              class="h-6 w-6 rounded-full grid place-items-center hover:bg-zinc-200 dark:hover:bg-zinc-700 shrink-0"
            >
              <XMarkIcon class="h-3.5 w-3.5" />
            </button>
          </div>

          <!-- Progress bar -->
          <div class="mt-1.5 w-full h-1.5 rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-700">
            <div
              class="h-full rounded-full tf-bar transition-all duration-300"
              :class="barClass(t)"
              :style="`width: ${t.percentage}%`"
            />
          </div>

          <!-- Size -->
          <div class="mt-1 text-[11px] text-zinc-400 tabular-nums">
            {{ formatBytes(t.transferredBytes) }} / {{ formatBytes(t.totalBytes) }}
            <span v-if="t.status === 'error'" class="text-red-400 ml-1">{{ t.error }}</span>
          </div>
        </div>
      </div>
    </div>
  </Transition>
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
</style>

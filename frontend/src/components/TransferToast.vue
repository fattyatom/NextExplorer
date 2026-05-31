<script setup>
import {
  XMarkIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
} from '@heroicons/vue/24/outline';
import { computed } from 'vue';
import { formatBytes } from '@/utils';

const props = defineProps({
  id: { type: String, required: true },
  direction: { type: String, required: true },
  filename: { type: String, required: true },
  totalBytes: { type: Number, default: 0 },
  transferredBytes: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
  status: { type: String, default: 'active' },
  error: { type: String, default: null },
});

const emit = defineEmits(['cancel']);

const directionIcon = computed(() =>
  props.direction === 'upload' ? ArrowUpTrayIcon : ArrowDownTrayIcon
);

const sizeText = computed(() => {
  if (props.totalBytes > 0) {
    return `${formatBytes(props.transferredBytes)} / ${formatBytes(props.totalBytes)}`;
  }
  return formatBytes(props.transferredBytes);
});

const barClass = computed(() => {
  if (props.status === 'error') return 'tf-bar--error';
  return 'tf-bar--active tf-bar--animated';
});

const indeterminate = computed(() => props.status === 'active' && props.totalBytes <= 0);
</script>

<template>
  <div
    class="pointer-events-auto w-full max-w-sm overflow-hidden rounded-xl bg-white/95 dark:bg-zinc-900/90 shadow-2xl ring-1 ring-black/10 dark:ring-white/20 border border-neutral-200/80 dark:border-white/10 backdrop-blur-md"
  >
    <div class="p-4">
      <div class="flex items-start">
        <div class="shrink-0">
          <component
            :is="directionIcon"
            class="h-6 w-6 text-indigo-500 dark:text-indigo-400"
          />
        </div>

        <div class="ml-3 w-0 flex-1 pt-0.5">
          <p class="text-sm font-medium text-gray-900 dark:text-gray-100 truncate" :title="filename">
            {{ direction === 'upload' ? 'Uploading' : 'Downloading' }} {{ filename }}
          </p>
          <p class="mt-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">
            <template v-if="totalBytes > 0">{{ percentage }}% &middot; {{ sizeText }}</template>
            <template v-else>{{ sizeText }}</template>
          </p>

          <div class="mt-2 w-full h-1.5 rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-700">
            <div
              class="h-full rounded-full tf-bar transition-all duration-300"
              :class="[barClass, { 'tf-bar--indeterminate': indeterminate }]"
              :style="`width: ${totalBytes > 0 ? percentage : 100}%`"
            />
          </div>
        </div>

        <div class="ml-4 flex shrink-0">
          <button
            type="button"
            @click="emit('cancel', id)"
            class="inline-flex rounded-md text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-gray-400 dark:focus:ring-offset-zinc-800"
            :title="$t('common.cancel')"
          >
            <span class="sr-only">Cancel transfer</span>
            <XMarkIcon class="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tf-bar {
  position: relative;
  overflow: hidden;
}
.tf-bar--active {
  background: linear-gradient(90deg, #4f46e5, #6366f1, #818cf8);
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

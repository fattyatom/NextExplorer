<script setup>
import { computed, reactive, watch } from 'vue';
import { useAppSettings } from '@/stores/appSettings';
import { useI18n } from 'vue-i18n';

const appSettings = useAppSettings();
const { t } = useI18n();

const local = reactive({
  uploadEnabled: true,
  downloadEnabled: true,
  chunkSizeMB: 20,
});

const source = computed(() => appSettings.systemSettings?.chunkedTransfers);

const envLocked = computed(() => source.value?.envLocked || {});

const dirty = computed(() => {
  const s = source.value;
  if (!s) return false;
  return (
    local.uploadEnabled !== s.uploadEnabled ||
    local.downloadEnabled !== s.downloadEnabled ||
    local.chunkSizeMB !== s.chunkSizeMB
  );
});

watch(
  () => appSettings.systemSettings?.chunkedTransfers,
  (ct) => {
    if (ct) {
      local.uploadEnabled = ct.uploadEnabled;
      local.downloadEnabled = ct.downloadEnabled;
      local.chunkSizeMB = ct.chunkSizeMB;
    }
  },
  { immediate: true }
);

const reset = () => {
  const ct = source.value;
  if (ct) {
    local.uploadEnabled = ct.uploadEnabled;
    local.downloadEnabled = ct.downloadEnabled;
    local.chunkSizeMB = ct.chunkSizeMB;
  }
};

const save = async () => {
  await appSettings.save({
    chunkedTransfers: {
      uploadEnabled: local.uploadEnabled,
      downloadEnabled: local.downloadEnabled,
      chunkSizeMB: local.chunkSizeMB,
    },
  });
};
</script>

<template>
  <div class="space-y-6">
    <div
      v-if="dirty"
      class="sticky top-0 z-10 flex items-center justify-between rounded-md border border-yellow-400/30 bg-yellow-100/40 p-3 text-yellow-900 dark:border-yellow-400/20 dark:bg-yellow-500/10 dark:text-yellow-200"
    >
      <div class="text-sm">{{ t('common.unsavedChanges') }}</div>
      <div class="flex gap-2">
        <button
          class="rounded-md bg-yellow-500 px-3 py-1 text-black hover:bg-yellow-400"
          @click="save"
        >
          {{ t('common.save') }}
        </button>
        <button
          class="rounded-md border border-white/10 px-3 py-1 hover:bg-white/10"
          @click="reset"
        >
          {{ t('common.discard') }}
        </button>
      </div>
    </div>

    <!-- Header -->
    <div>
      <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {{ t('settings.transfers.title') }}
      </h2>
      <p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
        {{ t('settings.transfers.subtitle') }}
      </p>
    </div>

    <!-- Content -->
    <div
      class="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-6"
    >
      <div class="space-y-6">
        <!-- Chunked uploads toggle -->
        <div class="flex items-center justify-between py-3 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.transfers.uploadEnabled') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.transfers.uploadEnabledHelp') }}
            </div>
            <div v-if="envLocked.uploadEnabled" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {{ t('settings.transfers.envLocked') }}
            </div>
          </div>
          <label class="inline-flex items-center" :class="envLocked.uploadEnabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
            <input type="checkbox" v-model="local.uploadEnabled" :disabled="envLocked.uploadEnabled" class="peer sr-only" />
            <div
              class="peer relative h-6 w-11 rounded-full bg-zinc-200 transition-colors peer-checked:bg-zinc-900 dark:bg-zinc-700 dark:peer-checked:bg-zinc-100 peer-disabled:opacity-50"
            >
              <div
                class="absolute left-[2px] top-[2px] h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5"
              ></div>
            </div>
          </label>
        </div>

        <!-- Chunked downloads toggle -->
        <div class="flex items-center justify-between py-3 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.transfers.downloadEnabled') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.transfers.downloadEnabledHelp') }}
            </div>
            <div v-if="envLocked.downloadEnabled" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {{ t('settings.transfers.envLocked') }}
            </div>
          </div>
          <label class="inline-flex items-center" :class="envLocked.downloadEnabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
            <input type="checkbox" v-model="local.downloadEnabled" :disabled="envLocked.downloadEnabled" class="peer sr-only" />
            <div
              class="peer relative h-6 w-11 rounded-full bg-zinc-200 transition-colors peer-checked:bg-zinc-900 dark:bg-zinc-700 dark:peer-checked:bg-zinc-100 peer-disabled:opacity-50"
            >
              <div
                class="absolute left-[2px] top-[2px] h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5"
              ></div>
            </div>
          </label>
        </div>

        <!-- Chunk size -->
        <div
          class="flex items-center justify-between py-3"
          :class="{ 'opacity-60 pointer-events-none': !local.uploadEnabled && !local.downloadEnabled }"
        >
          <div>
            <div class="font-medium text-zinc-900 dark:text-zinc-100">
              {{ t('settings.transfers.chunkSize') }}
            </div>
            <div class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {{ t('settings.transfers.chunkSizeHelp') }}
            </div>
            <div v-if="envLocked.chunkSizeMB" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {{ t('settings.transfers.envLocked') }}
            </div>
          </div>
          <div class="flex items-center gap-3">
            <input
              type="range"
              min="1"
              max="100"
              v-model.number="local.chunkSizeMB"
              :disabled="envLocked.chunkSizeMB"
              class="w-64 h-2 rounded-lg appearance-none bg-zinc-200 dark:bg-zinc-700 accent-zinc-900 dark:accent-zinc-100 disabled:opacity-50"
            />
            <input
              type="number"
              min="1"
              max="100"
              v-model.number="local.chunkSizeMB"
              :disabled="envLocked.chunkSizeMB"
              class="w-20 rounded-md border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs focus:border-zinc-500 focus:ring-zinc-500 sm:text-sm p-2 border text-center disabled:opacity-50"
            />
            <span class="text-sm text-zinc-500 dark:text-zinc-400">MB</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

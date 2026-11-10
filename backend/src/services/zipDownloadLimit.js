const fs = require('fs/promises');
const path = require('path');
const { AppError } = require('../errors/AppError');

/**
 * Cap on the total size of the files a zip download may contain.
 *
 * Folder and multi-file downloads are zipped before they are served, either to
 * a temp file (POST /api/download) or straight to the response (direct share
 * links). Without a cap one request can zip a whole share: it fills the temp
 * disk and, on Kubernetes, gets the pod evicted, cutting off every user.
 *
 * The total is the sum of the regular files' sizes as found on disk, the same
 * entries archiver adds (it does not follow symlinks). It stops walking as soon
 * as the cap is passed, so refusing a huge folder costs no more than reading
 * up to the cap's worth of directory entries.
 */

class ZipTooLargeError extends AppError {
  constructor(limitBytes) {
    super(
      `This download is larger than the ${formatBytes(limitBytes)} limit for zip downloads. ` +
        'Select fewer files or download them separately.',
      413,
      'ZIP_TOO_LARGE'
    );
    this.name = 'ZipTooLargeError';
  }
}

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[i]}`;
};

/**
 * Sum the sizes of the regular files under `absolutePaths` (files or
 * directories). Returns { totalBytes, exceeded }; with limitBytes > 0 it stops
 * as soon as the total passes the limit (totalBytes is then only a lower bound).
 */
const measureZipInput = async (absolutePaths, limitBytes = 0) => {
  let totalBytes = 0;
  const stack = [...absolutePaths];
  while (stack.length > 0) {
    const current = stack.pop();
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch {
      continue; // vanished since it was listed: archiver will skip it too
    }
    if (stats.isDirectory()) {
      let entries = [];
      try {
        entries = await fs.readdir(current);
      } catch {
        entries = [];
      }
      for (const entry of entries) stack.push(path.join(current, entry));
    } else if (stats.isFile()) {
      totalBytes += stats.size;
      if (limitBytes > 0 && totalBytes > limitBytes) {
        return { totalBytes, exceeded: true };
      }
    }
  }
  return { totalBytes, exceeded: false };
};

/** Throw a 413 if the zip of `absolutePaths` would exceed the configured cap. */
const assertZipWithinLimit = async (absolutePaths) => {
  // Read at call time, so the setting follows the loaded config.
  const limitBytes = require('../config/index').archives.maxDownloadZipBytes;
  if (!(limitBytes > 0)) return;
  const { exceeded } = await measureZipInput(absolutePaths, limitBytes);
  if (exceeded) throw new ZipTooLargeError(limitBytes);
};

module.exports = { assertZipWithinLimit, measureZipInput, ZipTooLargeError, formatBytes };

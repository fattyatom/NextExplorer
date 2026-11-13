const { AppError } = require('../errors/AppError');

/**
 * A ceiling on what one zip download may hold.
 *
 * A folder or a selection leaves as a zip, and so does a direct share link to
 * a folder. A zip prepared in the background is written whole to the temp disk
 * before a byte of it is served; without a ceiling one request can zip an
 * entire volume, fill that disk and — where the temp disk is the container's
 * own — take the application away from everybody else.
 *
 * The figure compared is the one `collectArchiveEntries` already returns: the
 * bytes of the files that would actually go in, after the names a listing
 * leaves out and the paths an access rule hides have been left out here too.
 * So the refusal is about the archive that would have been made, and it comes
 * before anything is written or sent.
 */

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
};

class ZipTooLargeError extends AppError {
  constructor(limitBytes) {
    super(
      `This download is larger than the ${formatBytes(limitBytes)} limit for zip downloads. ` +
        'Select fewer items or download them separately.',
      413,
      'ZIP_TOO_LARGE'
    );
    this.name = 'ZipTooLargeError';
  }
}

/** Read when asked rather than when required, so it follows the loaded config. */
const zipDownloadLimitBytes = () => require('../config/index').archives.maxDownloadZipBytes;

/** Throw a 413 when a zip of `totalBytes` of files would pass the ceiling. */
const ensureZipWithinLimit = (totalBytes) => {
  const limitBytes = zipDownloadLimitBytes();
  if (!(limitBytes > 0)) return;
  if (totalBytes > limitBytes) throw new ZipTooLargeError(limitBytes);
};

module.exports = { ensureZipWithinLimit, zipDownloadLimitBytes, ZipTooLargeError, formatBytes };

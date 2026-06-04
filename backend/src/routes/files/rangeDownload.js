const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { normalizeRelativePath } = require('../../utils/pathUtils');
const { resolvePathWithAccess } = require('../../services/accessManager');
const preparedDownloads = require('../../services/preparedDownloads');
const asyncHandler = require('../../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../../errors/AppError');
const logger = require('../../utils/logger');
const { encodeContentDisposition } = require('./utils');

const router = require('express').Router();

// Long-poll window for the readiness check. The client sends ?wait=1 and the
// server holds the request open until the background build finishes (or this
// timeout elapses, after which it returns 202 and the client re-polls). Kept
// well under reverse-proxy / CDN response timeouts (e.g. Cloudflare's 100s) so
// the held connection is never killed. This collapses many polling round-trips
// — each of which adds CDN latency — into one, and returns the instant the zip
// is ready.
const READY_WAIT_TIMEOUT_MS = 20000;
const READY_POLL_STEP_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getMimeType = (ext) => {
  const map = {
    pdf: 'application/pdf',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
};

/**
 * Resolve the target file for range-download.
 * Returns { absolutePath, filename, stats } or null if the response was
 * already sent (e.g. 202 "still building").
 */
async function resolveTarget(req, res) {
  const downloadId = req.query?.downloadId;
  if (downloadId) {
    let dl = preparedDownloads.get(downloadId);
    if (!dl) {
      throw new NotFoundError('Prepared download not found or expired.');
    }

    // Long-poll: if requested, hold the connection until the build finishes
    // (or the bounded timeout elapses) so the client doesn't have to spam polls.
    if (dl.building && req.query?.wait) {
      const deadline = Date.now() + READY_WAIT_TIMEOUT_MS;
      while (dl.building && Date.now() < deadline) {
        await sleep(READY_POLL_STEP_MS);
        dl = preparedDownloads.get(downloadId);
        if (!dl) {
          // Build failed / was cancelled / expired while we waited.
          throw new NotFoundError('Prepared download not found or expired.');
        }
      }
    }

    if (dl.building) {
      // 202 = "accepted but not ready yet" — the client polls until it gets 200
      res.set('Cache-Control', 'no-store');
      res.status(202).json({ status: 'building', message: 'Download is still being prepared.' });
      return null;
    }
    if (dl.error) {
      // Use a non-retryable error so the client stops polling
      const err = new Error(`Archive preparation failed: ${dl.error}`);
      err.status = 500;
      throw err;
    }
    const userId = req.user?.id || req.guestSession?.id || null;
    if (dl.userId !== userId) {
      throw new ForbiddenError('Download belongs to a different user.');
    }
    const stats = await fs.stat(dl.tempPath);
    return { absolutePath: dl.tempPath, filename: dl.filename, stats };
  }

  const relative = req.query?.path;
  if (typeof relative !== 'string' || !relative.trim()) {
    throw new ValidationError('A file path or downloadId query parameter is required.');
  }

  const relativePath = normalizeRelativePath(relative);
  const context = { user: req.user, guestSession: req.guestSession };
  const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);

  if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead || !accessInfo.canDownload) {
    throw new ForbiddenError(accessInfo?.denialReason || 'Download not allowed.');
  }
  if (!resolved) {
    throw new NotFoundError('File not found.');
  }

  const { absolutePath } = resolved;
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    throw new ValidationError(
      'Cannot download a directory via this endpoint. Use POST /api/download instead.'
    );
  }

  return { absolutePath, filename: path.basename(absolutePath), stats };
}

// Larger read chunks than Node's 64 KB default keep the socket fed and improve
// large-file throughput, especially through a reverse proxy / CDN like Cloudflare.
const READ_CHUNK_BYTES = 1024 * 1024; // 1 MB

// Cache directives that stop a CDN from caching/transforming the download.
// `no-store` keeps Cloudflare from caching the (single-use, unique) temp file
// and `no-transform` from rewriting it.
//
// NOTE: we deliberately do NOT send `X-Accel-Buffering: no` here. While it
// disables nginx response buffering, it switches the upstream into unbuffered
// (often chunked) streaming, which Cloudflare can truncate/reset for large
// files — downloads then fail with only a few bytes received. The right place
// to stop CDN buffering is a Cloudflare cache/bypass rule, not this header.
const downloadCacheHeaders = () => ({
  'Cache-Control': 'no-store, no-transform',
});

function serveFile(req, res, absolutePath, filename, stats) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mimeType = getMimeType(ext);

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': encodeContentDisposition(filename),
      ...downloadCacheHeaders(),
    });
    res.end();
    return;
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const bytesPrefix = 'bytes=';
    if (!rangeHeader.startsWith(bytesPrefix)) {
      res.status(416).send('Malformed Range header');
      return;
    }

    const [startStr, endStr] = rangeHeader.slice(bytesPrefix.length).split('-');
    let start = Number(startStr);
    let end = endStr ? Number(endStr) : stats.size - 1;

    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= stats.size) end = stats.size - 1;

    if (start > end || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Content-Disposition': encodeContentDisposition(filename),
      ...downloadCacheHeaders(),
    });
    res.flushHeaders();

    const stream = fss.createReadStream(absolutePath, {
      start,
      end,
      highWaterMark: READ_CHUNK_BYTES,
    });
    stream.on('error', (err) => {
      logger.error({ err }, 'Range download stream failed');
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Length': stats.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': encodeContentDisposition(filename),
    ...downloadCacheHeaders(),
  });
  res.flushHeaders();

  const stream = fss.createReadStream(absolutePath, { highWaterMark: READ_CHUNK_BYTES });
  stream.on('error', (err) => {
    logger.error({ err }, 'Download stream failed');
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
}

const handler = asyncHandler(async (req, res) => {
  const target = await resolveTarget(req, res);
  if (!target) return; // 202 already sent
  const { absolutePath, filename, stats } = target;
  serveFile(req, res, absolutePath, filename, stats);
});

router.get('/range-download', handler);
router.head('/range-download', handler);

/**
 * DELETE /api/range-download?downloadId=…
 *
 * Cancel an in-progress or completed prepared download.
 * Removes the entry from the store and deletes the temp file.
 */
router.delete(
  '/range-download',
  asyncHandler(async (req, res) => {
    const downloadId = req.query?.downloadId;
    if (!downloadId) {
      throw new ValidationError('downloadId query parameter is required.');
    }

    const dl = preparedDownloads.get(downloadId);
    if (!dl) {
      // Already gone or expired — nothing to do
      res.status(204).end();
      return;
    }

    const userId = req.user?.id || req.guestSession?.id || null;
    if (dl.userId !== userId) {
      throw new ForbiddenError('Download belongs to a different user.');
    }

    // If there's an active archiver, abort it
    if (dl.archive && typeof dl.archive.abort === 'function') {
      dl.archive.abort();
    }

    preparedDownloads.remove(downloadId);
    logger.info({ downloadId }, 'Download cancelled by client');
    res.status(204).end();
  })
);

module.exports = router;

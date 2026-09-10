const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const crypto = require('crypto');
const os = require('os');
const archiver = require('archiver');
const { normalizeRelativePath } = require('../../utils/pathUtils');
const { resolvePathWithAccess } = require('../../services/accessManager');
const asyncHandler = require('../../utils/asyncHandler');
const { ValidationError, ForbiddenError } = require('../../errors/AppError');
const preparedDownloads = require('../../services/preparedDownloads');
const logger = require('../../utils/logger');
const { collectInputPaths, stripBasePath, toPosix } = require('./utils');

const router = require('express').Router();

/**
 * POST /api/download
 *
 * Downloads one or more files/directories.
 *
 * Single file  → streams the file directly via res.download().
 * Multi / dir  → returns 202 { downloadId, filename } immediately and builds
 *                the zip to a temp file in the background.  The client polls
 *                GET /api/range-download?downloadId=… until the file is ready.
 *                This completely avoids reverse-proxy streaming timeouts
 *                (Cloudflare 524, nginx proxy_read_timeout, etc.).
 */
const getLogicalSegments = (relativePath = '') => toPosix(relativePath).split('/').filter(Boolean);

const isShareRootPath = (relativePath = '') => {
  const segments = getLogicalSegments(relativePath);
  return segments.length === 2 && segments[0] === 'share';
};

const getDownloadBaseName = ({ relativePath, absolutePath }) => {
  if (isShareRootPath(relativePath)) {
    return path.basename(absolutePath);
  }

  const segments = getLogicalSegments(relativePath);
  return segments[segments.length - 1] || path.basename(absolutePath);
};

const handleDownloadRequest = async (paths, req, res, basePath = '') => {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ValidationError('At least one path is required.');
  }

  const normalizedPaths = [
    ...new Set(paths.map((item) => normalizeRelativePath(item)).filter(Boolean)),
  ];
  if (normalizedPaths.length === 0) {
    throw new ValidationError('No valid paths provided.');
  }

  const baseNormalized = basePath ? normalizeRelativePath(basePath) : '';
  const context = { user: req.user, guestSession: req.guestSession };

  const targets = await Promise.all(
    normalizedPaths.map(async (relativePath) => {
      const { accessInfo, resolved } = await resolvePathWithAccess(context, relativePath);
      if (
        !accessInfo ||
        !accessInfo.canAccess ||
        !accessInfo.canRead ||
        !accessInfo.canDownload ||
        !resolved
      ) {
        throw new ForbiddenError(accessInfo?.denialReason || 'Download not allowed.');
      }
      const { absolutePath, relativePath: logicalPath } = resolved;
      const stats = await fs.stat(absolutePath);
      return { relativePath: logicalPath, absolutePath, stats };
    })
  );

  // ── Single-file fast path ──────────────────────────────────────────
  const hasDirectory = targets.some(({ stats }) => stats.isDirectory());
  const shouldArchive = hasDirectory || targets.length > 1;

  if (!shouldArchive) {
    const [{ absolutePath, relativePath }] = targets;
    const filename = (() => {
      if (!baseNormalized) return path.basename(absolutePath);
      const relativePosix = stripBasePath(relativePath, baseNormalized);
      const basename = relativePosix.split('/').pop();
      return basename || path.basename(absolutePath);
    })();
    // Allow dotfiles to be downloaded (Express blocks them by default)
    res.download(absolutePath, filename, { dotfiles: 'allow' }, (err) => {
      if (err) {
        logger.error({ err }, 'Download failed');
        if (!res.headersSent) {
          res.status(500).send('Failed to download file.');
        }
      }
    });
    return;
  }

  // ── Archive (multi-file / directory) ───────────────────────────────
  const archiveName = (() => {
    if (targets.length === 1) {
      const baseName = getDownloadBaseName(targets[0]);
      return `${baseName || 'download'}.zip`;
    }
    if (baseNormalized) {
      const segments = baseNormalized.split(path.sep).filter(Boolean);
      const baseName = segments.length > 0 ? segments[segments.length - 1] : baseNormalized;
      if (baseName) return `${baseName}.zip`;
    }
    return 'download.zip';
  })();

  const downloadId = crypto.randomBytes(16).toString('hex');
  const tempPath = path.join(os.tmpdir(), `nextexplorer-dl-${downloadId}.zip`);
  const userId = req.user?.id || req.guestSession?.id || null;

  // ── Build the zip in the background ─────────────────────────────
  const fileStream = fss.createWriteStream(tempPath);
  const archive = archiver('zip', { zlib: { level: 1 } });

  // Register as "building" so range-download returns 202 (not ready).
  // Store the archive ref so DELETE /api/range-download can abort it.
  preparedDownloads.set(downloadId, {
    userId,
    tempPath,
    filename: archiveName,
    size: -1,
    building: true,
    archive,
  });

  // ── Return immediately — the client polls /api/range-download ────
  // Responding with 202 + downloadId before the archive starts avoids
  // every flavour of reverse-proxy timeout (Cloudflare 524, Tunnel
  // idle-read, nginx proxy_read_timeout, etc.).
  res.status(202).json({ downloadId, filename: archiveName });

  let totalBytes = 0;

  archive.on('data', (chunk) => {
    totalBytes += chunk.length;
  });

  archive.on('error', (err) => {
    logger.error({ err, downloadId }, 'Background archive creation failed');
    fileStream.destroy(err);
    preparedDownloads.remove(downloadId);
  });

  archive.pipe(fileStream);

  targets.forEach(({ relativePath, absolutePath, stats }) => {
    // A share root is addressed by token, so its own basename is the only
    // name that means anything to whoever opens the zip.
    const entryNameRaw = isShareRootPath(relativePath)
      ? getDownloadBaseName({ relativePath, absolutePath })
      : stripBasePath(relativePath, baseNormalized);
    const entryName = entryNameRaw
      ? entryNameRaw.replace(/\\/g, '/').replace(/^\/+/, '')
      : path.basename(absolutePath);

    if (stats.isDirectory()) {
      archive.directory(absolutePath, entryName);
    } else {
      archive.file(absolutePath, {
        name: entryName || path.basename(absolutePath),
      });
    }
  });

  archive.finalize().then(async () => {
    try {
      // Wait for the temp file to be fully flushed
      await new Promise((resolve, reject) => {
        fileStream.on('close', resolve);
        fileStream.on('error', reject);
      });

      preparedDownloads.set(downloadId, {
        userId,
        tempPath,
        filename: archiveName,
        size: totalBytes,
      });

      logger.info(
        { downloadId, filename: archiveName, size: totalBytes },
        'Background archive build completed'
      );
    } catch (err) {
      logger.error({ err, downloadId }, 'Failed to finalize temp file');
      preparedDownloads.remove(downloadId);
    }
  });
};

router.post(
  '/download',
  asyncHandler(async (req, res) => {
    const basePath = req.body?.basePath || req.body?.currentPath || '';
    const paths = collectInputPaths(req.body?.path, req.body?.paths, req.body?.items);
    await handleDownloadRequest(paths, req, res, basePath);
  })
);

module.exports = router;

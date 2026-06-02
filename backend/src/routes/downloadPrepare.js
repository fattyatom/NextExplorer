const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const crypto = require('crypto');
const os = require('os');
const archiver = require('archiver');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError } = require('../errors/AppError');
const { collectInputPaths, stripBasePath } = require('./files/utils');
const preparedDownloads = require('../services/preparedDownloads');
const logger = require('../utils/logger');

const router = require('express').Router();

router.post(
  '/download/prepare',
  asyncHandler(async (req, res) => {
    const basePath = req.body?.basePath || req.body?.currentPath || '';
    const paths = collectInputPaths(req.body?.path, req.body?.paths, req.body?.items);

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

    const archiveName = (() => {
      if (targets.length === 1) {
        const segments = targets[0].relativePath
          ? targets[0].relativePath.split(path.sep).filter(Boolean)
          : [];
        const baseName =
          segments.length > 0
            ? segments[segments.length - 1]
            : path.basename(targets[0].absolutePath);
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
    const output = fss.createWriteStream(tempPath);
    const archive = archiver('zip', { zlib: { level: 1 } });

    archive.pipe(output);

    targets.forEach(({ relativePath, absolutePath, stats }) => {
      const entryNameRaw = stripBasePath(relativePath, baseNormalized);
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

    await archive.finalize();
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });

    const zipStats = await fs.stat(tempPath);
    const userId = req.user?.id || req.guestSession?.id || null;

    preparedDownloads.set(downloadId, {
      userId,
      tempPath,
      filename: archiveName,
      size: zipStats.size,
    });

    logger.info({ downloadId, filename: archiveName, size: zipStats.size }, 'Download prepared');

    res.json({ downloadId, filename: archiveName, size: zipStats.size });
  })
);

module.exports = router;

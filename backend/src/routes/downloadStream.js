const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const crypto = require('crypto');
const os = require('os');
const { Transform } = require('stream');
const archiver = require('archiver');
const { normalizeRelativePath } = require('../utils/pathUtils');
const { resolvePathWithAccess } = require('../services/accessManager');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError } = require('../errors/AppError');
const { collectInputPaths, encodeContentDisposition, stripBasePath } = require('./files/utils');
const preparedDownloads = require('../services/preparedDownloads');
const logger = require('../utils/logger');

const router = require('express').Router();

router.post(
  '/download/zip-stream',
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
    const userId = req.user?.id || req.guestSession?.id || null;

    preparedDownloads.set(downloadId, {
      userId,
      tempPath,
      filename: archiveName,
      size: -1,
      building: true,
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', encodeContentDisposition(archiveName));
    res.setHeader('X-Download-Id', downloadId);
    res.setHeader('X-Archive-Name', encodeURIComponent(archiveName));
    res.setHeader('Transfer-Encoding', 'chunked');

    const fileStream = fss.createWriteStream(tempPath);
    const archive = archiver('zip', { zlib: { level: 1 } });

    let clientDisconnected = false;
    let totalBytes = 0;
    req.on('close', () => {
      clientDisconnected = true;
    });

    const tee = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        fileStream.write(chunk, (err) => {
          if (err) return callback(err);
          if (!clientDisconnected && !res.writableEnded) {
            res.write(chunk);
          }
          callback(null, null);
        });
      },
      flush(callback) {
        fileStream.end(() => {
          preparedDownloads.set(downloadId, {
            userId,
            tempPath,
            filename: archiveName,
            size: totalBytes,
          });
          logger.info(
            { downloadId, filename: archiveName, size: totalBytes, clientDisconnected },
            'Streaming download completed'
          );
          if (!clientDisconnected && !res.writableEnded) {
            res.end();
          }
          callback();
        });
      },
    });

    archive.on('error', (err) => {
      logger.error({ err, downloadId }, 'Streaming archive creation failed');
      fileStream.destroy(err);
      preparedDownloads.remove(downloadId);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Archive creation failed.' } });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    archive.pipe(tee);

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
      tee.on('finish', resolve);
      tee.on('error', reject);
    });
  })
);

module.exports = router;

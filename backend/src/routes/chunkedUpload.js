const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const crypto = require('crypto');
const express = require('express');

const { normalizeRelativePath, findAvailableName } = require('../utils/pathUtils');
const { ensureDir, pathExists } = require('../utils/fsUtils');
const { ACTIONS, authorizeAndResolve } = require('../services/authorizationService');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, ForbiddenError, NotFoundError } = require('../errors/AppError');
const logger = require('../utils/logger');

const router = express.Router();

const activeUploads = new Map();

const UPLOAD_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, upload] of activeUploads) {
    if (now - upload.lastActivity > UPLOAD_TTL_MS) {
      fs.rm(upload.tempPath, { force: true }).catch(() => {});
      activeUploads.delete(id);
      logger.info({ uploadId: id }, 'Cleaned up stale chunked upload');
    }
  }
}, CLEANUP_INTERVAL_MS);

router.post(
  '/chunked-upload/init',
  asyncHandler(async (req, res) => {
    const { filename, totalSize, uploadTo, relativePath } = req.body || {};

    if (!filename || typeof filename !== 'string') {
      throw new ValidationError('filename is required.');
    }
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      throw new ValidationError('totalSize must be a positive number.');
    }

    const normalizedUploadTo = normalizeRelativePath(uploadTo || '');
    const normalizedRelative = normalizeRelativePath(relativePath || '') || path.basename(filename);

    const context = { user: req.user, guestSession: req.guestSession };
    const { allowed, accessInfo, resolved } = await authorizeAndResolve(
      context,
      normalizedUploadTo,
      ACTIONS.upload
    );
    if (!allowed || !resolved) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Cannot upload files to this path.');
    }

    const { absolutePath: destinationRoot, relativePath: logicalBase } = resolved;
    const destinationPath = path.join(destinationRoot, normalizedRelative);
    const destinationDir = path.dirname(destinationPath);

    await ensureDir(destinationDir);

    const uploadId = crypto.randomBytes(16).toString('hex');
    const tempPath = `${destinationPath}.chunked-${uploadId}`;

    const fd = await fs.open(tempPath, 'w');
    await fd.close();

    const userId = req.user?.id || req.guestSession?.id || null;

    const upload = {
      userId,
      tempPath,
      destinationPath,
      destinationDir,
      logicalBase,
      logicalRelativePath: normalizeRelativePath(path.join(logicalBase, normalizedRelative)),
      totalSize,
      bytesReceived: 0,
      lastActivity: Date.now(),
    };
    activeUploads.set(uploadId, upload);

    // If the client disconnects before receiving the uploadId,
    // it cannot call the cancel endpoint. Clean up immediately.
    res.on('close', () => {
      if (!res.writableFinished && activeUploads.has(uploadId)) {
        fs.rm(upload.tempPath, { force: true }).catch(() => {});
        activeUploads.delete(uploadId);
        logger.info({ uploadId }, 'Cleaned up orphaned upload (client disconnected during init)');
      }
    });

    logger.info({ uploadId, filename, totalSize }, 'Chunked upload initialized');
    res.json({ uploadId });
  })
);

router.patch(
  '/chunked-upload/:uploadId',
  asyncHandler(async (req, res) => {
    const { uploadId } = req.params;
    const upload = activeUploads.get(uploadId);
    if (!upload) {
      throw new NotFoundError('Upload session not found or expired.');
    }

    const userId = req.user?.id || req.guestSession?.id || null;
    if (upload.userId !== userId) {
      throw new ForbiddenError('Upload session belongs to a different user.');
    }

    const rangeHeader = req.headers['content-range'];
    if (!rangeHeader) {
      throw new ValidationError('Content-Range header is required.');
    }

    const match = rangeHeader.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!match) {
      throw new ValidationError('Malformed Content-Range header. Expected: bytes <start>-<end>/<total>');
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);

    if (total !== upload.totalSize) {
      throw new ValidationError('Total size does not match the upload session.');
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const expectedLength = end - start + 1;

    if (data.length !== expectedLength) {
      throw new ValidationError(
        `Chunk size mismatch: expected ${expectedLength} bytes, got ${data.length}.`
      );
    }

    const fd = await fs.open(upload.tempPath, 'r+');
    try {
      await fd.write(data, 0, data.length, start);
    } finally {
      await fd.close();
    }

    upload.bytesReceived += data.length;
    upload.lastActivity = Date.now();

    res.json({ received: upload.bytesReceived });
  })
);

router.post(
  '/chunked-upload/:uploadId/complete',
  asyncHandler(async (req, res) => {
    const { uploadId } = req.params;
    const upload = activeUploads.get(uploadId);
    if (!upload) {
      throw new NotFoundError('Upload session not found or expired.');
    }

    const userId = req.user?.id || req.guestSession?.id || null;
    if (upload.userId !== userId) {
      throw new ForbiddenError('Upload session belongs to a different user.');
    }

    const stats = await fs.stat(upload.tempPath);
    if (stats.size !== upload.totalSize) {
      throw new ValidationError(
        `File size mismatch: expected ${upload.totalSize} bytes, got ${stats.size}.`
      );
    }

    let finalPath = upload.destinationPath;
    if (await pathExists(finalPath)) {
      const desiredName = path.basename(finalPath);
      const availableName = await findAvailableName(upload.destinationDir, desiredName);
      finalPath = path.join(upload.destinationDir, availableName);
    }

    await fs.rename(upload.tempPath, finalPath);
    activeUploads.delete(uploadId);

    const finalStats = await fs.stat(finalPath);
    const storedName = path.basename(finalPath);
    const extension = path.extname(storedName).toLowerCase().replace('.', '');
    const parentPath = normalizeRelativePath(path.dirname(upload.logicalRelativePath));

    logger.info({ uploadId, finalPath }, 'Chunked upload completed');

    res.json({
      name: storedName,
      path: parentPath,
      dateModified: finalStats.mtime,
      size: finalStats.size,
      kind: extension,
    });
  })
);

router.delete(
  '/chunked-upload/:uploadId',
  asyncHandler(async (req, res) => {
    const { uploadId } = req.params;
    const upload = activeUploads.get(uploadId);
    if (!upload) {
      res.json({ cancelled: false });
      return;
    }

    const userId = req.user?.id || req.guestSession?.id || null;
    if (upload.userId !== userId) {
      throw new ForbiddenError('Upload session belongs to a different user.');
    }

    await fs.rm(upload.tempPath, { force: true }).catch(() => {});
    activeUploads.delete(uploadId);
    logger.info({ uploadId }, 'Chunked upload cancelled');
    res.json({ cancelled: true });
  })
);

module.exports = router;

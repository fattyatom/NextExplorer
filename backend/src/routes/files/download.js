const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const { ZipArchive } = require('archiver');
const { normalizeRelativePath } = require('../../utils/pathUtils');
const { resolvePathWithAccess } = require('../../services/accessManager');
const activityLog = require('../../services/activityLog');
const { trackShareDownload } = require('../../services/sharesService');
const { createPlan, readPlan, ownerKeyFor } = require('../../services/downloadPlans');
const asyncHandler = require('../../utils/asyncHandler');
const { mapWithConcurrency } = require('../../utils/mapWithConcurrency');
const {
  collectArchiveEntries,
  appendEntries,
  writeZipFile,
} = require('../../services/archiveTree');
const {
  createPrepared,
  readPrepared,
  holdForRead,
  markReady,
  markFailed,
  waitUntilSettled,
  removePrepared,
} = require('../../services/preparedDownloads');
const { ensureZipWithinLimit } = require('../../services/zipDownloadLimit');
const { markLongPoll } = require('../../middleware/heldRequests');
const { parseByteRange } = require('../../utils/httpRange');
const {
  AppError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
} = require('../../errors/AppError');
const logger = require('../../utils/logger');
const { collectInputPaths, encodeContentDisposition, stripBasePath, toPosix } = require('./utils');

const router = require('express').Router();
const { clientAddress } = require('../../utils/clientAddress');

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

const normalizePaths = (paths) => {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ValidationError('At least one path is required.');
  }

  const normalizedPaths = [
    ...new Set(paths.map((item) => normalizeRelativePath(item)).filter(Boolean)),
  ];
  if (normalizedPaths.length === 0) {
    throw new ValidationError('No valid paths provided.');
  }

  return normalizedPaths;
};

/**
 * Each path resolved and checked, or nothing at all.
 *
 * Every way out of this route goes through here, including the parts of a plan
 * made minutes ago: a plan is a record of what was asked, never a permission
 * that outlives the check.
 */
const resolveTargets = async (context, normalizedPaths) =>
  // The list came in the request, so the number of resolutions in flight is
  // not the client's to choose.
  mapWithConcurrency(normalizedPaths, async (relativePath) => {
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
    const shareId = resolved.shareInfo?.sharingType === 'anyone' ? resolved.shareInfo.id : null;
    return { relativePath: logicalPath, absolutePath, stats, shareId };
  });

/**
 * A public link's own counter, for a download that came through the files
 * route rather than the share one: the same fetch, reached by a different
 * address, and a last-downloaded date that skipped it was simply wrong.
 */
const countShareDownloads = async (targets, req) => {
  const shareDownloadIds = [...new Set(targets.map(({ shareId }) => shareId).filter(Boolean))];
  await mapWithConcurrency(shareDownloadIds, (shareId) =>
    trackShareDownload(shareId, { ipAddress: clientAddress(req) })
  );
};

/**
 * What left, named once for the whole request: a selection is one download to
 * the person who asked for it, whatever it becomes on the way out — one file,
 * one archive, or a folder of files the browser wrote itself.
 */
const recordDownload = (targets, req) =>
  activityLog.record({
    action: 'file.download',
    user: req.user,
    target: targets[0].relativePath,
    detail: targets.length > 1 ? { items: targets.length } : null,
    req,
  });

const sendSingleFile = (res, absolutePath, filename) => {
  // Allow dotfiles to be downloaded (by default Express blocks them)
  res.download(absolutePath, filename, { dotfiles: 'allow' }, (err) => {
    if (err) {
      logger.error({ err }, 'Download failed');
      if (!res.headersSent) {
        res.status(500).send('Failed to download file.');
      }
    }
  });
};

const singleFileName = (target, baseNormalized) => {
  const { absolutePath, relativePath } = target;
  if (!baseNormalized) {
    return path.basename(absolutePath);
  }

  const relativePosix = stripBasePath(relativePath, baseNormalized);
  const basename = relativePosix.split('/').pop();
  return basename || path.basename(absolutePath);
};

const archiveNameFor = (targets, baseNormalized) => {
  if (targets.length === 1) {
    const baseName = getDownloadBaseName(targets[0]);
    return `${baseName || 'download'}.zip`;
  }

  if (baseNormalized) {
    const segments = baseNormalized.split(path.sep).filter(Boolean);
    const baseName = segments.length > 0 ? segments[segments.length - 1] : baseNormalized;
    if (baseName) {
      return `${baseName}.zip`;
    }
  }

  return 'download.zip';
};

/**
 * What an archive of these targets would hold, and how much of it there is.
 *
 * Only what a listing of those folders would show: never a personal root
 * inside the volume, a name listings leave out, or a path an access rule hides.
 */
const collectForArchive = (context, targets, baseNormalized) =>
  collectArchiveEntries(
    context,
    targets.map(({ relativePath, absolutePath, stats }) => {
      const entryNameRaw = isShareRootPath(relativePath)
        ? getDownloadBaseName({ relativePath, absolutePath })
        : stripBasePath(relativePath, baseNormalized);
      const entryName = entryNameRaw
        ? entryNameRaw.replace(/\\/g, '/').replace(/^\/+/, '')
        : path.basename(absolutePath);
      return { absolutePath, logicalPath: relativePath, entryName, stats };
    })
  );

const sendArchive = async ({ context, res, targets, baseNormalized, archiveName }) => {
  // Listed and measured before a header goes out, so that an archive past the
  // ceiling is refused as an ordinary error rather than cut off part way.
  const { entries, totalBytes } = await collectForArchive(context, targets, baseNormalized);
  ensureZipWithinLimit(totalBytes);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', encodeContentDisposition(archiveName));

  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.on('error', (archiveError) => {
    logger.error({ err: archiveError }, 'Archive creation failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive.' });
    } else {
      res.end();
    }
  });

  archive.pipe(res);
  appendEntries(archive, entries);

  await archive.finalize();
};

const handleDownloadRequest = async (paths, req, res, basePath = '') => {
  const normalizedPaths = normalizePaths(paths);
  const baseNormalized = basePath ? normalizeRelativePath(basePath) : '';
  const context = { user: req.user, guestSession: req.guestSession };

  const targets = await resolveTargets(context, normalizedPaths);

  await countShareDownloads(targets, req);
  await recordDownload(targets, req);

  const hasDirectory = targets.some(({ stats }) => stats.isDirectory());
  const shouldArchive = hasDirectory || targets.length > 1;

  if (!shouldArchive) {
    const [target] = targets;
    sendSingleFile(res, target.absolutePath, singleFileName(target, baseNormalized));
    return;
  }

  await sendArchive({
    context,
    res,
    targets,
    baseNormalized,
    archiveName: archiveNameFor(targets, baseNormalized),
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

/**
 * The same selection, described rather than sent (#487).
 *
 * Answers what the browser needs to take the files one by one — their names and
 * their sizes — and carries the counting and the log entry that the parts then
 * do not repeat. Folders are not split: they stay one archive alongside the
 * loose files, because a folder taken apart is a folder lost.
 */
router.post(
  '/download/plan',
  asyncHandler(async (req, res) => {
    const ownerKey = ownerKeyFor(req);
    if (!ownerKey) throw new ForbiddenError('Download not allowed.');

    const basePath = req.body?.basePath || req.body?.currentPath || '';
    const paths = collectInputPaths(req.body?.path, req.body?.paths, req.body?.items);
    const normalizedPaths = normalizePaths(paths);
    const baseNormalized = basePath ? normalizeRelativePath(basePath) : '';
    const context = { user: req.user, guestSession: req.guestSession };

    const targets = await resolveTargets(context, normalizedPaths);

    await countShareDownloads(targets, req);
    await recordDownload(targets, req);

    const fileTargets = targets.filter(({ stats }) => !stats.isDirectory());
    const directoryTargets = targets.filter(({ stats }) => stats.isDirectory());

    const token = createPlan({
      ownerKey,
      basePath: baseNormalized,
      files: fileTargets.map((target) => ({
        relativePath: target.relativePath,
        name: singleFileName(target, baseNormalized),
        size: target.stats.size,
      })),
      archive: directoryTargets.length
        ? {
            name: archiveNameFor(directoryTargets, baseNormalized),
            relativePaths: directoryTargets.map(({ relativePath }) => relativePath),
          }
        : null,
    });

    const plan = readPlan(token, ownerKey);

    res.json({
      token,
      files: plan.files.map(({ name, size }, index) => ({ index, name, size })),
      archive: plan.archive ? { name: plan.archive.name, folders: directoryTargets.length } : null,
    });
  })
);

/**
 * One part of a plan: a file by its position, or the archive holding the
 * folders that were selected with it.
 *
 * Reachable with a plain GET so the browser streams it straight to disk — an
 * anchor with `download`, or a writable file handle — instead of the page
 * holding a whole file in memory first.
 */
router.get(
  '/download/part/:token/:part',
  asyncHandler(async (req, res) => {
    const ownerKey = ownerKeyFor(req);
    const plan = ownerKey ? readPlan(req.params.token, ownerKey) : null;
    if (!plan) throw new NotFoundError('This download is no longer available.');

    const context = { user: req.user, guestSession: req.guestSession };
    const { part } = req.params;

    if (part === 'archive') {
      if (!plan.archive) throw new NotFoundError('This download has no archive.');
      const targets = await resolveTargets(context, plan.archive.relativePaths);
      await sendArchive({
        context,
        res,
        targets,
        baseNormalized: plan.basePath,
        archiveName: plan.archive.name,
      });
      return;
    }

    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || index >= plan.files.length) {
      throw new NotFoundError('This download has no such part.');
    }

    const wanted = plan.files[index];
    const [target] = await resolveTargets(context, [wanted.relativePath]);
    if (target.stats.isDirectory()) {
      throw new ValidationError('That part is a folder.');
    }

    sendSingleFile(res, target.absolutePath, wanted.name);
  })
);

/**
 * The same archive, made out of sight and fetched once it exists.
 *
 * `POST /api/download` builds the zip inside its own response, so the first
 * byte waits on the walk of everything that goes in. A proxy with a deadline on
 * that first byte — Cloudflare's is a hundred seconds — answers 524 for a large
 * folder, whatever the server is doing. Here nothing is held open across the
 * build: this answers with an id at once, the zip is written to the temp
 * directory, and `GET /api/download/prepared/<id>` says when it is ready and
 * then serves it, in ranges if asked.
 *
 * The selection is counted when its build starts — once, as the streamed
 * archive would be — and fetching it, in however many ranges, counts nothing.
 */
const buildPrepared = async ({ entry, context, targets, baseNormalized, req, counted }) => {
  try {
    const { entries, totalBytes } = await collectForArchive(context, targets, baseNormalized);
    ensureZipWithinLimit(totalBytes);

    // The archive of a plan was counted when the plan was made.
    if (!counted) {
      await countShareDownloads(targets, req);
      await recordDownload(targets, req);
    }

    await writeZipFile(entries, entry.tempPath, {
      totalBytes,
      signal: entry.controller.signal,
      onPercent: (percent) => {
        // The last few percent are the archive being closed, not done.
        entry.percent = Math.min(99, percent);
      },
    });

    const { size } = await fs.stat(entry.tempPath);
    markReady(entry, size);
    logger.info({ downloadId: entry.id, name: entry.name, size }, 'Prepared download built');
  } catch (error) {
    if (error?.code !== 'OPERATION_CANCELLED') {
      logger[error?.isOperational ? 'info' : 'error'](
        { err: error, downloadId: entry.id },
        'Prepared download was not built'
      );
    }
    markFailed(entry, error);
  }
};

router.post(
  '/download/prepare',
  asyncHandler(async (req, res) => {
    const ownerKey = ownerKeyFor(req);
    if (!ownerKey) throw new ForbiddenError('Download not allowed.');
    const context = { user: req.user, guestSession: req.guestSession };

    // The folders of a selection taken as separate files: the same archive
    // `GET /api/download/part/<token>/archive` would stream, prepared instead.
    // Resolved and checked again, as every part of a plan is; counted by the plan.
    const planToken = typeof req.body?.plan === 'string' ? req.body.plan : null;
    if (planToken) {
      const plan = readPlan(planToken, ownerKey);
      if (!plan?.archive) throw new NotFoundError('This download is no longer available.');

      const targets = await resolveTargets(context, plan.archive.relativePaths);
      const entry = createPrepared({ ownerKey, name: plan.archive.name });
      res.status(202).json({ id: entry.id, name: entry.name });
      buildPrepared({
        entry,
        context,
        targets,
        baseNormalized: plan.basePath,
        req,
        counted: true,
      });
      return;
    }

    const basePath = req.body?.basePath || req.body?.currentPath || '';
    const paths = collectInputPaths(req.body?.path, req.body?.paths, req.body?.items);
    const normalizedPaths = normalizePaths(paths);
    const baseNormalized = basePath ? normalizeRelativePath(basePath) : '';

    const targets = await resolveTargets(context, normalizedPaths);

    const hasDirectory = targets.some(({ stats }) => stats.isDirectory());
    if (!hasDirectory && targets.length === 1) {
      throw new ValidationError(
        'A single file downloads as itself and needs no preparing. Use POST /api/download.',
        null,
        'DOWNLOAD_NOT_AN_ARCHIVE'
      );
    }

    const entry = createPrepared({ ownerKey, name: archiveNameFor(targets, baseNormalized) });
    res.status(202).json({ id: entry.id, name: entry.name });

    // Not awaited: the answer above is the whole point. Its own failures are
    // kept on the entry and told to whoever asks for it next.
    buildPrepared({ entry, context, targets, baseNormalized, req, counted: false });
  })
);

/** How long a readiness question is held before it is answered "not yet". */
const READY_WAIT_MS = 20 * 1000;

/** Larger reads than the 64 KB default keep a proxied socket fed. */
const READ_CHUNK_BYTES = 1024 * 1024;

const sendPreparedFile = (req, res, entry) => {
  const headers = {
    'Content-Type': 'application/zip',
    'Content-Disposition': encodeContentDisposition(entry.name),
    'Accept-Ranges': 'bytes',
    // One reader, once: nothing between here and them should keep or rewrite it.
    'Cache-Control': 'no-store, no-transform',
  };

  const range = parseByteRange(req.headers.range, entry.size);
  if (range?.malformed) {
    res.status(416).send('Malformed Range header');
    return;
  }
  if (range?.unsatisfiable) {
    res.status(416).set('Content-Range', `bytes */${entry.size}`).send('Range Not Satisfiable');
    return;
  }

  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${entry.size}`,
      'Content-Length': range.chunkSize,
    });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': entry.size });
  }

  if (req.method === 'HEAD' || entry.size === 0) {
    res.end();
    return;
  }

  const stream = fss.createReadStream(entry.tempPath, {
    ...(range ? { start: range.start, end: range.end } : {}),
    highWaterMark: READ_CHUNK_BYTES,
  });
  stream.on('error', (error) => {
    logger.error({ err: error, downloadId: entry.id }, 'Prepared download stream failed');
    res.destroy(error);
  });
  const release = holdForRead(entry);
  // A reader that goes away part way must not leave the file open behind it.
  res.on('close', () => {
    stream.destroy();
    release();
  });
  stream.pipe(res);
};

/**
 * A prepared archive: 202 while it is being built, the file once it is.
 *
 * `?wait=1` holds the question for up to twenty seconds — well inside any
 * proxy's patience — so a caller asks a few times rather than every second.
 */
const answerPrepared = asyncHandler(async (req, res) => {
  const ownerKey = ownerKeyFor(req);
  const entry = ownerKey ? readPrepared(req.params.id, ownerKey) : null;
  if (!entry) throw new NotFoundError('This download is no longer available.');

  if (entry.state === 'building' && req.query?.wait) {
    markLongPoll(req);
    await waitUntilSettled(entry, READY_WAIT_MS);
  }

  if (entry.state === 'failed') {
    throw new AppError(entry.error.message, entry.error.statusCode, entry.error.code);
  }

  if (entry.state === 'building') {
    res.set('Cache-Control', 'no-store');
    res.status(202).json({ status: 'building', percent: entry.percent });
    return;
  }

  sendPreparedFile(req, res, entry);
});

router.get('/download/prepared/:id', answerPrepared);

/** Give up on a prepared archive: stops the build and removes the file. */
router.delete(
  '/download/prepared/:id',
  asyncHandler(async (req, res) => {
    const ownerKey = ownerKeyFor(req);
    const entry = ownerKey ? readPrepared(req.params.id, ownerKey) : null;
    // Somebody else's, expired, or never made: there is nothing of theirs to remove.
    if (entry) removePrepared(entry.id);
    res.status(204).end();
  })
);

module.exports = router;

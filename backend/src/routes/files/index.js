const express = require('express');
const folderRoutes = require('./folder');
const renameRoutes = require('./rename');
const transferRoutes = require('./transfer');
const deleteRoutes = require('./delete');
const downloadRoutes = require('./download');
const rangeDownloadRoutes = require('./rangeDownload');
const previewRoutes = require('./preview');

const router = express.Router();

router.use(folderRoutes);
router.use(renameRoutes);
router.use(transferRoutes);
router.use(deleteRoutes);
router.use(downloadRoutes);
router.use(rangeDownloadRoutes);
router.use(previewRoutes);

module.exports = router;

// /api/media.api.js

import { buildUrl, normalizePath, requestJson } from './http';

// GET /api/media/tracks — the video, audio and subtitle streams inside a file.
// `available:false` means ffprobe is not there to look, which is not the same
// as a file that genuinely carries no subtitles.
async function fetchMediaTracks(relativePath, options = {}) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath) return null;

  const params = new URLSearchParams({ path: normalizedPath });
  return requestJson(`/api/media/tracks?${params.toString()}`, { ...options, method: 'GET' });
}

// GET /api/media/subtitle — one subtitle track as WebVTT. A URL rather than a
// fetch, because it is handed straight to a <track src>. The track is named the
// way the inventory named it: embedded streams by index, sidecars by filename.
function getSubtitleUrl(relativePath, track) {
  const normalizedPath = normalizePath(relativePath);
  if (!normalizedPath || !track) return null;

  const params = new URLSearchParams({ path: normalizedPath });
  if (track.source === 'sidecar' && track.fileName) {
    params.set('file', track.fileName);
  } else if (track.index !== null && track.index !== undefined) {
    params.set('stream', String(track.index));
  } else {
    return null;
  }

  return buildUrl(`/api/media/subtitle?${params.toString()}`);
}

export { fetchMediaTracks, getSubtitleUrl };

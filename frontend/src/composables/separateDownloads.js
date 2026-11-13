import {
  cancelPreparedDownload,
  downloadPartUrl,
  fetchDownloadPart,
  preparePlanArchive,
} from '@/api';
import {
  awaitFirstRange,
  handPreparedToBrowser,
  writePreparedToFile,
} from '@/composables/preparedDownloads';

/**
 * Taking a selection away as separate files rather than as one archive (#487).
 *
 * There are two ways a browser will do that, and they are not the same thing.
 *
 * Where the File System Access API exists, the reader picks a folder once and
 * the files are written into it: no permission prompt, a destination they chose,
 * and a progress figure that comes from the bytes rather than from hope.
 *
 * Everywhere else the parts are fetched as ordinary downloads, one anchor each.
 * The browser asks once whether it may download several files — and if the
 * answer is no, nothing arrives — then puts them wherever downloads go, with
 * its own idea of what to do about two files of the same name.
 *
 * Both write the same set: the loose files, plus one archive holding whichever
 * folders were selected. A folder is never taken apart.
 */

/** Whether the reader can be asked for a folder to write into. */
export const canWriteToChosenFolder = () =>
  typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/**
 * Ask for that folder. Null means the reader closed the picker, which is an
 * answer and not a failure.
 */
export const chooseDownloadFolder = async () => {
  try {
    return await window.showDirectoryPicker({
      id: 'nextexplorer-download',
      mode: 'readwrite',
      startIn: 'downloads',
    });
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    throw error;
  }
};

/** The parts of a plan, in the order they are taken: files first, archive last. */
export const partsOf = (plan) => [
  ...(plan?.files || []).map(({ index, name, size }) => ({ part: index, name, size })),
  ...(plan?.archive ? [{ part: 'archive', name: plan.archive.name, size: null }] : []),
];

/**
 * The byte total worth reporting, or 0 when there is none.
 *
 * An archive is built as it is sent, so its length is not known before it
 * arrives. A total that left it out would be passed while files were still
 * coming, so a selection holding a folder reports its progress in parts
 * instead — a figure that is right rather than one that is precise.
 */
export const knownTotalBytes = (plan) => {
  if (plan?.archive) return 0;
  return (plan?.files || []).reduce((total, file) => total + (Number(file.size) || 0), 0);
};

const nameIsTaken = async (folder, name) => {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch (error) {
    if (error?.name === 'NotFoundError') return false;
    // Something of that name is there and is not a file: a folder.
    if (error?.name === 'TypeMismatchError') return true;
    throw error;
  }
};

/** How many names are tried before giving up on one file. */
const NAME_ATTEMPTS = 200;

/**
 * A name nothing in that folder answers to yet.
 *
 * `getFileHandle(name, { create: true })` opens whatever is already called that
 * and lets it be written over, which is the one thing this application does not
 * do to a file it did not create. There is no create-if-absent in the API, so
 * the name is asked about first — a race this code cannot lose, since the only
 * other writer is the reader's own file manager, and the alternative is
 * destroying a file of theirs without a word.
 */
const freeFileHandle = async (folder, name) => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem} (${attempt})${extension}`;
    if (!(await nameIsTaken(folder, candidate))) {
      return {
        handle: await folder.getFileHandle(candidate, { create: true }),
        name: candidate,
        renamed: attempt > 0,
      };
    }
  }

  const error = new Error(`No free name for ${name}.`);
  error.noFreeName = true;
  throw error;
};

/**
 * The archive of a plan is not streamed: the server makes it out of sight and
 * it is fetched once it exists, like any other zip of a folder. A response that
 * waits on the build is one a proxy with a deadline gives up on.
 *
 * A refusal on the way was not reported by the client — these requests answer
 * for themselves — so it is handed on as an ordinary error for the caller to say.
 */
const unreported = (error) => {
  if (!error?.statusCode) return error;
  return new Error(error.message);
};

const prepareArchiveOf = async (plan, { signal, rangeBytes } = {}) => {
  const prepared = await preparePlanArchive(plan.token, { signal, suppressErrorHandler: true });
  try {
    const first = await awaitFirstRange({
      id: prepared.id,
      signal,
      ...(rangeBytes ? { rangeBytes } : {}),
    });
    return { id: prepared.id, first };
  } catch (error) {
    cancelPreparedDownload(prepared.id);
    throw error;
  }
};

/**
 * Write every part of a plan into a folder the reader picked.
 *
 * `onProgress` is called with the bytes written so far and the parts finished,
 * so the caller can report whichever of the two it has a total for.
 */
export const writePartsToFolder = async ({ plan, folder, signal, onProgress } = {}) => {
  const parts = partsOf(plan);
  const renamed = [];
  let writtenBytes = 0;

  for (let position = 0; position < parts.length; position += 1) {
    if (signal?.aborted) break;
    const entry = parts[position];

    if (entry.part === 'archive') {
      const before = writtenBytes;
      let prepared = null;
      let target = null;
      try {
        prepared = await prepareArchiveOf(plan, { signal });
        target = await freeFileHandle(folder, entry.name);
        if (target.renamed) renamed.push(target.name);
        await writePreparedToFile({
          id: prepared.id,
          first: prepared.first,
          fileHandle: target.handle,
          signal,
          onProgress: (written) => {
            writtenBytes = before + written;
            onProgress?.({ writtenBytes, finishedParts: position, totalParts: parts.length });
          },
        });
      } catch (error) {
        if (target) await folder.removeEntry(target.name).catch(() => {});
        throw unreported(error);
      } finally {
        if (prepared) cancelPreparedDownload(prepared.id);
      }
      onProgress?.({ writtenBytes, finishedParts: position + 1, totalParts: parts.length });
      continue;
    }

    const response = await fetchDownloadPart(plan.token, entry.part, { signal });
    const target = await freeFileHandle(folder, entry.name);
    if (target.renamed) renamed.push(target.name);

    const writable = await target.handle.createWritable();
    const reader = response.body?.getReader();

    try {
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          writtenBytes += value.byteLength;
          onProgress?.({ writtenBytes, finishedParts: position, totalParts: parts.length });
        }
      } else {
        // A response without a readable body: older engines hand over a blob.
        const blob = await response.blob();
        await writable.write(blob);
        writtenBytes += blob.size;
      }
      await writable.close();
    } catch (error) {
      // Nothing of this file was committed, but the name was taken the moment
      // the handle was created. Take it back: this is ours to clean up, and
      // leaving an empty file behind would look like a download that worked.
      await writable.abort().catch(() => {});
      await folder.removeEntry(target.name).catch(() => {});
      throw error;
    }

    onProgress?.({ writtenBytes, finishedParts: position + 1, totalParts: parts.length });
  }

  return { renamed, writtenBytes, parts: parts.length };
};

/** Long enough that a browser treats these as one batch of downloads. */
const CLICK_SPACING_MS = 150;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take every part as an ordinary download, one anchor at a time.
 *
 * The anchor names the file as well, even though the response says so too: a
 * browser that cannot read the header still gets the name the plan gave it,
 * suffixed where two files of the selection were called the same thing.
 */
export const clickPartsThrough = async ({ plan, spacingMs = CLICK_SPACING_MS } = {}) => {
  const parts = partsOf(plan);

  for (let position = 0; position < parts.length; position += 1) {
    const entry = parts[position];

    if (entry.part === 'archive') {
      // Waited for here, then taken by the browser as one ordinary request for
      // a file that already exists. Not removed: the browser has yet to ask.
      try {
        const prepared = await prepareArchiveOf(plan, { rangeBytes: 1 });
        handPreparedToBrowser({ id: prepared.id, name: entry.name });
      } catch (error) {
        throw unreported(error);
      }
      continue;
    }

    const anchor = document.createElement('a');
    anchor.href = downloadPartUrl(plan.token, entry.part);
    anchor.download = entry.name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    // Clicked in one burst, some of them are dropped. Spaced out, they are not.
    if (position < parts.length - 1) await wait(spacingMs);
  }

  return { parts: parts.length };
};

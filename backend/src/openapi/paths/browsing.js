const {
  ref,
  obj,
  arrayOf,
  str,
  num,
  int,
  bool,
  nullable,
  dateTime,
  json,
  stream,
  errors,
  splatParam,
  pathParam,
  query,
  header,
  body,
  op,
} = require('../build');

const TAG = 'Browsing';

const volume = obj(
  {
    name: str(),
    path: str(),
    kind: str(null, { enum: ['volume', 'personal'] }),
    readOnly: nullable(
      str(
        'Why nothing can be written in it, for the mark beside its name: `storage` for a read-only mount, `permission` for a folder the server may not write in, `access` when a rule or its assignment keeps this account to reading. Null when something can be written.',
        { enum: ['storage', 'permission', 'access', null] }
      )
    ),
  },
  ['name', 'path', 'kind']
);

module.exports = {
  '/api/volumes': {
    get: op({
      id: 'listVolumes',
      summary: 'The places this account can start from',
      description:
        'The volume’s top folders, the personal folder when there is one, and for somebody given assigned volumes, those instead.',
      tag: TAG,
      access: 'account',
      responses: { 200: json(arrayOf(volume)), ...errors(401) },
    }),
  },
  '/api/browse/{path}': {
    get: op({
      id: 'browse',
      summary: 'What a folder holds, and what this caller may do there',
      description:
        '`path` is a volume path (`Documents/2026`), `personal/…` for the personal folder, or an assigned volume’s label. Hidden files are listed when the account has asked to see them.',
      tag: TAG,
      access: 'account',
      params: [splatParam()],
      responses: {
        200: json(
          obj(
            {
              items: arrayOf(ref('Item')),
              access: ref('Access'),
              current: obj({ isDirectory: bool() }),
              path: str('The folder, as it was resolved.'),
            },
            ['items', 'access', 'path']
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/usage/{path}': {
    get: op({
      id: 'getVolumeUsage',
      summary: 'How full the file system under a path is',
      tag: TAG,
      access: 'account',
      params: [splatParam()],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              size: num(),
              used: num(),
              free: num(),
              total: num(),
              percentUsed: num(),
            },
            ['path']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/metadata/{path}': {
    get: op({
      id: 'getMetadata',
      summary: 'What is known about one file or folder',
      description:
        'For a folder, the total of what is inside it, counted now and stopped at a bound (`truncated`). For an image, a video or a document, what reading it says — dimensions, duration, pages.',
      tag: TAG,
      access: 'account',
      params: [splatParam('The file or folder.')],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              name: str(),
              kind: str(),
              size: num(),
              dateModified: dateTime(),
              dateCreated: dateTime(),
              directory: obj({
                totalSize: num(),
                fileCount: int(),
                dirCount: int(),
                truncated: bool(),
              }),
            },
            ['path', 'name', 'kind'],
            { additionalProperties: true }
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/search': {
    get: op({
      id: 'search',
      summary: 'Find files by name and by what they say',
      description:
        'Names first, closest match first; then documents that contain the term, the most relevant first. The term is a word or the beginning of one, three characters at least; `*` and `?` make it a pattern for names. `truncated` says the search ran out of time before looking everywhere, `complete` that the page is the whole answer.',
      tag: 'Search',
      access: 'account',
      params: [
        query('q', 'What to look for.', { type: 'string', minLength: 3 }, true),
        query('path', 'Where to start; the top when absent.'),
        query('limit', 'How many, up to 500.', {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 100,
        }),
      ],
      responses: {
        200: json(
          obj(
            {
              items: arrayOf(
                obj(
                  {
                    name: str(),
                    path: str(),
                    kind: str(null, { enum: ['file', 'dir'] }),
                    matchLine: str('The line that holds the term, for a match inside a file.'),
                    matchLineNumber: int(),
                    matchedName: bool(),
                    matchedContent: bool(),
                  },
                  ['name', 'path', 'kind']
                )
              ),
              truncated: bool(),
              limit: int(),
              complete: bool(),
            },
            ['items', 'truncated', 'limit', 'complete']
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/permissions/{path}': {
    get: op({
      id: 'getFilePermissions',
      summary: 'Owner, group and mode of a file on the server',
      tag: TAG,
      access: 'account',
      params: [splatParam('The file or folder.')],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              mode: int('The full `st_mode`.'),
              owner: str(),
              group: str(),
              uid: int(),
              gid: int(),
              isDirectory: bool(),
            },
            ['path', 'mode']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/permissions/chmod': {
    post: op({
      id: 'changeFileMode',
      summary: 'Change the mode of a file on the server',
      tag: 'Administration',
      access: 'admin',
      body: body(
        obj(
          {
            path: str(),
            mode: str('Octal, as `chmod` takes it — `644`, `0755`.'),
            recursive: bool(),
          },
          ['path', 'mode']
        )
      ),
      responses: {
        200: json(obj({ success: bool(), path: str(), mode: int() }, ['success', 'path', 'mode'])),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/permissions/chown': {
    post: op({
      id: 'changeFileOwner',
      summary: 'Change the owner or group of a file on the server',
      description: 'Usually refused unless the server runs as root.',
      tag: 'Administration',
      access: 'admin',
      body: body(obj({ path: str(), owner: str(), group: str() }, ['path'])),
      responses: {
        200: json(
          obj({ success: bool(), path: str() }, ['success', 'path'], { additionalProperties: true })
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/folder-size/{path}': {
    get: op({
      id: 'getFolderSize',
      summary: 'How much a folder holds, from the index',
      description: '`404` when folder sizes are off.',
      tag: 'Folder sizes',
      access: 'account',
      params: [splatParam('The folder.')],
      responses: { 200: json(ref('FolderSize')), ...errors(401, 403, 404) },
    }),
  },
  '/api/folder-size/batch': {
    post: op({
      id: 'getFolderSizes',
      summary: 'Sizes of several folders at once',
      tag: 'Folder sizes',
      access: 'account',
      body: body(obj({ paths: arrayOf(str()) }, ['paths'])),
      responses: {
        200: json(
          obj(
            {
              results: arrayOf(ref('FolderSize')),
              truncated: bool('More paths were asked for than one call answers.'),
            },
            ['results', 'truncated']
          )
        ),
        ...errors(400, 401, 404),
      },
    }),
  },
  '/api/folder-size/refresh/{path}': {
    post: op({
      id: 'refreshFolderSize',
      summary: 'Count a folder again',
      description: 'Queued; `400` until the index has finished its first pass.',
      tag: 'Folder sizes',
      access: 'account',
      params: [splatParam('The folder.')],
      responses: {
        202: json(obj({}, [], { additionalProperties: true }), 'Queued.'),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/thumbnails/{path}': {
    get: op({
      id: 'getThumbnail',
      summary: 'Where the thumbnail of an image or video is, once it exists',
      description:
        '`thumbnail` is a URL under `/static/thumbnails`, or empty while it is being made (`202`, `pending`).',
      tag: 'Previews',
      access: 'account',
      params: [
        splatParam('The file.'),
        query('background', '`1` for a prefetch that may wait behind what is on screen.', {
          type: 'string',
          enum: ['1'],
        }),
      ],
      responses: {
        200: json(obj({ thumbnail: str(), pending: bool() }, ['thumbnail'])),
        202: json(
          obj({ thumbnail: str(), pending: bool(), queued: bool() }, ['thumbnail']),
          'Being made.'
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/preview': {
    get: op({
      id: 'getPreview',
      summary: 'A file’s content, for showing it',
      description:
        'Images, video, audio and PDF, with `Range` for media. `415` for a kind that has no preview.',
      tag: 'Previews',
      access: 'account',
      params: [
        query('path', 'The file.', { type: 'string' }, true),
        header('Range', 'Part of it, for media.'),
      ],
      responses: {
        200: stream('application/octet-stream', 'The file, with its own content type.'),
        206: stream('application/octet-stream', 'The part asked for.'),
        ...errors(401, 403, 404, 415),
        416: { description: 'The range is outside the file.' },
      },
    }),
  },
  '/api/media/tracks': {
    get: op({
      id: 'getMediaTracks',
      summary: 'The video, audio and subtitle tracks of a media file',
      tag: 'Previews',
      access: 'account',
      params: [query('path', 'The file.', { type: 'string' }, true)],
      responses: {
        200: json(
          obj(
            {
              available: bool('Whether the tracks could be read at all.'),
              video: arrayOf(obj({}, [], { additionalProperties: true })),
              audio: arrayOf(obj({}, [], { additionalProperties: true })),
              subtitles: arrayOf(obj({}, [], { additionalProperties: true })),
            },
            ['available']
          )
        ),
        ...errors(401, 403, 404, 415),
      },
    }),
  },
  '/api/media/subtitle': {
    get: op({
      id: 'getSubtitle',
      summary: 'One subtitle track, as WebVTT',
      tag: 'Previews',
      access: 'account',
      params: [
        query('path', 'The media file.', { type: 'string' }, true),
        query('stream', 'A track inside the file, from `/api/media/tracks`.'),
        query('file', 'A subtitle file beside it, by name.'),
      ],
      responses: {
        200: stream('text/vtt', 'The track.'),
        ...errors(400, 401, 403, 404, 415),
      },
    }),
  },
  '/api/download': {
    post: op({
      id: 'download',
      summary: 'Download a file, or several as one zip',
      description:
        'One file comes back as itself; several, or a folder, as a zip made as it is sent. The one POST a `read` API token may make.',
      tag: 'Files',
      access: 'account',
      body: body(
        obj({
          basePath: str('The folder the names are relative to, which the zip starts from.'),
          currentPath: str('Older name for `basePath`.', { deprecated: true }),
          path: str('One path.'),
          paths: arrayOf(str()),
          items: arrayOf(obj({ path: str(), name: str() })),
        })
      ),
      responses: {
        200: {
          description: 'The file, or a zip.',
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            'application/zip': { schema: { type: 'string', format: 'binary' } },
          },
        },
        ...errors(400, 401, 403, 404, 413),
      },
    }),
  },
  '/api/download/plan': {
    post: op({
      id: 'planDownload',
      summary: 'The same selection, described instead of sent',
      description:
        'Answers the names and sizes of the loose files, the one zip the selected folders become, and a token naming those parts — for taking a selection away as separate files rather than as one archive. This is where a public link’s download is counted and where the activity log names it, once for the selection, so fetching the parts adds neither. The token is worth ten minutes from its last use and only to the caller who asked for it. The other POST a `read` API token may make.',
      tag: 'Files',
      access: 'account',
      body: body(
        obj({
          basePath: str('The folder the names are relative to, which the zip starts from.'),
          currentPath: str('Older name for `basePath`.', { deprecated: true }),
          path: str('One path.'),
          paths: arrayOf(str()),
          items: arrayOf(obj({ path: str(), name: str() })),
        })
      ),
      responses: {
        200: json(
          obj(
            {
              token: str('Names the parts; needed for every one of them.'),
              files: arrayOf(
                obj(
                  {
                    index: int('What to ask for this file as.'),
                    name: str('What to call it, already free of collisions within the selection.'),
                    size: int('Its length in bytes.'),
                  },
                  { required: ['index', 'name', 'size'] }
                )
              ),
              archive: nullable(
                obj(
                  {
                    name: str('What to call the zip.'),
                    folders: int('How many selected folders are in it.'),
                  },
                  { required: ['name', 'folders'] }
                ),
                'Absent when nothing selected was a folder.'
              ),
            },
            { required: ['token', 'files'] }
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/download/part/{token}/{part}': {
    get: op({
      id: 'downloadPart',
      summary: 'One part of a planned download',
      description:
        'A file by its position in the plan, or `archive` for the zip holding the folders that were selected with it. Every part is resolved and checked again: a plan records what was asked and never carries the permission forward. Neither the link’s counter nor the activity log moves here — the plan already accounted for the selection.',
      tag: 'Files',
      access: 'account',
      params: [
        pathParam('token', 'The token the plan answered with.'),
        pathParam('part', 'A file’s index, or `archive`.'),
      ],
      responses: {
        200: {
          description: 'The file, or the zip.',
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            'application/zip': { schema: { type: 'string', format: 'binary' } },
          },
        },
        ...errors(400, 401, 403, 404, 413),
      },
    }),
  },
  '/api/download/prepare': {
    post: op({
      id: 'prepareDownload',
      summary: 'Have a zip made out of sight, to fetch once it exists',
      description:
        'The same selection `POST /api/download` would zip, built to a temp file instead of inside a response. Answers with an id at once, so nothing is held open across the build — which is what a proxy with a deadline on the first byte (Cloudflare’s 524) needs. A selection that is one file is refused: it downloads as itself. This is where a public link’s download is counted and the activity log names it, once the build starts. The archive is worth thirty minutes from its last use and only to the caller who asked for it. A POST a `read` API token may make.',
      tag: 'Files',
      access: 'account',
      body: body(
        obj({
          basePath: str('The folder the names are relative to, which the zip starts from.'),
          currentPath: str('Older name for `basePath`.', { deprecated: true }),
          path: str('One path.'),
          paths: arrayOf(str()),
          items: arrayOf(obj({ path: str(), name: str() })),
          plan: str(
            'Instead of paths: the token of a download plan, to prepare the zip of the folders in it. The plan already counted the download, so this does not.'
          ),
        })
      ),
      responses: {
        202: json(
          obj(
            {
              id: str('Names the archive being built; needed to ask for it.'),
              name: str('What to call the zip.'),
            },
            { required: ['id', 'name'] }
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/download/prepared/{id}': {
    get: op({
      id: 'fetchPreparedDownload',
      summary: 'A prepared zip: whether it is ready, then the zip itself',
      description:
        '202 while the archive is being built, with how far along it is; the zip once it exists. A `Range` header is honoured, so it can be taken in parts and a part that failed asked for again. A build that was refused answers with that refusal — 413 for a selection past `MAX_DOWNLOAD_ZIP_SIZE`. Neither the link’s counter nor the activity log moves here.',
      tag: 'Files',
      access: 'account',
      params: [
        pathParam('id', 'The id the preparation answered with.'),
        query(
          'wait',
          'Hold the question for up to twenty seconds while the archive is still being built, rather than answering 202 at once.'
        ),
        header('Range', 'A byte range of the finished zip, `bytes=0-1048575`.'),
      ],
      responses: {
        200: {
          description: 'The zip.',
          content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
        },
        202: json(
          obj(
            {
              status: str(null, { enum: ['building'] }),
              percent: int('How much of it has been written, 0 to 99.'),
            },
            { required: ['status', 'percent'] }
          )
        ),
        206: {
          description: 'The part of the zip that was asked for.',
          content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
        },
        416: { description: 'A range the zip does not have.' },
        ...errors(401, 403, 404, 413),
      },
    }),
    delete: op({
      id: 'cancelPreparedDownload',
      summary: 'Give up on a prepared zip',
      description:
        'Stops the build if it is still running and removes the temp file. Answers 204 whether or not there was anything of this caller’s to remove.',
      tag: 'Files',
      access: 'account',
      params: [pathParam('id', 'The id the preparation answered with.')],
      responses: { 204: { description: 'Gone.' }, ...errors(401, 403) },
    }),
  },
};

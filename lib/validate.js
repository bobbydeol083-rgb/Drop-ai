// Drop AI launcher — pure IPC argument validators for the Knowledge/Assets screens.
// Copyright by Dork Industry.
//
// These run on the main-process side of the IPC boundary. They never touch
// the filesystem, the network, or Electron: every function takes plain data
// and either returns a normalized value or throws an Error describing the
// problem. Safe to unit-test with plain node.

export const ASSET_TYPES = ['mogrt', 'lut', 'broll', 'other'];
export const TRACK_TYPES = ['video', 'audio'];

export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_QUERY_LEN = 500;
export const MAX_UPLOAD_PATHS = 50;
export const MAX_CLIP_NAME_LEN = 120;
export const MAX_TRACK_INDEX = 99;

const TIMECODE_RE = /^(\d+):([0-5]\d):([0-5]\d)[:;](\d{1,2})$/;

function err(msg) {
  return new Error(msg);
}

function asTrimmedString(value, { maxLen, field }) {
  if (typeof value !== 'string') throw err(`${field} must be a string`);
  const s = value.trim();
  if (s.length > maxLen) throw err(`${field} must be at most ${maxLen} characters`);
  return s;
}

/**
 * Parse a comma-separated tag string (or pass through an array of tags).
 * parseTags("a, b,,c") -> ["a","b","c"]. Duplicates are removed, order kept.
 * Never throws: non-string/non-array input yields [].
 */
export function parseTags(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().slice(0, MAX_TAG_LEN);
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Validate a knowledge search query. Returns the trimmed query. */
export function validateKnowledgeSearch(query) {
  const q = asTrimmedString(query, { maxLen: MAX_QUERY_LEN, field: 'query' });
  if (q.length === 0) throw err('query must not be empty');
  return q;
}

/**
 * Validate the optional `paths` argument of dropai:knowledgeUpload.
 * `undefined` means "let main open the file dialog". Returns a string array.
 */
export function validateKnowledgeUploadPaths(paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw err('paths must be an array of file paths');
  if (paths.length > MAX_UPLOAD_PATHS) throw err(`at most ${MAX_UPLOAD_PATHS} files per upload`);
  return paths.map((p, i) => {
    if (typeof p !== 'string' || p.trim().length === 0) {
      throw err(`paths[${i}] must be a non-empty string`);
    }
    return p;
  });
}

/** Validate dropai:assetAdd args. Returns { type, tags, description, storage }. */
export function validateAssetAddArgs(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err('args must be an object');
  }
  let type = 'other';
  if (raw.type !== undefined && raw.type !== null && String(raw.type).trim() !== '') {
    type = String(raw.type).trim().toLowerCase();
    if (!ASSET_TYPES.includes(type)) throw err(`type must be one of: ${ASSET_TYPES.join(', ')}`);
  }
  const tags = parseTags(raw.tags);
  const description =
    raw.description === undefined || raw.description === null
      ? ''
      : asTrimmedString(raw.description, { maxLen: MAX_DESCRIPTION_LEN, field: 'description' });
  const storage = validateAssetStorage(raw.storage);
  return { type, tags, description, storage };
}

/**
 * Validate the optional `storage` descriptor for a remote-backed asset.
 * Returns null for local assets (absent or { backend: 'local' }).
 */
export function validateAssetStorage(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw err('storage must be an object');
  const backend = typeof raw.backend === 'string' ? raw.backend.trim() : '';
  if (backend === '' || backend === 'local') return null;
  if (backend !== 'gdrive') throw err('storage.backend must be "gdrive"');
  const fileId = typeof raw.fileId === 'string' ? raw.fileId.trim() : '';
  if (fileId.length === 0) throw err('storage.fileId is required for gdrive assets');
  const out = { backend: 'gdrive', fileId };
  for (const key of ['fileName', 'mimeType', 'checksum']) {
    if (typeof raw[key] === 'string' && raw[key].trim().length > 0) out[key] = raw[key].trim();
  }
  if (raw.size !== undefined && raw.size !== null) {
    const size = Number(raw.size);
    if (!Number.isInteger(size) || size < 0) throw err('storage.size must be a non-negative integer');
    out.size = size;
  }
  return out;
}

/** Normalize a HH:MM:SS:FF timecode (";" separator accepted). Returns HH:MM:SS:FF. */
export function validateTimecodeInput(tc) {
  if (typeof tc !== 'string') throw err('positionTimecode must be a string');
  const m = tc.trim().match(TIMECODE_RE);
  if (!m) throw err('positionTimecode must look like HH:MM:SS:FF');
  return `${m[1]}:${m[2]}:${m[3]}:${m[4]}`;
}

/** Validate dropai:assetPlace args. Returns normalized { assetId, trackType, trackIndex, positionTimecode, clipName }. */
export function validateAssetPlaceArgs(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw err('args must be an object');
  }
  const assetId = asTrimmedString(raw.assetId, { maxLen: 200, field: 'assetId' });
  if (assetId.length === 0) throw err('assetId must not be empty');
  const trackType = typeof raw.trackType === 'string' ? raw.trackType.trim().toLowerCase() : '';
  if (!TRACK_TYPES.includes(trackType)) throw err(`trackType must be one of: ${TRACK_TYPES.join(', ')}`);
  const trackIndex = raw.trackIndex;
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex > MAX_TRACK_INDEX) {
    throw err(`trackIndex must be an integer between 0 and ${MAX_TRACK_INDEX}`);
  }
  const positionTimecode = validateTimecodeInput(raw.positionTimecode);
  const clipName =
    raw.clipName === undefined || raw.clipName === null || String(raw.clipName).trim() === ''
      ? ''
      : asTrimmedString(raw.clipName, { maxLen: MAX_CLIP_NAME_LEN, field: 'clipName' });
  return { assetId, trackType, trackIndex, positionTimecode, clipName };
}

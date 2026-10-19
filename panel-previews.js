// Drop AI — CEP panel GIF preview generation.
// Copyright by Dork Industry.
//
// At panel-sync time the launcher renders lightweight looping GIFs for video
// assets with ffmpeg (downscaled, low fps, first seconds only). The GIFs are
// stored as SIDECAR files under <dataDir>/panel/previews/ and referenced
// from the panel-facing sync files (panel-assets.json / panel-library.json)
// — the asset store schema is untouched.

import { existsSync, mkdirSync, statSync, unlinkSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

// Video extensions eligible for a GIF preview.
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']);

// .mogrt files are zips — prefer the embedded thumb.mp4/thumb.png for the
// preview instead of trying to render the template itself (ffmpeg cannot
// read .mogrt). Falls back to the normal render path when absent.
const MOGRT_THUMB_NAMES = ['thumb.mp4', 'thumb.png'];

// Preview spec: first 3 seconds, 8 fps, 320px wide, 64-color palette, loop.
const PREVIEW_SECONDS = 3;
const PREVIEW_FPS = 8;
const PREVIEW_WIDTH = 320;
const PREVIEW_COLORS = 64;
const FFMPEG_TIMEOUT_MS = 90000;

// Max video assets to (re)render per sync — keeps startup sync fast.
const MAX_PREVIEWS_PER_SYNC = 40;

let ffmpegPathCache = null;
let ffmpegChecked = false;

/** Resolve the ffmpeg binary (same order as @drop-ai/reference: env, bundled, PATH). */
async function resolveFfmpeg(logger) {
  if (ffmpegChecked) return ffmpegPathCache;
  ffmpegChecked = true;
  try {
    const { resolveFfmpegPaths } = await import('@drop-ai/reference/ffmpeg.js');
    ffmpegPathCache = resolveFfmpegPaths().ffmpeg;
  } catch {
    ffmpegPathCache = process.env.DORK_DROP_AI_FFMPEG || 'ffmpeg';
  }
  // Verify it actually runs.
  const ok = await new Promise((resolve) => {
    const child = spawn(ffmpegPathCache, ['-version'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(false);
    }, 15000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  if (!ok) {
    logger?.append('panel-sync', 'ffmpeg not available — skipping GIF previews');
    ffmpegPathCache = null;
  }
  return ffmpegPathCache;
}

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('ffmpeg timed out'));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on('data', (c) => {
      stderr += c.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** Render a short looping GIF preview of a video file. Two-pass palette for quality. */
async function renderGif(ffmpeg, srcPath, gifPath, previewsDir) {
  const vfBase = `fps=${PREVIEW_FPS},scale=${PREVIEW_WIDTH}:-1:flags=lanczos`;
  const palettePath = path.join(previewsDir, `.palette-${process.pid}.png`);
  const durArgs = ['-y', '-v', 'error', '-ss', '0', '-t', String(PREVIEW_SECONDS), '-i', srcPath];
  try {
    await runFfmpeg(ffmpeg, [...durArgs, '-vf', `${vfBase},palettegen=max_colors=${PREVIEW_COLORS}`, palettePath]);
    await runFfmpeg(ffmpeg, [
      ...durArgs,
      '-i', palettePath,
      '-lavfi', `${vfBase}[x];[x][1:v]paletteuse`,
      '-loop', '0',
      gifPath,
    ]);
  } finally {
    try { unlinkSync(palettePath); } catch { /* ignore */ }
  }
}

/**
 * Extract an embedded thumbnail (thumb.mp4 preferred, else thumb.png) from a
 * .mogrt file (which is a zip). Minimal zip reader: EOCD scan, stored/deflate
 * entries only — no new dependencies (uses node:zlib).
 *
 * @param {string} mogrtPath absolute path to the .mogrt file
 * @param {string} destDir directory to write the extracted thumb into
 * @returns {string|null} absolute path of the extracted thumb, or null
 */
export function extractMogrtThumb(mogrtPath, destDir) {
  let buf;
  try {
    buf = readFileSync(mogrtPath);
  } catch {
    return null;
  }
  // Find End Of Central Directory.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let pngDest = null;
  let off = cdOffset;
  for (let n = 0; n < cdEntries; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    const base = name.split('/').pop().toLowerCase();
    const isMp4 = base === 'thumb.mp4';
    if (!isMp4 && base !== 'thumb.png') continue;
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lfhNameLen = buf.readUInt16LE(lho + 26);
    const lfhExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lfhNameLen + lfhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    try {
      data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    } catch {
      continue;
    }
    if (!data || data.length === 0) continue;
    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      return pngDest;
    }
    const dest = path.join(destDir, isMp4 ? 'mogrt-thumb.mp4' : 'mogrt-thumb.png');
    try {
      writeFileSync(dest, data);
    } catch {
      continue;
    }
    if (isMp4) return dest; // best match — stop scanning
    if (!pngDest) pngDest = dest; // fallback if no mp4 shows up later
  }
  return pngDest;
}

/**
 * Ensure GIF previews for video assets. Returns a Map of asset id -> absolute
 * GIF path for the assets that got (or already had) a preview.
 *
 * Rules:
 * - Only assets with a video extension and an existing file on disk, plus
 *   .mogrt templates (previewed from their embedded thumb.mp4/thumb.png).
 * - Assets with an explicit `thumbnail` keep it (never overwritten).
 * - Sidecars are cached: regeneration happens only when the source video is
 *   newer than the sidecar.
 *
 * @param {{ panelDir: string, assets: Array<object>, logger?: { append: Function } }} opts
 * @returns {Promise<Map<string, string>>}
 */
export async function ensureGifPreviews({ panelDir, assets, logger }) {
  const out = new Map();
  const previewsDir = path.join(panelDir, 'previews');
  mkdirSync(previewsDir, { recursive: true });

  const candidates = (Array.isArray(assets) ? assets : []).filter((a) => {
    if (!a || !a.id || !a.path || a.thumbnail) return false;
    const type = String(a.type || '').toLowerCase();
    const ext = path.extname(String(a.path)).toLowerCase();
    // .mogrt templates: preview comes from the embedded thumb (extracted
    // below) — ffmpeg cannot read .mogrt directly.
    if (ext === '.mogrt') return existsSync(a.path);
    if (type !== 'broll' && type !== 'video') return false;
    if (!VIDEO_EXTS.has(ext)) return false;
    return existsSync(a.path);
  });
  if (candidates.length === 0) return out;

  const ffmpeg = await resolveFfmpeg(logger);
  if (!ffmpeg) return out;

  const limited = candidates.slice(0, MAX_PREVIEWS_PER_SYNC);
  if (candidates.length > limited.length) {
    logger?.append(
      'panel-sync',
      `GIF previews: rendering ${limited.length}/${candidates.length} video assets this sync (cap)`
    );
  }

  for (const asset of limited) {
    const gifPath = path.join(previewsDir, `${asset.id}.gif`);
    // .mogrt previews may resolve to a static .png sidecar when the embedded
    // thumb is a png rather than an mp4.
    const pngPath = path.join(previewsDir, `${asset.id}.png`);
    const isMogrt = path.extname(String(asset.path)).toLowerCase() === '.mogrt';
    try {
      const srcStat = statSync(asset.path);
      let fresh = false;
      const current = existsSync(gifPath) ? gifPath : existsSync(pngPath) ? pngPath : null;
      if (current) {
        try {
          const curStat = statSync(current);
          fresh = curStat.size > 0 && curStat.mtimeMs >= srcStat.mtimeMs;
        } catch { /* treat as stale */ }
      }
      if (!fresh) {
        if (isMogrt) {
          const thumb = extractMogrtThumb(asset.path, path.join(previewsDir, 'thumbs'));
          if (!thumb) throw new Error('no embedded thumb.mp4/thumb.png in .mogrt');
          if (thumb.endsWith('.mp4')) {
            try { unlinkSync(pngPath); } catch { /* ignore */ }
            await renderGif(ffmpeg, thumb, gifPath, previewsDir);
          } else {
            try { unlinkSync(gifPath); } catch { /* ignore */ }
            copyFileSync(thumb, pngPath);
          }
        } else {
          await renderGif(ffmpeg, asset.path, gifPath, previewsDir);
        }
        logger?.append('panel-sync', `GIF preview: ${path.basename(asset.path)}`);
      }
      const resolved = existsSync(gifPath) ? gifPath : pngPath;
      out.set(asset.id, resolved);
    } catch (err) {
      try { unlinkSync(gifPath); } catch { /* ignore */ }
      try { unlinkSync(pngPath); } catch { /* ignore */ }
      logger?.append('panel-sync', `GIF preview failed for ${path.basename(String(asset.path))}: ${err.message}`);
    }
  }
  return out;
}

/** Exposed for tests. */
export const __test = { VIDEO_EXTS, MAX_PREVIEWS_PER_SYNC, PREVIEW_SECONDS, extractMogrtThumb };

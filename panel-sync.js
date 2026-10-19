// Drop AI — CEP panel file sync.
// Copyright by Dork Industry.
//
// Bridges the CEP panel (which can't call Node directly) with the launcher's
// Node side via JSON files in <dataDir>/panel/:
//
//   panel-assets.json   <- launcher writes on asset changes + startup:
//                        local asset-store assets ONLY (reference + local
//                        assets). The panel's "Assets" tab reads this.
//   panel-library.json  <- launcher writes on asset changes, catalog polls
//                        and one-click installs: backend catalog presets +
//                        installed presets (the real library content).
//                        The panel's "Library" tab reads this.
//   broll-request.json  -> panel writes when user clicks "Detect B-roll"
//                        launcher watches, runs shot detection
//   broll-result.json   <- launcher writes segments; panel polls for it
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  deriveAssetHosts,
  fetchPresets,
  catalogVersion,
  downloadUrlToFile,
  installPresetFromCatalog,
  DEFAULT_BASE,
} from './lib/library-client.js';
import { ensureGifPreviews } from './panel-previews.js';
import { wordsToSrt } from '@drop-ai/common';

export function getPanelDir(dataDir) {
  const dir = path.join(dataDir, 'panel');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Preset backend types -> panel asset types. */
const PRESET_TYPE_TO_PANEL_TYPE = {
  music: 'audio',
  'caption-style': 'other',
  lut: 'lut',
  font: 'other',
  mogrt: 'mogrt',
  transition: 'other',
  effect: 'other',
  'thumbnail-pack': 'other',
  'shot-pack': 'other',
};

/** Human label for a backend preset type. */
const PRESET_TYPE_LABELS = {
  music: 'Music',
  'caption-style': 'Caption Style',
  lut: 'LUT',
  font: 'Font',
  mogrt: 'MOGRT',
  transition: 'Transition',
  effect: 'Effect',
  'thumbnail-pack': 'Thumbnail Pack',
  'shot-pack': 'Shot Pack',
};

const CATALOG_VERSION_FILE = 'catalog-version.json';
const CATALOG_ASSETS_FILE = 'catalog-assets.json';
// Safety cap so panel-library.json stays small enough for the CEP panel to parse.
const MAX_CATALOG_CARDS = 2000;
// Poll interval for backend catalog changes (5 minutes).
const CATALOG_POLL_MS = 5 * 60 * 1000;

/**
 * True when a store asset was installed from the backend preset library
 * (installPresetFromCatalog tags them `preset` / `preset:<slug>`) as opposed
 * to a local/reference asset. Installed presets belong to the Library tab,
 * not the Assets tab.
 */
export function isInstalledPresetAsset(a) {
  const tags = (a && a.tags) || [];
  return tags.some((t) => t === 'preset' || String(t).indexOf('preset:') === 0);
}

/**
 * Drop catalog entries whose preset has since been installed locally —
 * the installed store assets represent them, so the Install card must go.
 */
function dropInstalledCatalogEntries(dataDir, entries) {
  // DISABLED in 3.0.34: installed items now stay visible with "Place" button
  // instead of vanishing. The `installed` flag in the catalog object tells
  // the panel to show "Place" instead of "Install".
  return entries || [];
}

/**
 * Read the persisted backend-catalog cache (panel/catalog-assets.json),
 * minus entries installed since the cache was written.
 */
function readCatalogCache(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(path.join(getPanelDir(dataDir), CATALOG_ASSETS_FILE), 'utf8'));
    const assets = Array.isArray(raw.assets) ? raw.assets : [];
    return dropInstalledCatalogEntries(dataDir, assets);
  } catch {
    return [];
  }
}

/**
 * Fetch the backend catalog directly (fallback when the cache is empty).
 * This ensures the CEP panel never sits at 0 presets just because a cache
 * file went missing or the sync order was wrong.
 */
async function fetchCatalogDirect(logger) {
  try {
    const { fetchPresets } = await import('./lib/library-client.js');
    const assets = [];
    let page = 1;
    for (;;) {
      const data = await fetchPresets(undefined, { page, limit: 100 });
      const items = Array.isArray(data) ? data : (data.presets || data.items || []);
      if (!items.length) break;
      assets.push(...items);
      if (items.length < 100) break;
      page++;
      if (page > 20) break;
    }
    logger?.append('panel-sync', `direct catalog fetch: ${assets.length} entries`);
    return assets;
  } catch (err) {
    logger?.append('panel-sync', `direct catalog fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Write the CEP panel's two data files:
 *
 *   panel-assets.json   <- local asset-store assets ONLY: reference and
 *                          locally-added assets (the panel's "Assets" tab).
 *   panel-library.json  <- the real library: backend catalog presets
 *                          (Install cards) + installed presets from the
 *                          local store (Place cards) — the panel's
 *                          "Library" tab.
 *
 * Each asset carries a `hosts` array (hostIds it can be placed in), derived
 * from the installed plugins' assetTypes[].compatibleHosts. The Premiere
 * panel keeps reading panel-assets.json; other plugins' panels filter by hosts.
 *
 * Video assets without an explicit thumbnail get a generated GIF preview
 * sidecar (panel/previews/<id>.gif) at sync time — the asset store schema
 * is untouched; the thumbnail only exists in these panel-facing files.
 *
 * `extra.catalogAssets` (from syncBackendCatalog) wins for the catalog half;
 * when absent the persisted catalog cache is used, so every call path
 * (startup, asset mutation, 5-minute catalog poll, one-click install)
 * refreshes BOTH files.
 */
export async function syncPanelAssets(dataDir, assetStore, logger, plugins = [], extra = {}) {
  try {
    const dir = getPanelDir(dataDir);
    let storeAssets = [];
    try {
      const list = await assetStore.list();
      storeAssets = Array.isArray(list) ? list : [];
    } catch { /* empty list on error */ }
    const panelAssets = storeAssets.map((a) => {
      const assetPath = a.path || '';
      const ext = path.extname(assetPath).toLowerCase();
      const isVideo = ['.mp4', '.mov', '.webm', '.m4v'].includes(ext);
      return {
      id: a.id || '',
      code: a.code || '',
      name: a.name || (a.path ? path.basename(a.path) : 'asset'),
      path: assetPath,
      type: a.type || 'other',
      category: a.category || '',
      thumbnail: a.thumbnail || null,
      // Video preview for hover-play (like EffectsFlow)
      previewVideo: isVideo ? assetPath : null,
      tags: a.tags || [],
      description: a.description || '',
      hosts: deriveAssetHosts(a.type, plugins),
      // Remote-storage reference (null for local assets). The CEP panel
      // uses this to request an on-demand download before placing.
      storage: a.storage ?? null,
      };
    });
    // Installed presets live in the store too — they belong to the Library
    // tab, not the Assets tab.
    const installedPresets = panelAssets.filter(isInstalledPresetAsset);
    const referenceAssets = panelAssets.filter((a) => !isInstalledPresetAsset(a));
    let catalogAssets = dropInstalledCatalogEntries(
      dataDir,
      Array.isArray(extra.catalogAssets) ? extra.catalogAssets : readCatalogCache(dataDir)
    );
    // Fallback: if the cache is empty AND nothing is installed, fetch the
    // catalog directly from the backend so the panel never shows 0 presets
    // due to a stale/missing cache file.
    if (catalogAssets.length === 0 && installedPresets.length === 0) {
      const direct = await fetchCatalogDirect(logger);
      catalogAssets = dropInstalledCatalogEntries(dataDir, direct);
    }
    const libraryEntries = [...catalogAssets, ...installedPresets];
    // GIF previews for video assets (sidecars; store schema unchanged).
    try {
      const previewAssets = [...referenceAssets, ...libraryEntries];
      const previews = await ensureGifPreviews({ panelDir: dir, assets: previewAssets, logger });
      for (const a of previewAssets) {
        if (!a.thumbnail && previews.has(a.id)) a.thumbnail = previews.get(a.id);
      }
    } catch (err) {
      logger?.append('panel-sync', `GIF previews failed: ${err.message}`);
    }
    // Fetch user library assets from the backend (if logged in).
    let userAssets = [];
    try {
      const userToken = extra.userToken || null;
      if (userToken) {
        const base = extra.libraryBase || process.env.DROP_AI_LIBRARY_URL || DEFAULT_BASE;
        const resp = await fetch(`${base}/api/user-assets`, {
          headers: { 'x-user-token': userToken },
        });
        if (resp.ok) {
          const data = await resp.json();
          userAssets = (data.assets || []).map((a) => ({
            id: 'user-' + a.id,
            code: '',
            name: a.name,
            path: '', // Remote — panel will download on demand
            type: a.assetType || 'other',
            category: 'User Library',
            thumbnail: a.thumbnail || null,
            tags: ['user-library'],
            description: 'Your personal asset',
            hosts: ['premiere'],
            storage: { backend: 'user-asset', assetId: a.id },
            userAssetId: a.id,
            mogrt: a.mogrt || null,
          }));
        }
      }
    } catch (e) {
      logger?.append('panel-sync', `user assets fetch failed: ${e.message}`);
    }

    const syncedAt = Date.now();
    writeFileSync(
      path.join(dir, 'panel-assets.json'),
      JSON.stringify({ assets: [...referenceAssets, ...userAssets], syncedAt }),
      'utf8'
    );
    writeFileSync(
      path.join(dir, 'panel-library.json'),
      JSON.stringify({ assets: libraryEntries, syncedAt }),
      'utf8'
    );
    logger?.append(
      'panel-sync',
      `synced ${referenceAssets.length} reference asset(s) + ${libraryEntries.length} library preset(s) ` +
      `(${catalogAssets.length} catalog, ${installedPresets.length} installed) for CEP panel`
    );
  } catch (err) {
    logger?.append('panel-sync', `asset sync failed: ${err.message}`);
  }
}

/**
 * Sync the backend preset catalog into panel card entries.
 *
 * Flow: backend upload -> /api/catalog/version changes -> launcher fetches the
 * published presets -> entries (with downloaded thumbnail sidecars) are
 * persisted to panel/catalog-assets.json -> syncPanelAssets writes them into
 * panel-library.json -> the panel's Library tab renders Install cards.
 *
 * Entries already installed locally (dataDir/presets/<slug> exists) are
 * skipped — the registered local assets represent them in the Library tab.
 *
 * Never throws: an unreachable backend returns the cached entries unchanged.
 *
 * @returns {Promise<{ changed: boolean, version: string|null, catalogAssets: object[] }>}
 */
export async function syncBackendCatalog(dataDir, logger, plugins = [], opts = {}) {
  const dir = getPanelDir(dataDir);
  const versionPath = path.join(dir, CATALOG_VERSION_FILE);
  const cachePath = path.join(dir, CATALOG_ASSETS_FILE);
  const base = opts.libraryBase || process.env.DROP_AI_LIBRARY_URL || DEFAULT_BASE;

  const readCache = () => readCatalogCache(dataDir);
  const readVersion = () => {
    try {
      const raw = JSON.parse(readFileSync(versionPath, 'utf8'));
      return typeof raw.version === 'string' ? raw.version : raw.version ?? null;
    } catch { return null; }
  };

  let version;
  try {
    version = await catalogVersion(base);
  } catch (err) {
    logger?.append('panel-sync', `catalog sync skipped (backend unreachable: ${err.message})`);
    return { changed: false, version: readVersion(), catalogAssets: readCache() };
  }
  if (!version) {
    // Backend has no content yet.
    return { changed: false, version: null, catalogAssets: readCache() };
  }
  if (!opts.force && version === readVersion()) {
    return { changed: false, version, catalogAssets: readCache() };
  }

  // Catalog changed: fetch every published preset (paginated).
  const presets = [];
  try {
    let page = 1;
    for (;;) {
      const data = await fetchPresets(base, { page, limit: 100 });
      const items = Array.isArray(data.items) ? data.items : [];
      presets.push(...items);
      if (items.length < 100 || page >= 20) break;
      page++;
    }
  } catch (err) {
    logger?.append('panel-sync', `catalog fetch failed: ${err.message}`);
    return { changed: false, version: readVersion(), catalogAssets: readCache() };
  }

  const previewsDir = path.join(dir, 'previews');
  mkdirSync(previewsDir, { recursive: true });
  const catalogAssets = [];
  for (const p of presets.slice(0, MAX_CATALOG_CARDS)) {
    const slug = String(p.slug || '');
    if (!slug) continue;
    // Check if already installed — mark it instead of skipping, so the panel
    // can show "Place" instead of "Install" (no more vanish).
    const isInstalled = existsSync(path.join(dataDir, 'presets', slug));
    const panelType = PRESET_TYPE_TO_PANEL_TYPE[String(p.type || '')] || 'other';
    // Download the catalog thumbnail as a sidecar so the CEP panel (file://)
    // never depends on the backend being reachable at render time.
    let thumbnail = null;
    if (p.thumbnailUrl) {
      try {
        const thumbUrl = new URL(String(p.thumbnailUrl), base).toString();
        const ext = (path.extname(new URL(thumbUrl).pathname) || '.jpg').slice(0, 5);
        const dest = path.join(previewsDir, `catalog-${slug}${/^\.[a-z0-9]+$/i.test(ext) ? ext : '.jpg'}`);
        let fresh = false;
        if (existsSync(dest)) {
          try { fresh = statSync(dest).size > 0; } catch { /* re-download */ }
        }
        if (!fresh) await downloadUrlToFile(thumbUrl, dest, { maxBytes: 3 * 1024 * 1024 });
        thumbnail = dest;
      } catch (err) {
        logger?.append('panel-sync', `catalog thumbnail skipped for ${slug}: ${err.message}`);
      }
    }
    catalogAssets.push({
      id: `catalog:${slug}`,
      code: '',
      name: p.name || slug,
      path: '',
      type: panelType,
      // Use the backend category name (e.g. "Text Animations"), not the type label.
      // p.category may be an object {_id, name} or a string.
      category: (p.category && typeof p.category === 'object' ? p.category.name : p.category) || PRESET_TYPE_LABELS[String(p.type || '')] || 'Preset',
      thumbnail,
      // Video preview: for video types, the thumbnail PNG is static; the actual
      // video file (when downloaded) can be used for hover-play preview.
      // For catalog entries, this is null until installed.
      previewVideo: null,
      tags: ['catalog', String(p.type || ''), ...(Array.isArray(p.tags) ? p.tags : [])].filter(Boolean),
      description: p.description || '',
      hosts: deriveAssetHosts(panelType, plugins),
      storage: null, // catalog entries install from the backend, not Drive
      // Include files with meta for version compatibility filtering (MOGRTs).
      files: Array.isArray(p.files) ? p.files.map(f => ({ meta: f.meta || {} })) : [],
      catalog: {
        slug,
        presetId: String(p.id || slug),
        version: String(p.version || ''),
        backendBase: base,
        installed: isInstalled,
      },
    });
  }

  try {
    writeFileSync(cachePath, JSON.stringify({ assets: catalogAssets, syncedAt: Date.now() }), 'utf8');
    writeFileSync(versionPath, JSON.stringify({ version, syncedAt: Date.now() }), 'utf8');
  } catch (err) {
    logger?.append('panel-sync', `catalog cache write failed: ${err.message}`);
  }
  logger?.append('panel-sync', `catalog sync: ${catalogAssets.length} preset(s) (version ${version})`);
  return { changed: true, version, catalogAssets };
}

/**
 * Watch for one-click Install requests from the CEP panel.
 * The panel writes panel/library-request.json { slug }; the launcher
 * downloads + registers the preset, re-syncs panel assets, and writes
 * panel/library-result.json { slug, status } for the panel to poll.
 */
export function watchLibraryRequests(dataDir, opts = {}) {
  const { logger, getAssetStore, getPlugins, libraryBase, onInstalled } = opts;
  const dir = getPanelDir(dataDir);
  const reqPath = path.join(dir, 'library-request.json');
  const resPath = path.join(dir, 'library-result.json');
  let busy = false;

  const writeResult = (obj) => {
    try {
      writeFileSync(resPath, JSON.stringify({ ...obj, at: Date.now() }), 'utf8');
    } catch { /* ignore */ }
  };

  const poll = async () => {
    if (busy || !existsSync(reqPath)) return;
    busy = true;
    try {
      const req = JSON.parse(readFileSync(reqPath, 'utf8'));
      try { unlinkSync(reqPath); } catch { /* ignore */ }
      const slug = req && typeof req.slug === 'string' ? req.slug.trim() : '';
      if (!slug) {
        writeResult({ slug: '', status: 'error', error: 'missing preset slug' });
        busy = false;
        return;
      }
      logger?.append('panel-sync', `panel requested install of preset "${slug}"`);
      writeResult({ slug, status: 'downloading' });
      try {
        const result = await installPresetFromCatalog({
          base: libraryBase || process.env.DROP_AI_LIBRARY_URL || DEFAULT_BASE,
          dataDir,
          presetId: slug,
          // Reuse the launcher's shared store when available so the panel,
          // the Library tab, and Claude all see the same manifest.
          createStore: getAssetStore ? () => getAssetStore() : undefined,
          onProgress: (p) => writeResult({ slug, status: p.phase === 'registering' ? 'installing' : 'downloading', progress: p }),
        });
        writeResult({ slug, status: 'installing' });
        try {
          if (onInstalled) await onInstalled();
          else if (getAssetStore) {
            const store = await getAssetStore();
            await syncPanelAssets(dataDir, store, logger, getPlugins ? getPlugins() : []);
          }
        } catch (err) {
          logger?.append('panel-sync', `post-install panel sync failed: ${err.message}`);
        }
        writeResult({ slug, status: 'done', files: result.files.length, assetsRegistered: result.assetsRegistered });
        logger?.append('panel-sync', `preset "${slug}" installed for panel (${result.assetsRegistered} asset(s))`);
      } catch (err) {
        writeResult({ slug, status: 'error', error: err.message });
        logger?.append('panel-sync', `preset "${slug}" install failed: ${err.message}`);
      }
    } catch (err) {
      logger?.append('panel-sync', `library request error: ${err.message}`);
    }
    busy = false;
  };

  const timer = setInterval(poll, 3000);
  if (timer.unref) timer.unref();
  // Prime the result file so the panel never polls a stale success.
  return () => clearInterval(timer);
}

/**
 * Watch for user library upload requests from the panel.
 * The panel writes panel/user-upload-request.json { files: [paths] };
 * the launcher uploads them to the backend and writes
 * panel/user-upload-result.json { ok, uploaded } for the panel to poll.
 */
export function watchUserUploadRequests(dataDir, opts = {}) {
  const { logger, libraryBase, getUserToken } = opts;
  const dir = getPanelDir(dataDir);
  const reqPath = path.join(dir, 'user-upload-request.json');
  const resPath = path.join(dir, 'user-upload-result.json');
  let busy = false;

  const writeResult = (obj) => {
    try {
      writeFileSync(resPath, JSON.stringify({ ...obj, at: Date.now() }), 'utf8');
    } catch { /* ignore */ }
  };

  const poll = async () => {
    if (busy || !existsSync(reqPath)) return;
    busy = true;
    try {
      const req = JSON.parse(readFileSync(reqPath, 'utf8'));
      try { unlinkSync(reqPath); } catch { /* ignore */ }
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        writeResult({ ok: false, error: 'no files specified' });
        busy = false;
        return;
      }
      const token = getUserToken ? await getUserToken() : null;
      if (!token) {
        writeResult({ ok: false, error: 'login required — please log in to the Drop AI app first' });
        busy = false;
        return;
      }
      const base = libraryBase || process.env.DROP_AI_LIBRARY_URL || DEFAULT_BASE;
      logger?.append('panel-sync', `panel requested user upload of ${files.length} file(s)`);
      writeResult({ ok: false, status: 'uploading' });

      // Build multipart form data with native FormData.
      const form = new FormData();
      let added = 0;
      for (const fp of files) {
        try {
          if (!existsSync(fp)) continue;
          const buf = readFileSync(fp);
          const blob = new Blob([buf]);
          form.append('files', blob, path.basename(fp));
          added++;
        } catch (e) {
          logger?.append('panel-sync', `user upload: could not read ${fp}: ${e.message}`);
        }
      }
      if (added === 0) {
        writeResult({ ok: false, error: 'none of the selected files could be read' });
        busy = false;
        return;
      }
      const resp = await fetch(`${base}/api/user-assets/upload`, {
        method: 'POST',
        headers: {
          'x-user-token': token,
        },
        body: form,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || `upload failed (${resp.status})`);
      }
      const uploaded = (data.uploaded || []).length;
      writeResult({ ok: true, uploaded });
      logger?.append('panel-sync', `user library upload complete: ${uploaded} file(s)`);
      // Trigger a panel data refresh so the new assets appear.
      try {
        writeFileSync(path.join(dir, 'sync-request.json'), JSON.stringify({ at: Date.now() }), 'utf8');
      } catch { /* ignore */ }
    } catch (err) {
      writeResult({ ok: false, error: err.message });
      logger?.append('panel-sync', `user upload failed: ${err.message}`);
    }
    busy = false;
  };

  const timer = setInterval(poll, 3000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/**
 * Periodically re-sync the backend catalog so new uploads appear in the
 * panel automatically. Calls opts.onSync(catalogAssets) whenever the catalog
 * version changed.
 */
export function watchBackendCatalog(dataDir, opts = {}) {
  const { logger, getPlugins, libraryBase, onSync, onBlocked, intervalMs } = opts;
  const syncReqPath = path.join(getPanelDir(dataDir), 'sync-request.json');
  let lastSyncReq = 0;
  const checkSyncRequest = async () => {
    try {
      if (!existsSync(syncReqPath)) return false;
      const req = JSON.parse(readFileSync(syncReqPath, 'utf8'));
      const at = req && req.at ? Number(req.at) : 0;
      if (at > lastSyncReq) {
        lastSyncReq = at;
        try { unlinkSync(syncReqPath); } catch {}
        logger?.append('panel-sync', 'panel requested immediate sync');
        await tick();
        return true;
      }
    } catch {}
    return false;
  };
  // Check for manual sync requests every 5 seconds.
  const reqTimer = setInterval(checkSyncRequest, 5000);
  if (reqTimer.unref) reqTimer.unref();
  const tick = async () => {
    try {
      const res = await syncBackendCatalog(dataDir, logger, getPlugins ? getPlugins() : [], {
        libraryBase: libraryBase || process.env.DROP_AI_LIBRARY_URL || DEFAULT_BASE,
      });
      if (res.changed && onSync) await onSync(res.catalogAssets);
    } catch (err) {
      if (onBlocked && err && (err.code === 'IP_BLOCKED' || err.name === 'IpBlockedError')) {
        onBlocked(err);
        return;
      }
      logger?.append('panel-sync', `catalog watch tick failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, intervalMs || CATALOG_POLL_MS);
  if (timer.unref) timer.unref();
  return () => { clearInterval(timer); clearInterval(reqTimer); };
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * Watch for b-roll detection requests from the CEP panel.
 * Runs shot detection on each requested clip and writes candidate
 * b-roll segments (shots that look like cutaways: short, non-talking-head).
 */
export function watchBrollRequests(dataDir, logger) {
  const dir = getPanelDir(dataDir);
  const reqPath = path.join(dir, 'broll-request.json');
  const resPath = path.join(dir, 'broll-result.json');
  let busy = false;

  const poll = async () => {
    if (busy || !existsSync(reqPath)) return;
    busy = true;
    try {
      const req = JSON.parse(readFileSync(reqPath, 'utf8'));
      // Consume the request immediately so we don't reprocess
      try { unlinkSync(reqPath); } catch { /* ignore */ }
      // Clear any stale result
      try { unlinkSync(resPath); } catch { /* ignore */ }

      const paths = Array.isArray(req.paths) ? req.paths.filter((p) => p && existsSync(p)) : [];
      if (paths.length === 0) {
        writeFileSync(resPath, JSON.stringify({ error: 'No valid video files found.', segments: [] }), 'utf8');
        busy = false;
        return;
      }

      logger?.append('panel-sync', `b-roll detection: analyzing ${paths.length} clip(s)`);
      const { detectShots } = await import('@drop-ai/reference');

      const segments = [];
      for (const videoPath of paths) {
        try {
          const shots = await detectShots(videoPath);
          // Heuristic b-roll candidates: shots between 1s and 12s.
          // Very long shots are likely a-roll (talking head); very short
          // ones are likely transition artifacts. Mid-length shots are
          // the cutaways editors reach for.
          for (const shot of shots) {
            const dur = shot.end - shot.start;
            if (dur >= 1.0 && dur <= 12.0) {
              segments.push({
                sourcePath: videoPath,
                start: Number(shot.start.toFixed(2)),
                end: Number(shot.end.toFixed(2)),
                label: 'shot',
                reason: `${dur.toFixed(1)}s shot`,
              });
            }
          }
        } catch (err) {
          logger?.append('panel-sync', `shot detection failed for ${path.basename(videoPath)}: ${err.message}`);
        }
        // Cap at 50 segments to keep the panel usable
        if (segments.length >= 50) break;
      }

      // Sort by duration (most useful b-roll length first: 2-6s sweet spot)
      segments.sort((a, b) => {
        const score = (s) => {
          const d = s.end - s.start;
          if (d >= 2 && d <= 6) return 0;
          if (d < 2) return 1;
          return 2;
        };
        return score(a) - score(b);
      });

      writeFileSync(
        resPath,
        JSON.stringify({ segments: segments.slice(0, 50), analyzedAt: Date.now() }),
        'utf8'
      );
      logger?.append('panel-sync', `b-roll detection complete: ${segments.length} segment(s)`);
    } catch (err) {
      try {
        writeFileSync(resPath, JSON.stringify({ error: err.message, segments: [] }), 'utf8');
      } catch { /* ignore */ }
      logger?.append('panel-sync', `b-roll detection error: ${err.message}`);
    }
    busy = false;
  };

  // Poll every 3s
  const timer = setInterval(poll, 3000);
  // Don't keep the process alive just for this
  if (timer.unref) timer.unref();
  // Initial asset sync happens via syncPanelAssets() at startup
  return () => clearInterval(timer);
}

/**
 * Watch for one-click feature requests from the CEP panel's Quick Actions.
 *
 * File bridge (same pattern as b-roll):
 *   <kind>-request.json -> panel writes when a Quick Action button is clicked
 *   <kind>-result.json  <- launcher writes the computed result; panel polls
 *
 * Kinds:
 *   silence    {sources:[{mediaPath,startSec,inPointSec,durationSec,clipName,trackIndex}], noiseDb, minDur}
 *              -> {spans:[{start,end}] (timeline sec, merged), perFile}
 *   transcribe {sources:[...]} -> {words (capped), wordCount, text, srtPath}
 *              (also persists the full result as transcribe-result.json for captions chaining)
 *   captions   {style} -> reads transcribe-result.json -> {webmPath, srtPath, wordCount}
 *   references {} -> {references:[{slug,name,duration,shots}]}
 *   style      {slug} -> materialize LUT + install into Premiere LUTs folder
 *              -> {lookName, cubePath, destPath}
 */
export function watchPanelRequests(dataDir, logger) {
  const dir = getPanelDir(dataDir);
  const busy = {};

  const consume = (kind) => {
    const reqPath = path.join(dir, `${kind}-request.json`);
    const resPath = path.join(dir, `${kind}-result.json`);
    if (!existsSync(reqPath)) return null;
    let req = null;
    try {
      req = JSON.parse(readFileSync(reqPath, 'utf8'));
    } catch {
      req = null;
    }
    try { unlinkSync(reqPath); } catch { /* ignore */ }
    try { unlinkSync(resPath); } catch { /* ignore stale result */ }
    return { req, resPath };
  };

  const write = (resPath, obj) => {
    try {
      writeFileSync(resPath, JSON.stringify(obj), 'utf8');
    } catch (err) {
      logger?.append('panel-sync', `failed to write ${path.basename(resPath)}: ${err.message}`);
    }
  };

  const validSources = (req) => {
    const sources = Array.isArray(req?.sources) ? req.sources : [];
    return sources.filter((s) => s && s.mediaPath && existsSync(s.mediaPath));
  };

  async function handleSilence(req, resPath) {
    const sources = validSources(req);
    if (sources.length === 0) {
      write(resPath, { error: 'No valid audio files found.', spans: [] });
      return;
    }
    const noiseDb = Number(req.noiseDb ?? -30);
    const minDur = Number(req.minDur ?? 0.5);
    logger?.append('panel-sync', `silence detection: analyzing ${sources.length} clip(s)`);
    const { detectSilence, mapSpansToTimeline } = await import('@drop-ai/reference');
    const uniquePaths = [...new Set(sources.map((s) => s.mediaPath))];
    const spansByFile = {};
    const perFile = {};
    for (const mediaPath of uniquePaths) {
      try {
        const spans = await detectSilence(mediaPath, { noiseDb, minDur });
        spansByFile[mediaPath] = spans;
        perFile[mediaPath] = { spans: spans.length };
      } catch (err) {
        spansByFile[mediaPath] = [];
        perFile[mediaPath] = { error: err.message };
        logger?.append('panel-sync', `silencedetect failed for ${path.basename(mediaPath)}: ${err.message}`);
      }
    }
    const spans = mapSpansToTimeline(spansByFile, sources);
    write(resPath, { spans, perFile, analyzedAt: Date.now() });
    logger?.append('panel-sync', `silence detection complete: ${spans.length} span(s)`);
  }

  async function handleTranscribe(req, resPath) {
    const sources = validSources(req);
    if (sources.length === 0) {
      write(resPath, { error: 'No valid audio files found.', words: [] });
      return;
    }
    const { transcribeVideo, whisperAvailable, mapWordsToTimeline } = await import('@drop-ai/reference');
    if (!whisperAvailable()) {
      write(resPath, { error: 'Whisper model not bundled — transcription unavailable.', words: [] });
      return;
    }
    logger?.append('panel-sync', `transcribing ${sources.length} clip(s) with Whisper (local)`);
    const uniquePaths = [...new Set(sources.map((s) => s.mediaPath))];
    const wordsByFile = {};
    for (const mediaPath of uniquePaths) {
      try {
        const result = await transcribeVideo(mediaPath);
        wordsByFile[mediaPath] = Array.isArray(result.words) ? result.words : [];
      } catch (err) {
        wordsByFile[mediaPath] = [];
        logger?.append('panel-sync', `transcription failed for ${path.basename(mediaPath)}: ${err.message}`);
      }
    }
    const words = mapWordsToTimeline(wordsByFile, sources);
    // SRT sidecar next to the result so the panel can import native captions.
    let srtPath = null;
    try {
      const srt = wordsToSrt(words);
      srtPath = path.join(dir, `transcript-${Date.now()}.srt`);
      writeFileSync(srtPath, srt, 'utf8');
    } catch (err) {
      logger?.append('panel-sync', `SRT write failed: ${err.message}`);
    }
    const result = {
      words: words.slice(0, 5000),
      wordCount: words.length,
      text: words.map((w) => w.text).join(' '),
      srtPath,
      analyzedAt: Date.now(),
    };
    write(resPath, result);
    // Persist the FULL result (not just the capped words) for captions chaining.
    try {
      writeFileSync(
        path.join(dir, 'transcribe-full.json'),
        JSON.stringify({ words, analyzedAt: result.analyzedAt }),
        'utf8'
      );
    } catch { /* ignore */ }
    logger?.append('panel-sync', `transcription complete: ${words.length} word(s)`);
  }

  async function handleCaptions(req, resPath) {
    const fullPath = path.join(dir, 'transcribe-full.json');
    if (!existsSync(fullPath)) {
      write(resPath, { error: 'No transcript yet — click Transcribe first, then Captions.' });
      return;
    }
    let words = [];
    try {
      words = JSON.parse(readFileSync(fullPath, 'utf8')).words || [];
    } catch {
      words = [];
    }
    if (words.length === 0) {
      write(resPath, { error: 'The last transcript is empty — click Transcribe first.' });
      return;
    }
    logger?.append('panel-sync', `rendering kinetic captions for ${words.length} word(s)`);
    const { renderCaptions } = await import('@drop-ai/hyperframes');
    const { mkdirSync: mk } = await import('node:fs');
    const outDir = path.join(dataDir, 'hyperframes');
    mk(outDir, { recursive: true });
    const outPath = path.join(outDir, `captions-${Date.now()}.webm`);
    await renderCaptions(words, req.style || {}, outPath, { width: 1920, height: 1080, fps: 30 });
    const srtPath = outPath.replace(/\.webm$/i, '.srt');
    try {
      writeFileSync(srtPath, wordsToSrt(words), 'utf8');
    } catch (err) {
      logger?.append('panel-sync', `caption SRT write failed: ${err.message}`);
    }
    write(resPath, { webmPath: outPath, srtPath, wordCount: words.length, analyzedAt: Date.now() });
    logger?.append('panel-sync', `captions rendered: ${path.basename(outPath)}`);
  }

  async function handleReferences(req, resPath) {
    const { listReferences } = await import('@drop-ai/reference');
    let references = [];
    try {
      references = listReferences(dataDir);
    } catch (err) {
      write(resPath, { error: err.message, references: [] });
      return;
    }
    write(resPath, { references, analyzedAt: Date.now() });
  }

  async function handleStyle(req, resPath) {
    const slug = String(req?.slug || '');
    if (!slug) {
      write(resPath, { error: 'No reference slug provided.' });
      return;
    }
    logger?.append('panel-sync', `materializing look LUT for reference '${slug}'`);
    const { materializeLut } = await import('@drop-ai/reference');
    const { installLutFile } = await import('@drop-ai/assets');
    try {
      const cubePath = materializeLut(dataDir, slug);
      const { lookName, destPath } = installLutFile(cubePath);
      write(resPath, { lookName, cubePath, destPath, analyzedAt: Date.now() });
      logger?.append('panel-sync', `LUT installed as '${lookName}'`);
    } catch (err) {
      write(resPath, { error: err.message });
      logger?.append('panel-sync', `style transfer failed: ${err.message}`);
    }
  }

  const handlers = {
    silence: handleSilence,
    transcribe: handleTranscribe,
    captions: handleCaptions,
    references: handleReferences,
    style: handleStyle,
  };

  const poll = async () => {
    for (const kind of Object.keys(handlers)) {
      if (busy[kind]) continue;
      const consumed = consume(kind);
      if (!consumed || !consumed.req) continue;
      busy[kind] = true;
      try {
        await handlers[kind](consumed.req, consumed.resPath);
      } catch (err) {
        write(consumed.resPath, { error: err.message });
        logger?.append('panel-sync', `${kind} request failed: ${err.message}`);
      }
      busy[kind] = false;
    }
  };

  const timer = setInterval(poll, 3000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

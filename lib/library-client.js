// Drop AI — preset library backend client.
// Copyright by Dork Industry.
//
// Talks to the MERN preset library backend (backend/server). The Electron app
// never hardcodes filter chips or preset types — everything comes from here.
// Preset catalog updates are independent of app updates (see catalogVersion).
import { get, request as httpsRequest } from 'node:https';
import { get as httpGet, request as httpRequest } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = process.env.DROP_AI_LIBRARY_URL || 'https://mcpagent.cloud';

// Hardware identity digest (sha256 of MACs), set once by main.js. Sent as
// x-device-mac on every backend call so a blocked device is stopped even if
// its stored device-id file was deleted.
let deviceMac = '';
export function setDeviceMac(mac) { deviceMac = String(mac || ''); }
function macHeader() { return deviceMac ? { 'x-device-mac': deviceMac } : {}; }

/** Thrown when the backend reports this IP/device as blocked. */
export class IpBlockedError extends Error {
  constructor(message = 'Your IP got blocked — contact support.') {
    super(message);
    this.name = 'IpBlockedError';
    this.code = 'IP_BLOCKED';
  }
}

export function isIpBlockedError(err) {
  return !!err && (err.code === 'IP_BLOCKED' || err.name === 'IpBlockedError');
}

function requestJson(base, reqPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, base);
    const getter = url.protocol === 'https:' ? get : httpGet;
    const req = getter(url, { headers: macHeader() }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 403) {
          try {
            const body = JSON.parse(data);
            if (body.error === 'IP_BLOCKED') {
              reject(new IpBlockedError(body.message));
              return;
            }
          } catch { /* fall through to generic error */ }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`library request failed: ${res.statusCode} ${reqPath}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`library bad JSON: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('library request timed out')));
  });
}

/** POST JSON helper (for device phone-home). */
function postJson(base, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, base);
    const payload = JSON.stringify(body);
    // NOTE: use request (not get) — get() auto-ends the stream, and a second
    // end(payload) throws "write after end".
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...macHeader(), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 403) {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error === 'IP_BLOCKED') {
              reject(new IpBlockedError(parsed.message));
              return;
            }
          } catch { /* fall through */ }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`library request failed: ${res.statusCode} ${reqPath}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`library bad JSON: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('library request timed out')));
    req.end(payload);
  });
}

/**
 * Phone home: register this desktop install with the backend so the admin
 * panel's Devices tab can see it. Resolves { blocked } — a blocked device
 * learns it here and the app closes with the support message.
 */
export async function registerDevice(base = DEFAULT_BASE, info = {}) {
  return postJson(base, '/api/client/register', {
    deviceId: info.deviceId,
    mac: info.mac || deviceMac || '',
    appVersion: info.appVersion || '',
    platform: info.platform || process.platform,
    label: info.label || '',
  });
}

/* ---------------- user auth (Phase A: subscriptions) ---------------- */

function authHeaders(token) {
  return token ? { 'x-user-token': token } : {};
}

/** Request a login OTP for an email address. */
export async function requestLoginOtp(base = DEFAULT_BASE, email) {
  return postJson(base, '/api/auth/request-otp', { email });
}

/** Verify an OTP → { token, user }. */
export async function verifyLoginOtp(base = DEFAULT_BASE, email, otp, name = '') {
  return postJson(base, '/api/auth/verify-otp', { email, otp, name });
}

/** Session status: { user } — throws LOGIN_REQUIRED / SUBSCRIPTION_REQUIRED / ACCOUNT_BLOCKED. */
export async function authMe(base = DEFAULT_BASE, token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/auth/me', base);
    const getter = url.protocol === 'https:' ? get : httpGet;
    const req = getter(url, { headers: authHeaders(token) }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(data); } catch { /* leave empty */ }
        if (res.statusCode === 401) {
          const err = new Error(body.error || 'login required');
          err.code = 'LOGIN_REQUIRED';
          reject(err);
          return;
        }
        if (res.statusCode === 402) {
          const err = new Error(body.error || 'subscription required');
          err.code = 'SUBSCRIPTION_REQUIRED';
          err.plan = body.plan;
          reject(err);
          return;
        }
        if (res.statusCode === 403 && body.code === 'ACCOUNT_BLOCKED') {
          const err = new Error(body.error);
          err.code = 'ACCOUNT_BLOCKED';
          reject(err);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`library request failed: ${res.statusCode} /api/auth/me`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('library request timed out')));
  });
}

/** Fetch subscription plans + active gateway (for the upgrade screen). */
export async function fetchPlans(base = DEFAULT_BASE) {
  return requestJson(base, '/api/billing/plans');
}

/** Start a Razorpay checkout → { gatewayOrderId, amountPaise, keyId, ... }. */
export async function createBillingOrder(base = DEFAULT_BASE, token, plan) {
  return postJson(base, '/api/billing/order', { plan }, authHeaders(token));
}

/** Confirm a completed Razorpay payment → activates the plan. */
export async function verifyBillingPayment(base = DEFAULT_BASE, token, payload) {
  return postJson(base, '/api/billing/verify', payload, authHeaders(token));
}

/** Fetch the filter chips (backend-controlled). */
export async function fetchFilters(base = DEFAULT_BASE, host) {
  const qs = host ? `?host=${encodeURIComponent(host)}` : '';
  const data = await requestJson(base, `/api/filters${qs}`);
  return data;
}

/** Fetch the backend-managed home page banner (null if none active). */
export async function fetchBanner(base = DEFAULT_BASE) {
  try {
    const data = await requestJson(base, '/api/banner');
    return data.banner || null;
  } catch {
    return null;
  }
}

/** Check for app updates. Returns { updateAvailable, version, url, notes, mandatory }. */
export async function checkUpdates(base = DEFAULT_BASE, current) {
  try {
    const data = await requestJson(base, `/api/updates/latest?current=${encodeURIComponent(current)}`);
    return data;
  } catch {
    return { updateAvailable: false };
  }
}

/** Chat status: can this user access the chatbox? */
export async function chatStatus(base = DEFAULT_BASE, token) {
  try {
    const data = await requestJson(base, '/api/chat/status', {
      headers: token ? { 'x-user-token': token } : {},
    });
    return data;
  } catch {
    return { allowed: false, reason: 'unreachable' };
  }
}

/** Send a chat message. Returns { reply } or { error }. */
export async function sendChat(base = DEFAULT_BASE, token, message, history = []) {
  const data = await requestJson(base, '/api/chat', {
    method: 'POST',
    headers: { 'x-user-token': token || '' },
    body: { message, history },
  });
  return data;
}

/** Fetch presets, optionally filtered by type/filter/search. */
export async function fetchPresets(base = DEFAULT_BASE, { type, filter, q, page = 1, limit = 24 } = {}) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (filter) params.set('filter', filter);
  if (q) params.set('q', q);
  params.set('page', String(page));
  params.set('limit', String(limit));
  return requestJson(base, `/api/presets?${params}`);
}

/** Fetch one preset by id or slug. */
export async function fetchPreset(base = DEFAULT_BASE, id) {
  return requestJson(base, `/api/presets/${encodeURIComponent(id)}`);
}

/** Poll the catalog version — non-null means "catalog has content". */
export async function catalogVersion(base = DEFAULT_BASE) {
  const data = await requestJson(base, '/api/catalog/version');
  return data.version || null;
}

/**
 * Download a preset's files to a local directory.
 * @returns {string[]} absolute paths of downloaded files
 */
export function downloadPresetFiles(base, preset, destDir, onProgress, opts) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const files = preset.files || [];
    const out = [];
    let i = 0;
    const next = () => {
      if (i >= files.length) { resolve(out); return; }
      const f = files[i++];
      // Backend file URLs look like /files/<relPath>; the download endpoint
      // wants ?file=<relPath>.
      let relPath = '';
      try {
        const u = new URL(f.url, base);
        if (u.pathname.startsWith('/files/')) relPath = decodeURIComponent(u.pathname.slice(7));
      } catch { /* fall through */ }
      const url = new URL(`/api/presets/${preset.id}/download?file=${encodeURIComponent(relPath)}`, base);
      const dest = path.join(destDir, path.basename(f.filename || `file-${i}`));
      // The agent knows who requested: send the login token so the backend
      // logs this download against the user's account.
      const headers = opts.userToken ? { 'x-user-token': opts.userToken } : {};
      let attempts = 0;
      const doGet = (targetUrl, redirectCount = 0) => {
        const ws = fs.createWriteStream(dest);
        const g = targetUrl.protocol === 'https:' ? get : httpGet;
        const req = g(targetUrl, { headers }, (res) => {
          // Follow redirects (S3 signed URLs come back as 302).
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < 5) {
            res.resume(); // drain
            doGet(new URL(res.headers.location, targetUrl), redirectCount + 1);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            ws.destroy();
            reject(new Error(`download failed: ${res.statusCode} for ${f.filename}`));
            return;
          }
          res.pipe(ws);
          ws.on('finish', () => {
            out.push(dest);
            if (onProgress) { try { onProgress({ done: out.length, total: files.length, file: f.filename }); } catch {} }
            next();
          });
        });
        req.on('error', (err) => {
          attempts++;
          // Retry transient TLS/network errors (e.g. BAD_DECRYPT) up to 3 times.
          const retryable = /BAD_DECRYPT|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(err.message || '');
          if (retryable && attempts < 3) {
            try { ws.destroy(); } catch {}
            setTimeout(() => doGet(targetUrl, redirectCount), 1000 * attempts);
            return;
          }
          try { ws.destroy(); } catch {}
          reject(err);
        });
        req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
      };
      doGet(url);
    };
    next();
  });
}

export { DEFAULT_BASE };

/**
 * Download any URL to a local file, with a size cap.
 * @param {string} url absolute http(s) URL
 * @param {string} destPath absolute destination path (parent dirs are created)
 * @param {{ maxBytes?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<string>} destPath
 */
export function downloadUrlToFile(url, destPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 60000;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`bad download URL: ${url}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`refusing non-http(s) download URL: ${parsed.protocol}`));
      return;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const getter = parsed.protocol === 'https:' ? get : httpGet;
    const ws = fs.createWriteStream(destPath);
    let bytes = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      try { ws.destroy(); } catch { /* ignore */ }
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      reject(err);
    };
    const req = getter(parsed, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        fail(new Error(`download failed: ${res.statusCode} for ${url}`));
        return;
      }
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) {
          fail(new Error(`download exceeded ${maxBytes} bytes: ${url}`));
          try { res.destroy(); } catch { /* ignore */ }
        }
      });
      res.on('error', fail);
      ws.on('error', fail);
      ws.on('finish', () => {
        if (done) return;
        done = true;
        resolve(destPath);
      });
      res.pipe(ws);
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error('download timed out')); } catch { /* ignore */ }
      fail(new Error('download timed out'));
    });
  });
}

/** Preset backend types -> local asset-store types (fallback when the file extension is unknown). */
const PRESET_TYPE_TO_ASSET_TYPE = {
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

const EXTENSION_TO_ASSET_TYPE = {
  '.mogrt': 'mogrt',
  '.cube': 'lut',
  '.mp4': 'broll', '.mov': 'broll', '.m4v': 'broll', '.avi': 'broll', '.mkv': 'broll', '.webm': 'broll',
  '.mp3': 'audio', '.wav': 'audio', '.aac': 'audio', '.m4a': 'audio', '.flac': 'audio', '.ogg': 'audio',
};

/** Infer the asset-store type for a downloaded file: extension first, preset type as fallback. */
export function assetTypeForFile(filename, presetType) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext && EXTENSION_TO_ASSET_TYPE[ext]) return EXTENSION_TO_ASSET_TYPE[ext];
  return PRESET_TYPE_TO_ASSET_TYPE[String(presetType || '')] || 'other';
}

/**
 * Install a backend catalog preset: download its files into
 * `<dataDir>/presets/<slug>/` and register placeable files in the asset store.
 * Shared by the launcher's Library tab download and the CEP panel's
 * one-click Install (via panel-sync's library-request watcher).
 *
 * @param {{ base?: string, dataDir: string, presetId: string,
 *   onProgress?: (p: {done:number,total:number,file:string,phase:string}) => void,
 *   createStore?: (opts:{dataDir:string}) => any }} opts
 * @returns {Promise<{ slug: string, files: string[], assetsRegistered: number, registered: Array<{id:string,type:string}> }>}
 */
export async function installPresetFromCatalog(opts) {
  const { dataDir, presetId, onProgress, createStore } = opts || {};
  const base = opts.base || DEFAULT_BASE;
  const userToken = opts.userToken || null;
  if (!dataDir) throw new Error('dataDir is required');
  if (!presetId || typeof presetId !== 'string' || !presetId.trim()) {
    throw new Error('preset id is required');
  }
  const preset = await fetchPreset(base, presetId.trim());
  if (!preset || !preset.slug) throw new Error(`preset not found: ${presetId}`);
  const destDir = path.join(dataDir, 'presets', preset.slug);
  const report = (p) => {
    if (onProgress) {
      try { onProgress({ slug: preset.slug, ...p }); } catch { /* ignore */ }
    }
  };
  const files = await downloadPresetFiles(base, preset, destDir, (p) => report({ ...p, phase: 'downloading' }), { userToken });
  // NOTE (2026-10-19): Library presets are NOT registered in the asset store.
  // The Assets tab is for user reference uploads (reverse engineering), not
  // library downloads. Library presets stay in the Library tab as "Installed".
  // Files land on disk under presets/<slug>/ for the Place flow.
  const assetsRegistered = 0;
  const registered = [];
  return { slug: preset.slug, files, assetsRegistered, registered };
}

/**
 * Derive an asset's compatible host apps from the installed plugins.
 *
 * Matches asset.type against every loaded plugin's assetTypes[].compatibleHosts
 * and returns the union. Unknown types (or no plugins) default to
 * ['premiere'] for backward compatibility with assets added before plugins.
 *
 * @param {string} assetType e.g. 'mogrt', 'lut', 'broll', 'music', 'other'
 * @param {Array<{manifest:object}>} plugins loaded plugins ({ manifest, dir, builtin })
 * @returns {string[]} hostIds
 */
/**
 * Asset types that are catalogued but never placeable on any host timeline.
 * 'aep' = After Effects project files: kept in the library for reference,
 * but must NOT fall through to the legacy ['premiere'] default below.
 */
export const NON_PLACEABLE_TYPES = ['aep'];

export function deriveAssetHosts(assetType, plugins = []) {
  const type = String(assetType || '').toLowerCase();
  if (NON_PLACEABLE_TYPES.includes(type)) return [];
  const hosts = [];
  for (const p of Array.isArray(plugins) ? plugins : []) {
    const assetTypes = (p && p.manifest && p.manifest.assetTypes) || [];
    for (const at of assetTypes) {
      if (String((at && at.type) || '').toLowerCase() !== type) continue;
      for (const h of (at && at.compatibleHosts) || []) {
        if (typeof h === 'string' && h && !hosts.includes(h)) hosts.push(h);
      }
    }
  }
  return hosts.length > 0 ? hosts : ['premiere'];
}

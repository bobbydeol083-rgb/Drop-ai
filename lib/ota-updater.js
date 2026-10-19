// Drop AI — robust OTA updater (desktop side).
// Copyright by Dork Industry.
//
// Flow:
// 1. Check GET /api/ota/latest.yml on startup (and every 6h).
// 2. If a newer version exists, show the blue "Restart to update →" button.
// 3. On click: try a PATCH first (only changed files, ~10-30MB), fall back
//    to the full package (893MB) if no patch is available.
// 4. Patch: copy current install to staging, overlay changed files, verify
//    hashes. Full: download zip, verify SHA256, extract to staging.
// 5. Prompt "Restart to apply" — on restart, the staging dir is swapped
//    in atomically before the app boots.
//
// Patch format (patch.zip):
//   patch-manifest.json — {version, fromVersion, files:[{path,sha256,size}], deleted:[paths]}
//   files/<relative-path> — changed/added files
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = 'https://mcpagent.cloud';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https:') ? httpsGet : httpGet;
    const req = getter(url, (res) => {
      if (res.statusCode === 204) { resolve(null); return; } // no update
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`OTA check failed: ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('OTA check timed out')));
  });
}

function parseYml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Check for updates. Returns manifest or null. */
export async function checkForUpdates(currentVersion) {
  try {
    const text = await fetchText(`${BASE}/api/ota/latest.yml?current=${encodeURIComponent(currentVersion)}`);
    if (!text) return null;
    // Legacy JSON fallback (version published but package not uploaded).
    if (text.trim().startsWith('{')) {
      const j = JSON.parse(text);
      if (j.updateAvailable) return { ...j, legacy: true };
      return null;
    }
    const m = parseYml(text);
    if (!m.version) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Download with progress, retries and resume. onProgress(received, total).
 * Returns the file path. Survives flaky networks: up to 4 attempts, resumes
 * partial downloads via Range requests, and aborts stalled connections.
 */
export function downloadUpdate(manifest, destDir, onProgress, onLog) {
  const log = (msg) => { try { if (onLog) onLog(msg); } catch {} };
  const url = manifest.url.startsWith('http') ? manifest.url : BASE + manifest.url;
  log(`downloading update ${manifest.version || ''} from ${url}`);
  const getter = url.startsWith('https:') ? httpsGet : httpGet;
  const dest = path.join(destDir, manifest.file || 'update.zip');
  fs.mkdirSync(destDir, { recursive: true });
  const total = parseInt(manifest.size || '0', 10);
  const MAX_ATTEMPTS = 4;
  const INACTIVITY_MS = 30000;

  function attempt() {
    return new Promise((resolve, reject) => {
      // Resume from a partial file when possible.
      let start = 0;
      try {
        const st = fs.statSync(dest);
        if (st.size > 0 && total > 0 && st.size < total) start = st.size;
        else if (total > 0 && st.size >= total) { try { fs.unlinkSync(dest); } catch {} }
      } catch { /* no partial file */ }
      let received = start;
      let settled = false;
      let lastActivity = Date.now();
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        if (err) { log(`download attempt failed: ${err.message}`); reject(err); }
        else { log(`download complete: ${dest} (${received} bytes)`); resolve(dest); }
      };
      const req = getter(url, { headers: start > 0 ? { Range: `bytes=${start}-` } : {} }, (res) => {
        const isResume = res.statusCode === 206;
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          done(new Error(`Download failed: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        if (!isResume && start > 0) { received = 0; } // server ignored range — restart
        const file = fs.createWriteStream(dest, { flags: isResume ? 'a' : 'w' });
        res.on('data', (c) => {
          lastActivity = Date.now();
          received += c.length;
          if (onProgress) { try { onProgress(received, total); } catch {} }
        });
        res.on('end', () => file.end());
        res.on('error', done);
        file.on('finish', () => done());
        file.on('error', done);
        res.pipe(file);
      });
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > INACTIVITY_MS) {
          req.destroy(new Error('Download stalled — no data for 30s'));
        }
      }, 5000);
      req.on('error', done);
      req.setTimeout(20000, () => req.destroy(new Error('Could not reach the update server')));
    });
  }

  return (async () => {
    let lastErr = null;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      try {
        return await attempt();
      } catch (err) {
        lastErr = err;
        if (i < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * i));
      }
    }
    throw new Error(`Update download failed after ${MAX_ATTEMPTS} tries: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
  })();
}

/** Verify SHA256. */
export function verifySha256(filePath, expected) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex') === expected.toLowerCase()));
    stream.on('error', reject);
  });
}

/**
 * Stage the update: extract the zip to <appDir>.update-staging.
 * Uses pure-Node.js extraction (unzipper) — no PowerShell dependency.
 * Returns the staging dir. The actual swap happens on next launch
 * (see applyStagedUpdate, called before app boot).
 */
export async function stageUpdate(zipPath, appDir, onLog) {
  const log = (msg) => { try { if (onLog) onLog(msg); } catch {} };
  const staging = path.join(path.dirname(appDir), path.basename(appDir) + '.update-staging');
  log(`staging update: ${zipPath} -> ${staging}`);
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // Pure-Node.js extraction — no PowerShell, no shell quoting issues.
  const { Extract } = await import('unzipper');
  await new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(Extract({ path: staging }))
      .on('close', resolve)
      .on('error', reject);
  });
  log('extraction complete');
  // The distribution zip wraps the app in a single top-level folder
  // (win-unpacked/). Flatten it so the staging dir mirrors the app dir.
  const entries = fs.readdirSync(staging);
  if (entries.length === 1) {
    const only = path.join(staging, entries[0]);
    if (fs.statSync(only).isDirectory()) {
      const tmp = staging + '.flatten';
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
      fs.renameSync(only, tmp);
      fs.rmdirSync(staging);
      fs.renameSync(tmp, staging);
    }
  }
  // Sanity check: the staged app must contain the executable, otherwise the
  // swap would brick the install.
  if (!fs.existsSync(path.join(staging, 'Drop AI.exe'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('Update package is incomplete (application executable missing)');
  }
  // Mark the staging dir with the version for the swap.
  fs.writeFileSync(path.join(staging, '.update-ready'), Date.now().toString());
  return staging;
}

/**
 * Apply a staged update: called at the very start of main.js, before
 * anything else boots. Atomically swaps the staging dir into place.
 * Returns true if an update was applied (caller must relaunch).
 */
export function applyStagedUpdate(appDir) {
  try {
    const staging = path.join(path.dirname(appDir), path.basename(appDir) + '.update-staging');
    const backup = appDir + '.update-backup';
    // Best-effort cleanup of a PREVIOUS backup. Its executable is not running
    // anymore (we boot from appDir now), so this is safe. Never delete the
    // backup created by the current swap — it holds our own running exe.
    if (fs.existsSync(backup)) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch {} }
    const marker = path.join(staging, '.update-ready');
    if (!fs.existsSync(marker)) return false;
    // Rotate: current -> backup, staging -> current.
    try {
      fs.renameSync(appDir, backup);
    } catch {
      // The rename failed — almost always because the exe is running from
      // INSIDE appDir (nested win-unpacked install), so Windows locks it.
      // Fall back to a helper batch script: it waits for us to exit, then
      // does the swap and relaunches. Returns 'helper' so the caller exits
      // without relaunching (the helper launches the new version).
      return spawnSwapHelper(appDir, staging, backup);
    }
    try {
      fs.renameSync(staging, appDir);
    } catch {
      // Swap failed halfway — roll back so the install is never left broken.
      try { fs.renameSync(backup, appDir); } catch {}
      return false;
    }
    // Drop the stale marker from the new app dir.
    try { fs.unlinkSync(path.join(appDir, '.update-ready')); } catch {}
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a batch helper that swaps the update after this process exits.
 * Used when the app runs from inside the folder being replaced (Windows
 * locks the running exe's directory, so in-process rename fails).
 * Returns 'helper' if the helper was launched (caller must exit at once),
 * or false if the helper could not be created.
 */
function spawnSwapHelper(appDir, staging, backup) {
  try {
    const os = require('node:os');
    const exePath = path.join(appDir, 'Drop AI.exe');
    const stamp = Date.now();
    const batPath = path.join(os.tmpdir(), 'dropai-update-' + stamp + '.bat');
    const vbsPath = path.join(os.tmpdir(), 'dropai-update-' + stamp + '.vbs');
    // Batch: wait for the app to exit, swap folders, relaunch, clean up.
    const bat =
      '@echo off\r\n' +
      ':waitloop\r\n' +
      'tasklist /fi "imagename eq Drop AI.exe" 2>nul | find /i "Drop AI.exe" >nul\r\n' +
      'if not errorlevel 1 ( timeout /t 1 /nobreak >nul & goto waitloop )\r\n' +
      // Extra grace period: ensure file handles are released.
      'timeout /t 2 /nobreak >nul\r\n' +
      `if exist "${backup}" rmdir /s /q "${backup}"\r\n` +
      `move "${appDir}" "${backup}" >nul\r\n` +
      `if errorlevel 1 ( echo SWAP_FAILED_MOVE_APP >> "${path.join(os.tmpdir(), 'dropai-update-' + stamp + '.log')}" & goto :eof )\r\n` +
      `move "${staging}" "${appDir}" >nul\r\n` +
      `if errorlevel 1 ( echo SWAP_FAILED_MOVE_STAGING >> "${path.join(os.tmpdir(), 'dropai-update-' + stamp + '.log')}" & move "${backup}" "${appDir}" >nul & goto :eof )\r\n` +
      `del "${path.join(appDir, '.update-ready')}" 2>nul\r\n` +
      `echo SWAP_OK > "${path.join(os.tmpdir(), 'dropai-update-' + stamp + '.log')}"\r\n` +
      `start "" "${exePath}"\r\n` +
      'del "%~f0"\r\n';
    fs.writeFileSync(batPath, bat);
    // VBScript launcher: runs the .bat fully independent of this process.
    // Unlike spawn(detached), this survives app.exit() on Windows because
    // wscript.exe is not a child of the Electron process tree.
    const vbs =
      'Set ws = CreateObject("WScript.Shell")\r\n' +
      `ws.Run "cmd.exe /c \"${batPath}\"", 0, False\r\n` +
      `CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName\r\n`;
    fs.writeFileSync(vbsPath, vbs);
    // Launch via wscript — fire and forget. The VBS deletes itself.
    require('node:child_process').execFile('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    return 'helper';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Delta patches: download only changed files, apply to a copy.        */
/* ------------------------------------------------------------------ */

/** Hash a file with SHA256 (hex). */
function sha256FileLocal(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Download a patch file (same robust logic as full downloads).
 * Returns the patch zip path.
 */
export function downloadPatch(manifest, destDir, onProgress, onLog) {
  const log = (msg) => { try { if (onLog) onLog(msg); } catch {} };
  const patchManifest = {
    ...manifest,
    url: manifest.patchUrl,
    file: manifest.patchFile,
    size: manifest.patchSize,
    sha256: manifest.patchSha256,
  };
  log(`downloading patch ${manifest.patchFrom || ''} -> ${manifest.version} (${manifest.patchSize || '?'} bytes)`);
  return downloadUpdate(patchManifest, destDir, onProgress, onLog);
}

/** Recursively copy a directory. */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(s), d); } catch { /* skip */ }
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Apply a patch: copy the current install to staging, overlay changed files,
 * remove deleted files, verify hashes. Returns the staging dir.
 *
 * This never touches the running app — the swap happens on restart via
 * applyStagedUpdate, same as full updates.
 */
export async function applyPatch(patchZipPath, appDir, onLog) {
  const log = (msg) => { try { if (onLog) onLog(msg); } catch {} };
  const staging = path.join(path.dirname(appDir), path.basename(appDir) + '.update-staging');
  const tmpDir = path.join(path.dirname(appDir), path.basename(appDir) + '.update-patch-tmp');
  log(`applying patch: ${patchZipPath}`);
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Extract the patch.
    const { Extract } = await import('unzipper');
    await new Promise((resolve, reject) => {
      fs.createReadStream(patchZipPath)
        .pipe(Extract({ path: tmpDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    const manifestPath = path.join(tmpDir, 'patch-manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('Patch is missing its manifest');
    const pm = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(pm.files)) throw new Error('Patch manifest is invalid');
    log(`patch ${pm.fromVersion || '?'} -> ${pm.version || '?'}: ${pm.files.length} changed, ${(pm.deleted || []).length} removed`);

    // 2. Copy the current install to staging (the running app is untouched).
    log('copying current install to staging…');
    copyDirSync(appDir, staging);

    // 3. Overlay changed files.
    const patchFilesDir = path.join(tmpDir, 'files');
    for (const f of pm.files) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      // Safety: no absolute paths, no parent traversal.
      if (!rel || rel.startsWith('/') || rel.includes('..')) {
        throw new Error(`Unsafe path in patch manifest: ${f.path}`);
      }
      const src = path.join(patchFilesDir, rel);
      const dest = path.join(staging, rel);
      if (!fs.existsSync(src)) throw new Error(`Patch is missing file: ${rel}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    // 4. Remove deleted files.
    for (const relRaw of (pm.deleted || [])) {
      const rel = String(relRaw || '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.includes('..')) continue;
      try { fs.rmSync(path.join(staging, rel), { recursive: true, force: true }); } catch { /* already gone */ }
    }

    // 5. Verify every patched file's hash.
    log('verifying patched files…');
    for (const f of pm.files) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      const actual = await sha256FileLocal(path.join(staging, rel));
      if (actual.toLowerCase() !== String(f.sha256 || '').toLowerCase()) {
        throw new Error(`Patched file failed verification: ${rel}`);
      }
    }

    // 6. Sanity check + marker, same as full updates.
    if (!fs.existsSync(path.join(staging, 'Drop AI.exe'))) {
      throw new Error('Patched app is incomplete (application executable missing)');
    }
    fs.writeFileSync(path.join(staging, '.update-ready'), Date.now().toString());
    log(`patch applied and verified: ${staging}`);
    return staging;
  } finally {
    // Always clean the temp dir.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

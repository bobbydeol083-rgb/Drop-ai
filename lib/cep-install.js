// Drop AI — one-click CEP panel installer.
// Copyright by Dork Industry.
//
// Copies a bundled CEP extension into Adobe's CEP extensions folder
// and enables unsigned (debug) extensions, so editors never touch the
// registry or AppData by hand. Called from the launcher's main process via
// the 'dropai:installCepPanel' / 'dropai:cepPanelStatus' IPC handlers.
//
// Per-plugin: pass { plugin } (a loaded plugin { manifest, dir }) to
// install or query that plugin's panel. The source dir comes from the
// plugin's manifest cepPanel.dir under its plugin dir, and the target
// folder name comes from manifest cepPanel.dirName. Bare calls keep the
// exact Premiere behavior (default source dir plugins/premiere/cep,
// target folder "DropAI").
//
// Windows:  %APPDATA%\Adobe\CEP\extensions\<dirName>  (+ PlayerDebugMode under
//           HKCU\Software\Adobe\CSXS.9 … CSXS.13 via reg.exe — HKCU needs no
//           admin rights). CSXS.9–13 covers Premiere Pro 2021 → 2025+.
// macOS:    ~/Library/Application Support/Adobe/CEP/extensions/<dirName>
//           (+ `defaults write com.adobe.CSXN.N PlayerDebugMode 1`).
// Linux:    not supported (no Adobe apps).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PANEL_DIR_NAME = 'DropAI';
// CSXS key suffixes covering Premiere Pro 2021 (CEP 9) through 2026+ (CEP 15).
export const CSXS_VERSIONS = ['9', '10', '11', '12', '13', '14', '15'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the panel source directory.
 *
 * - With a loaded plugin ({ manifest, dir }): path.join(dir, manifest.cepPanel.dir).
 * - With a plugin manifest but no dir: fall back to the standard dev/packaged
 *   plugin layout for that plugin id.
 * - Bare call: the Premiere panel default (plugins/premiere/cep).
 */
export function getPanelSourceDir({ plugin, resourcesPath, isPackaged, dirname } = {}) {
  if (plugin && plugin.manifest && plugin.manifest.id) {
    const cepDir = (plugin.manifest.cepPanel && plugin.manifest.cepPanel.dir) || 'cep';
    if (plugin.dir) return path.join(plugin.dir, cepDir);
    if (isPackaged && resourcesPath) {
      return path.join(resourcesPath, 'app', 'plugins', plugin.manifest.id, cepDir);
    }
    return path.resolve(dirname || HERE, '..', '..', '..', 'plugins', plugin.manifest.id, cepDir);
  }
  if (isPackaged && resourcesPath) {
    return path.join(resourcesPath, 'app', 'plugins', 'premiere', 'cep');
  }
  return path.resolve(dirname || HERE, '..', '..', '..', 'plugins', 'premiere', 'cep');
}

export function getPanelTargetDir(platform = process.platform, dirName = PANEL_DIR_NAME) {
  const leaf = dirName || PANEL_DIR_NAME;
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, 'Adobe', 'CEP', 'extensions', leaf);
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', leaf);
  }
  return null;
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, error: String((stderr || error.message || error)).slice(0, 300) });
      else resolve({ ok: true, output: String(stdout || '').slice(0, 300) });
    });
  });
}

export async function enableDebugMode(platform = process.platform) {
  const results = [];
  if (platform === 'win32') {
    for (const v of CSXS_VERSIONS) {
      const key = `HKCU\\Software\\Adobe\\CSXS.${v}`;
      const r = await runCmd('reg.exe', ['add', key, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f']);
      results.push({ key, ok: r.ok, error: r.error || null });
    }
  } else if (platform === 'darwin') {
    for (const v of CSXS_VERSIONS) {
      const r = await runCmd('defaults', ['write', `com.adobe.CSXS.${v}`, 'PlayerDebugMode', '1']);
      results.push({ key: `com.adobe.CSXS.${v}`, ok: r.ok, error: r.error || null });
    }
  }
  return results;
}

export function copyPanelFiles(sourceDir, targetDir) {
  if (!fs.existsSync(path.join(sourceDir, 'CSXS', 'manifest.xml'))) {
    return { ok: false, error: `panel source not found at ${sourceDir}` };
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err).slice(0, 300) };
  }
}

/**
 * Stage extra plugin-root directories (declared via manifest
 * `cepPanel.extraDirs`, e.g. the premiere plugin's "jsx/") into the installed
 * panel target. Without this, the installed DropAI/ target would miss
 * jsx/premiere-lib.jsx and the __dropai contract would not load in Premiere.
 * Pure helper (no platform calls) — unit-tested.
 */
export function stageExtraDirs(pluginRoot, targetDir, extraDirs) {
  const staged = [];
  for (const rel of extraDirs || []) {
    if (typeof rel !== 'string' || !/^[A-Za-z0-9_-]+$/.test(rel)) {
      staged.push({ dir: String(rel), ok: false, error: 'invalid extra dir name' });
      continue;
    }
    const src = path.join(pluginRoot, rel);
    const dest = path.join(targetDir, rel);
    try {
      if (!fs.existsSync(src)) {
        staged.push({ dir: rel, ok: false, error: `not found at ${src}` });
        continue;
      }
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      staged.push({ dir: rel, ok: true });
    } catch (err) {
      staged.push({ dir: rel, ok: false, error: String((err && err.message) || err).slice(0, 300) });
    }
  }
  return staged;
}

/**
 * Install a plugin's CEP panel. Pass { plugin } for a per-plugin install;
 * a bare call installs the Premiere panel exactly as before.
 */
export async function installCepPanel(opts = {}) {
  const platform = opts.platform || process.platform;
  const steps = [];
  if (platform !== 'win32' && platform !== 'darwin') {
    return { ok: false, steps: [{ name: 'platform', ok: false, error: 'Premiere Pro only runs on Windows and macOS' }] };
  }
  const plugin = opts.plugin || null;
  const cepPanel = plugin ? plugin.manifest && plugin.manifest.cepPanel : null;
  if (plugin && !cepPanel) {
    return { ok: false, steps: [{ name: 'manifest', ok: false, error: `plugin "${plugin.manifest && plugin.manifest.id}" has no cepPanel section` }] };
  }
  const dirName = (cepPanel && cepPanel.dirName) || PANEL_DIR_NAME;
  const sourceDir = getPanelSourceDir(opts);
  const targetDir = getPanelTargetDir(platform, dirName);
  if (!targetDir) {
    return { ok: false, steps: [{ name: 'target', ok: false, error: 'could not resolve the CEP extensions folder' }] };
  }

  const copy = copyPanelFiles(sourceDir, targetDir);
  steps.push({ name: 'copy', ok: copy.ok, error: copy.error || null, detail: targetDir });
  if (!copy.ok) return { ok: false, steps };

  // Stage extra plugin-root dirs (e.g. premiere's jsx/) into the target.
  const extraDirs = (cepPanel && cepPanel.extraDirs) || [];
  if (plugin && extraDirs.length > 0) {
    const pluginRoot = plugin.dir || path.dirname(sourceDir);
    const staged = stageExtraDirs(pluginRoot, targetDir, extraDirs);
    const failed = staged.filter((s) => !s.ok);
    steps.push({
      name: 'extra-dirs',
      ok: failed.length === 0,
      error: failed.length ? failed.map((s) => `${s.dir}: ${s.error}`).join('; ') : null,
    });
    if (failed.length > 0) return { ok: false, steps };
  }

  const debugModes = await enableDebugMode(platform);
  const failedKeys = debugModes.filter((r) => !r.ok);
  steps.push({
    name: 'debug-mode',
    ok: failedKeys.length === 0,
    error: failedKeys.length ? failedKeys.map((r) => `${r.key}: ${r.error}`).join('; ') : null,
  });

  const ok = steps.every((s) => s.ok);
  return { ok, steps, targetDir };
}

/**
 * Status of a plugin's installed CEP panel. Bare call = Premiere panel.
 */
export async function getCepPanelStatus(opts = {}) {
  const platform = opts.platform || process.platform;
  const plugin = opts.plugin || null;
  const cepPanel = plugin ? plugin.manifest && plugin.manifest.cepPanel : null;
  const dirName = (cepPanel && cepPanel.dirName) || PANEL_DIR_NAME;
  const targetDir = getPanelTargetDir(platform, dirName);
  const installed = !!targetDir && fs.existsSync(path.join(targetDir, 'CSXS', 'manifest.xml'));
  let debugMode = null;
  if (platform === 'win32') {
    const r = await runCmd('reg.exe', ['query', 'HKCU\\Software\\Adobe\\CSXS.11', '/v', 'PlayerDebugMode']);
    debugMode = r.ok && /0x1|1/.test(r.output);
  } else if (platform === 'darwin') {
    const r = await runCmd('defaults', ['read', 'com.adobe.CSXS.11', 'PlayerDebugMode']);
    debugMode = r.ok && /1/.test(r.output);
  }
  return { installed, debugMode, targetDir, platform };
}

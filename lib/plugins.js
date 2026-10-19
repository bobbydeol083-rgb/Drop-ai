// Drop AI — plugin list helpers for the launcher main process.
// Copyright by Dork Industry.
//
// Pure functions only (no Electron, no I/O beyond path math) so they can be
// unit-tested. The plugin objects handled here are loaded plugins:
//   { manifest, dir, builtin }
// where manifest follows the plugin.json schema (docs/plugin-architecture.md §2).
import path from 'node:path';

/**
 * Resolve the built-in + user plugin directories.
 * Mirrors @drop-ai/plugin-host's getPluginDirs contract so the launcher can
 * fall back to the standard layout when the package is unavailable.
 */
export function resolvePluginDirs({ resourcesPath, isPackaged, dataDir, repoRoot } = {}) {
  const builtinDir =
    isPackaged && resourcesPath
      ? path.join(resourcesPath, 'app', 'plugins')
      : path.join(repoRoot || process.cwd(), 'plugins');
  const userDir = dataDir ? path.join(dataDir, 'plugins') : null;
  return { builtinDir, userDir };
}

/**
 * Legacy fallback for the built-in Premiere plugin, used when
 * @drop-ai/plugin-host (or the plugins/ tree) is unavailable. Keeps the
 * launcher's Premiere section alive no matter what.
 */
export function legacyPremierePlugin({ repoRoot, resourcesPath, isPackaged } = {}) {
  const dir =
    isPackaged && resourcesPath
      ? path.join(resourcesPath, 'app', 'plugins', 'premiere')
      : path.join(repoRoot || process.cwd(), 'plugins', 'premiere');
  return {
    manifest: {
      manifestVersion: 1,
      id: 'premiere',
      name: 'Premiere Pro',
      version: '3.0.0',
      hostApp: 'Premiere Pro',
      hostId: 'premiere',
      jsEngine: 'extendscript',
      builtin: true,
      cepPanel: {
        dir: 'cep',
        extensionId: 'com.dorkindustry.dropai.premiere',
        dirName: 'DropAI',
      },
      ui: {
        sectionTitle: 'Premiere Pro',
        tabs: [{ id: 'overview', title: 'Overview' }],
      },
      assetTypes: [
        { type: 'mogrt', label: '.mogrt titles', compatibleHosts: ['premiere'] },
        { type: 'lut', label: 'LUTs', compatibleHosts: ['premiere'] },
        { type: 'broll', label: 'B-roll footage', compatibleHosts: ['premiere'] },
        { type: 'music', label: 'Music', compatibleHosts: ['premiere'] },
        { type: 'other', label: 'Other', compatibleHosts: ['premiere'] },
      ],
    },
    dir,
    builtin: true,
  };
}

/** Payload shape for the dropai:listPlugins IPC (and the renderer's UI). */
export function pluginListPayload(plugins) {
  return (Array.isArray(plugins) ? plugins : []).map((p) => ({
    id: p?.manifest?.id ?? '',
    name: p?.manifest?.name ?? p?.manifest?.id ?? '',
    version: p?.manifest?.version ?? '',
    hostId: p?.manifest?.hostId ?? '',
    builtin: Boolean(p?.builtin),
    installed: true,
  }));
}

/** Unique hostIds across loaded plugins, in discovery order. */
export function hostIds(plugins) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(plugins) ? plugins : []) {
    const id = p?.manifest?.hostId;
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function findPlugin(plugins, id) {
  if (!id) return null;
  return (Array.isArray(plugins) ? plugins : []).find((p) => p?.manifest?.id === id) || null;
}

export function findPluginByHostId(plugins, hostId) {
  if (!hostId) return null;
  return (Array.isArray(plugins) ? plugins : []).find((p) => p?.manifest?.hostId === hostId) || null;
}

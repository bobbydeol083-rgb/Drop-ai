// Drop AI — one-click MCP client connect (Phase D).
// Copyright by Dork Industry.
//
// Auto-detects installed AI clients (Claude Desktop, Antigravity, ChatGPT),
// and one-click writes the Drop AI MCP config into the client's own config
// file — no copy/paste, no manual JSON merging. Backs up the original first.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const PROGRAMFILES = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const STARTMENU = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

// Where each client keeps its MCP config on Windows.
export const CLIENTS = {
  claude: {
    id: 'claude',
    name: 'Claude Desktop',
    // Config file; the app itself lives in %LOCALAPPDATA%\\AnthropicClaude.
    // Microsoft Store (MSIX) builds virtualize %APPDATA% into the package container.
    configPath: () => {
      const std = path.join(APPDATA, 'Claude', 'claude_desktop_config.json');
      if (fs.existsSync(std)) return std;
      // Store version: %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
      try {
        const pkgDir = path.join(LOCALAPPDATA, 'Packages');
        const entries = fs.readdirSync(pkgDir);
        for (const e of entries) {
          if (e.toLowerCase().startsWith('claude_')) {
            const p = path.join(pkgDir, e, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');
            if (fs.existsSync(p)) return p;
            // Return the expected path even if file doesn't exist yet (for creation).
            return p;
          }
        }
      } catch { /* ignore */ }
      return std;
    },
    appPaths: [
      () => path.join(LOCALAPPDATA, 'AnthropicClaude', 'Claude.exe'),
      () => path.join(APPDATA, 'Claude', 'Claude.exe'),
      () => path.join(PROGRAMFILES, 'AnthropicClaude', 'Claude.exe'),
      () => path.join(PROGRAMFILES, 'Claude', 'Claude.exe'),
      () => path.join(PROGRAMFILES_X86, 'AnthropicClaude', 'Claude.exe'),
    ],
    startMenuNames: ['Claude.lnk', 'AnthropicClaude.lnk'],
    registryNames: ['Claude'],
    processNames: ['Claude.exe'],
    exeNames: ['Claude.exe'],
    kind: 'stdio',
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    configPath: () => path.join(APPDATA, 'Antigravity', 'mcp_config.json'),
    appPaths: [
      () => path.join(LOCALAPPDATA, 'Antigravity', 'Antigravity.exe'),
      () => path.join(os.homedir(), '.antigravity', 'mcp_config.json'),
      () => path.join(PROGRAMFILES, 'Antigravity', 'Antigravity.exe'),
      () => path.join(PROGRAMFILES, 'Google', 'Antigravity', 'Antigravity.exe'),
    ],
    startMenuNames: ['Antigravity.lnk'],
    registryNames: ['Antigravity'],
    processNames: ['Antigravity.exe'],
    exeNames: ['Antigravity.exe'],
    kind: 'stdio',
  },
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    // ChatGPT's MCP connectors are cloud-configured (Settings → Connectors);
    // there is no local config file to write. We offer the tunnel instead.
    configPath: () => null,
    appPaths: [
      () => path.join(LOCALAPPDATA, 'OpenAI', 'ChatGPT.exe'),
      () => path.join(PROGRAMFILES, 'OpenAI', 'ChatGPT.exe'),
    ],
    startMenuNames: ['ChatGPT.lnk'],
    kind: 'remote',
  },
};

/** Check Windows Registry uninstall keys for installed apps. */
import { execFileSync } from 'node:child_process';

function checkRegistry(displayNames) {
  if (process.platform !== 'win32') return false;
  try {
    const keys = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (const key of keys) {
      try {
        const out = execFileSync('reg', ['query', key, '/s', '/f', 'DisplayName', '/e'], { encoding: 'utf8', timeout: 5000 });
        for (const name of displayNames) {
          if (out.toLowerCase().includes(name.toLowerCase())) return true;
        }
      } catch { /* key may not exist */ }
    }
  } catch { /* ignore */ }
  return false;
}

/** Check Start Menu for app shortcuts (catches non-standard install locations). */
function checkStartMenu(names) {
  if (!names) return false;
  try {
    for (const n of names) {
      if (fs.existsSync(path.join(STARTMENU, n))) return true;
      // Also check subfolders (one level).
      const entries = fs.readdirSync(STARTMENU, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          if (fs.existsSync(path.join(STARTMENU, e.name, n))) return true;
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

/** Detect which clients are installed. Returns [{ id, name, installed, configExists, diagnostics }]. */
export function detectClients() {
  return Object.values(CLIENTS).map((c) => {
    const cfg = c.configPath();
    const diagnostics = [];
    let installed = false;
    let foundVia = null;
    try {
      // 1. Check exe paths
      for (const p of c.appPaths) {
        try {
          const full = p();
          const exists = fs.existsSync(full);
          diagnostics.push(`path:${full}=${exists}`);
          if (exists && !installed) { installed = true; foundVia = 'exe-path'; }
        } catch (e) { diagnostics.push(`path:error ${e.message}`); }
      }
      // 2. Start Menu shortcuts
      if (!installed && c.startMenuNames) {
        const sm = checkStartMenu(c.startMenuNames);
        diagnostics.push(`startmenu=${sm}`);
        if (sm) { installed = true; foundVia = 'start-menu'; }
      }
      // 3. Windows Registry
      if (!installed && c.registryNames) {
        const reg = checkRegistry(c.registryNames);
        diagnostics.push(`registry=${reg}`);
        if (reg) { installed = true; foundVia = 'registry'; }
      }
      // 4. Config file
      if (!installed && cfg) {
        const cfgExists = fs.existsSync(cfg);
        diagnostics.push(`config:${cfg}=${cfgExists}`);
        if (cfgExists) { installed = true; foundVia = 'config-file'; }
      }
      // 5. Check running processes (if the exe is running, it's installed)
      if (!installed && process.platform === 'win32' && c.processNames) {
        try {
          const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000 });
          const running = c.processNames.some((pn) => out.toLowerCase().includes(pn.toLowerCase()));
          diagnostics.push(`process=${running}`);
          if (running) { installed = true; foundVia = 'running-process'; }
        } catch (e) { diagnostics.push(`process:error`); }
      }
      // 6. PowerShell system-wide search (catches ANY install location)
      if (!installed && process.platform === 'win32' && c.exeNames) {
        try {
          for (const exe of c.exeNames) {
            const out = execFileSync('powershell', [
              '-NoProfile', '-Command',
              `Get-ChildItem -Path $env:LOCALAPPDATA, $env:ProgramFiles -Filter '${exe}' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`,
            ], { encoding: 'utf8', timeout: 15000 });
            const found = out.trim();
            diagnostics.push(`powershell-search:${exe}=${found || 'not found'}`);
            if (found) { installed = true; foundVia = 'powershell-search'; break; }
          }
        } catch (e) { diagnostics.push(`powershell-search:error`); }
      }
      // 7. Microsoft Store packages folder
      if (!installed && process.platform === 'win32') {
        const packagesDir = path.join(LOCALAPPDATA, 'Packages');
        try {
          const entries = fs.readdirSync(packagesDir);
          const match = entries.find((e) => e.toLowerCase().includes(c.id.toLowerCase()));
          diagnostics.push(`store-packages=${match || 'none'}`);
          if (match) { installed = true; foundVia = 'ms-store'; }
        } catch (e) { diagnostics.push(`store-packages:error`); }
      }
    } catch (e) { diagnostics.push(`fatal:${e.message}`); }
    let configExists = false;
    try { configExists = !!(cfg && fs.existsSync(cfg)); } catch { /* ignore */ }
    return { id: c.id, name: c.name, kind: c.kind, installed, configExists, foundVia, diagnostics };
  });
}

/**
 * One-click auto-configure: merge the Drop AI MCP server entry into the
 * client's config file (creating it if needed). Backs up the original.
 * Returns { ok, path, backup }.
 */
export function autoConfigure(clientId, serverEntry) {
  const c = CLIENTS[clientId];
  if (!c) throw new Error(`unknown client: ${clientId}`);
  const cfgPath = c.configPath();
  if (!cfgPath) throw new Error(`${c.name} is configured in its own settings UI — use the tunnel below.`);
  if (c.kind !== 'stdio') throw new Error(`${c.name} does not use a local stdio config.`);

  let cfg = {};
  let backup = null;
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    try {
      cfg = JSON.parse(raw);
    } catch {
      // Corrupt JSON — back it up and start fresh rather than crashing.
      backup = `${cfgPath}.dropai-backup-${Date.now()}`;
      fs.copyFileSync(cfgPath, backup);
      cfg = {};
    }
    if (!backup) {
      backup = `${cfgPath}.dropai-backup-${Date.now()}`;
      fs.copyFileSync(cfgPath, backup);
    }
  }
  if (typeof cfg !== 'object' || cfg === null) cfg = {};
  if (typeof cfg.mcpServers !== 'object' || cfg.mcpServers === null) cfg.mcpServers = {};
  cfg.mcpServers['drop-ai'] = serverEntry;

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return { ok: true, path: cfgPath, backup };
}

/** Check whether the drop-ai entry is already present in a client's config. */
export function isConfigured(clientId) {
  const c = CLIENTS[clientId];
  if (!c) return false;
  const cfgPath = c.configPath();
  if (!cfgPath || !fs.existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return !!(cfg.mcpServers && cfg.mcpServers['drop-ai']);
  } catch {
    return false;
  }
}

// Drop AI — shared path + runtime resolution for the launcher.
// Copyright by Dork Industry.
//
// Pure Node (no Electron import) so it can be unit-tested with plain
// `node --test`. main.js imports these constants instead of defining them
// inline — this is what keeps the child-process entry paths covered by a
// regression test.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root when running from source: <repo>/packages/launcher/lib -> <repo>. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Entry script for the WebSocket relay child process. */
export const RELAY_ENTRY = path.join(REPO_ROOT, 'packages', 'relay', 'index.js');

/** Entry script for the MCP server (stdio) child process. */
export const MCP_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'index.js');

/** Entry script for the remote HTTP transport child process. */
export const HTTP_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'http-server.js');

/** Seed Markdown docs synced into the knowledge store on first run. */
export const KNOWLEDGE_SEED_ROOT = path.join(REPO_ROOT, 'knowledge');

/**
 * Runtime used to spawn the relay / MCP / HTTP child processes.
 * In a packaged build we ship a plain Node.js runtime next to the app
 * (resources/node/node.exe on Windows) because the child scripts are plain
 * Node programs — some load native modules built for Node's ABI, which the
 * Electron binary cannot load. In dev (or when no bundled runtime exists),
 * falls back to `process.execPath`.
 */
export function getChildRuntime() {
  try {
    const res = process.resourcesPath; // defined inside Electron
    if (res) {
      const bundled =
        process.platform === 'win32'
          ? path.join(res, 'node', 'node.exe')
          : path.join(res, 'node', 'node');
      if (fs.existsSync(bundled)) return bundled;
    }
  } catch {
    /* fall through to default */
  }
  return process.execPath;
}

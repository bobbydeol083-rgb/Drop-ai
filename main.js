// Drop AI — Electron main process.
// Copyright by Dork Industry.
//
// One-click desktop launcher. Spawns the relay and the MCP server as
// supervised child processes, shows Connected/Disconnected status, and
// persists a Phase-3 API token. No shell-outs, no eval, no raw user input
// ever reaches a command line.

import { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, dialog, nativeImage, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// OTA: apply a staged update BEFORE anything else boots. This must run
// synchronously at startup — the app dir is swapped atomically.
try {
  const { applyStagedUpdate } = await import('./lib/ota-updater.js');
  // In packaged mode, app dir is <resources>/app — the portable root is one up.
  const portableRoot = process.resourcesPath ? path.dirname(process.resourcesPath) : null;
  if (app.isPackaged && portableRoot) {
    const applied = applyStagedUpdate(portableRoot);
    if (applied === 'helper') {
      // A helper script will swap the folders after we exit and relaunch
      // the new version itself — just quit quietly.
      console.log('[ota] swap helper launched, exiting for update');
      app.exit(0);
    } else if (applied) {
      console.log('[ota] staged update applied, restarting into new version');
      // The current process is still the OLD code — relaunch so the new
      // version actually boots. Without this the update never takes effect.
      app.relaunch();
      app.exit(0);
    }
  }
} catch { /* OTA is optional — never break boot */ }

// Crash protection: log fatal errors instead of dying silently. The app must
// never vanish without a trace — especially during heavy work like large
// PDF ingestion.
process.on('uncaughtException', (err) => {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] UNCAUGHT: ${err?.stack || err}\n`);
  } catch { /* logging must never throw */ }
  console.error('[fatal] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] UNHANDLED REJECTION: ${reason?.stack || reason}\n`);
  } catch { /* logging must never throw */ }
  console.error('[fatal] unhandledRejection:', reason);
});
import {
  DEFAULT_RELAY_PORT,
  HEARTBEAT_INTERVAL_MS,
  RELAY_PORT_ENV,
  createExecMessage,
  createPing,
  parseMessage,
} from '@drop-ai/common/protocol';
import { timecodeToTicks } from '@drop-ai/common/timecode';
import { detectPremiere } from './lib/premiere-detector.js';
import { syncPanelAssets, syncBackendCatalog, watchBrollRequests, watchPanelRequests, watchLibraryRequests, watchUserUploadRequests, watchBackendCatalog } from './panel-sync.js';
import { watchAssetFetchRequests } from '@drop-ai/storage';
import { TokenStore } from './lib/token-store.js';
import { RingBuffer } from './lib/ring-buffer.js';
import {
  validateAssetAddArgs,
  validateAssetPlaceArgs,
  validateKnowledgeSearch,
  validateKnowledgeUploadPaths,
} from './lib/validate.js';
import {
  REPO_ROOT,
  RELAY_ENTRY,
  MCP_ENTRY,
  HTTP_ENTRY,
  KNOWLEDGE_SEED_ROOT,
  getChildRuntime,
} from './lib/paths.js';
import {
  pluginListPayload,
  hostIds,
  resolvePluginDirs,
  legacyPremierePlugin,
  findPlugin,
} from './lib/plugins.js';
import { deriveAssetHosts } from './lib/library-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Child-process runtime: bundled plain-Node in packaged builds,
// process.execPath (Electron) in dev.
const CHILD_RUNTIME = getChildRuntime();

const APP_NAME = 'Drop AI';
const LOG_CAPACITY = 500;
const RELAY_HEALTH_TIMEOUT_MS = 10_000;
const RELAY_HEALTH_POLL_MS = 200;
const HTTP_HEALTH_TIMEOUT_MS = 8_000;
const HTTP_HEALTH_POLL_MS = 200;
const DEFAULT_HTTP_PORT = 3100;
const PING_TIMEOUT_MS = 4_000;
const MAX_CONSECUTIVE_CRASHES = 10;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
const BACKOFF_MAX_MS = 30_000;
const STABLE_WINDOW_MS = 60_000;

app.setName(APP_NAME);

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Logger: ring buffer + dated file
// ---------------------------------------------------------------------------

class Logger {
  constructor(userDataDir) {
    this.ring = new RingBuffer(LOG_CAPACITY);
    this.logDir = path.join(userDataDir, 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.listeners = new Set();
  }

  filePath(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return path.join(this.logDir, `drop-ai-${y}-${m}-${d}.log`);
  }

  append(source, text) {
    const stamp = new Date().toISOString();
    const lines = String(text).split('\n');
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.length === 0) continue;
      const entry = `${stamp} [${source}] ${trimmed}`;
      this.ring.push(entry);
      try {
        fs.appendFileSync(this.filePath(), `${entry}\n`);
      } catch {
        // Logging must never crash the launcher.
      }
      for (const cb of this.listeners) cb(entry);
    }
  }

  tail(n) {
    const count = Number.isInteger(n) && n > 0 ? Math.min(n, LOG_CAPACITY) : 200;
    return this.ring.tail(count);
  }

  clear() {
    this.ring.clear();
  }

  onLine(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

// ---------------------------------------------------------------------------
// ProcessManager: supervised relay + MCP server
// ---------------------------------------------------------------------------

function tcpConnectable(host, port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

class ProcessManager {
  constructor({ logger, onChange, tokenFilePath = null }) {
    this.logger = logger;
    this.onChange = onChange;
    /** stopped | starting | running | error */
    this.state = 'stopped';
    this.relay = null;
    this.mcp = null;
    this.consecutiveCrashes = 0;
    this.lastError = null;
    this.lastLogSnapshot = [];
    this.restartTimer = null;
    this.stableTimer = null;
    this.quitting = false;
    // HTTP remote transport (third supervised child, independent of relay+mcp)
    this.http = null;
    this.httpWanted = false;
    this.httpRestarts = 0;
    this.httpRestartTimer = null;
    this.tokenFilePath = tokenFilePath;
    this.relayPort = (() => {
      const raw = process.env[RELAY_PORT_ENV];
      const n = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_RELAY_PORT;
    })();
    this.httpPort = (() => {
      const raw = process.env.DORK_DROP_AI_HTTP_PORT;
      const n = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_HTTP_PORT;
    })();
  }

  isAlive(proc) {
    return proc !== null && proc.exitCode === null && !proc.killed;
  }

  mcpAlive() {
    return this.isAlive(this.mcp);
  }

  setState(next, error = null) {
    this.state = next;
    if (error) this.lastError = String(error);
    if (typeof this.onChange === 'function') this.onChange(this.snapshot());
  }

  snapshot() {
    return {
      manager: this.state,
      relayPort: this.relayPort,
      consecutiveCrashes: this.consecutiveCrashes,
      lastError: this.lastError,
      lastLogSnapshot: this.lastLogSnapshot,
      relayAlive: this.isAlive(this.relay),
      mcpAlive: this.isAlive(this.mcp),
      httpAlive: this.httpAlive(),
      httpWanted: this.httpWanted,
      httpPort: this.httpPort,
    };
  }

  spawnProcess(name, entry, extraEnv = {}) {
    const child = spawn(CHILD_RUNTIME, [entry], {
      cwd: path.dirname(entry),
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.on('error', (err) => {
      this.logger.append(name, `spawn failed: ${err.message}`);
    });
    child.stdout?.on('data', (chunk) => this.logger.append(name, chunk.toString('utf8')));
    child.stderr?.on('data', (chunk) => this.logger.append(name, chunk.toString('utf8')));
    return child;
  }

  async waitForRelayHealthy() {
    const deadline = Date.now() + RELAY_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.quitting) throw new Error('shutting down');
      if (await tcpConnectable('127.0.0.1', this.relayPort, RELAY_HEALTH_POLL_MS)) return;
      await new Promise((r) => setTimeout(r, RELAY_HEALTH_POLL_MS));
    }
    throw new Error(`relay did not open 127.0.0.1:${this.relayPort} within ${RELAY_HEALTH_TIMEOUT_MS / 1000}s`);
  }

  async start() {
    if (this.state === 'starting' || this.state === 'running') return this.snapshot();
    if (this.state === 'error') {
      // A fresh start attempt resets the crash ledger.
      this.consecutiveCrashes = 0;
    }
    this.clearTimers();
    this.setState('starting');
    this.logger.append('launcher', `starting relay (${RELAY_ENTRY})`);
    try {
      if (!fs.existsSync(RELAY_ENTRY)) throw new Error(`relay entry not found: ${RELAY_ENTRY}`);
      if (!fs.existsSync(MCP_ENTRY)) throw new Error(`mcp-server entry not found: ${MCP_ENTRY}`);

      this.relay = this.spawnProcess('relay', RELAY_ENTRY);
      this.relay.on('exit', (code, signal) => this.handleExit('relay', code, signal));
      await this.waitForRelayHealthy();

      this.logger.append('launcher', `relay healthy on 127.0.0.1:${this.relayPort}; starting mcp-server`);
      this.mcp = this.spawnProcess('mcp', MCP_ENTRY);
      this.mcp.on('exit', (code, signal) => this.handleExit('mcp', code, signal));

      this.consecutiveCrashes = 0;
      this.setState('running');
      this.stableTimer = setTimeout(() => {
        // A full minute of uptime forgives earlier crashes.
        if (this.state === 'running') this.consecutiveCrashes = 0;
      }, STABLE_WINDOW_MS);
      if (this.stableTimer.unref) this.stableTimer.unref();
    } catch (err) {
      this.logger.append('launcher', `start failed: ${err.message}`);
      this.killAll();
      this.setState('stopped', err.message);
    }
    return this.snapshot();
  }

  handleExit(name, code, signal) {
    if (this.quitting) return;
    if (this.state !== 'running' && this.state !== 'starting') return;
    this.consecutiveCrashes += 1;
    this.lastLogSnapshot = this.logger.tail(10);
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    this.logger.append('launcher', `${name} died (${why}) — crash ${this.consecutiveCrashes}/${MAX_CONSECUTIVE_CRASHES}`);
    this.killAll();

    if (this.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      this.setState('error', `${name} crashed ${MAX_CONSECUTIVE_CRASHES} times in a row (${why}). Last logs:\n${this.lastLogSnapshot.join('\n')}`);
      return;
    }
    const delay = Math.min(
      BACKOFF_MS[Math.min(this.consecutiveCrashes - 1, BACKOFF_MS.length - 1)],
      BACKOFF_MAX_MS,
    );
    this.logger.append('launcher', `restarting in ${delay}ms`);
    this.restartTimer = setTimeout(() => this.start(), delay);
    if (this.restartTimer.unref) this.restartTimer.unref();
    this.setState('starting');
  }

  backoffForAttempt(n) {
    return Math.min(BACKOFF_MS[Math.min(Math.max(n - 1, 0), BACKOFF_MS.length - 1)], BACKOFF_MAX_MS);
  }

  // -------------------------------------------------------------------------
  // HTTP remote transport: third supervised child, independent of relay+mcp.
  // -------------------------------------------------------------------------

  httpAlive() {
    return this.isAlive(this.http);
  }

  /** Public status for the renderer: { running, wanted, port, url } (no token). */
  httpStatus() {
    return {
      running: this.httpAlive(),
      wanted: this.httpWanted,
      port: this.httpPort,
      url: `http://127.0.0.1:${this.httpPort}/mcp`,
    };
  }

  clearHttpTimer() {
    if (this.httpRestartTimer) {
      clearTimeout(this.httpRestartTimer);
      this.httpRestartTimer = null;
    }
  }

  /** Start the bearer-gated Streamable HTTP server, sharing the launcher's token file. */
  async startHttp({ resetCrashes = true } = {}) {
    if (this.httpWanted && this.httpAlive()) return this.httpStatus();
    if (!fs.existsSync(HTTP_ENTRY)) throw new Error(`http-server entry not found: ${HTTP_ENTRY}`);
    this.clearHttpTimer();
    this.httpWanted = true;
    if (resetCrashes) this.httpRestarts = 0;
    const extraEnv = {};
    if (this.tokenFilePath) extraEnv.DORK_DROP_AI_TOKEN_FILE = this.tokenFilePath;
    this.logger.append('launcher', `starting HTTP remote server (${HTTP_ENTRY})`);
    this.http = this.spawnProcess('http', HTTP_ENTRY, extraEnv);
    let spawnFailed = null;
    this.http.on('error', (err) => {
      spawnFailed = err;
    });
    this.http.on('exit', (code, signal) => this.handleHttpExit(code, signal));
    try {
      const deadline = Date.now() + HTTP_HEALTH_TIMEOUT_MS;
      let healthy = false;
      while (Date.now() < deadline) {
        if (this.quitting || !this.httpWanted) throw new Error('shutting down');
        if (spawnFailed) throw spawnFailed;
        if (!this.httpAlive()) throw new Error('HTTP server exited before opening its port');
        if (await tcpConnectable('127.0.0.1', this.httpPort, HTTP_HEALTH_POLL_MS)) {
          healthy = true;
          break;
        }
        await new Promise((r) => setTimeout(r, HTTP_HEALTH_POLL_MS));
      }
      if (!healthy) {
        throw new Error(
          `HTTP server did not open 127.0.0.1:${this.httpPort} within ${HTTP_HEALTH_TIMEOUT_MS / 1000}s`,
        );
      }
      this.httpRestarts = 0;
      this.logger.append(
        'launcher',
        `HTTP remote server healthy at http://127.0.0.1:${this.httpPort}/mcp`,
      );
    } catch (err) {
      this.stopHttp();
      throw err;
    }
    if (typeof this.onChange === 'function') this.onChange(this.snapshot());
    return this.httpStatus();
  }

  /** Stop the HTTP server. Independent of relay+mcp. */
  stopHttp() {
    this.httpWanted = false;
    this.clearHttpTimer();
    if (this.isAlive(this.http)) {
      try {
        this.http.kill('SIGTERM');
      } catch (err) {
        this.logger.append('launcher', `failed to stop HTTP server: ${err.message}`);
      }
    }
    this.http = null;
    this.httpRestarts = 0;
    if (typeof this.onChange === 'function') this.onChange(this.snapshot());
    return this.httpStatus();
  }

  handleHttpExit(code, signal) {
    if (this.quitting) return;
    if (!this.httpWanted) return; // intentional stop; nothing to restart
    this.http = null;
    this.httpRestarts += 1;
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    this.logger.append(
      'launcher',
      `HTTP server died (${why}) — crash ${this.httpRestarts}/${MAX_CONSECUTIVE_CRASHES}`,
    );
    if (this.httpRestarts >= MAX_CONSECUTIVE_CRASHES) {
      this.httpWanted = false;
      this.logger.append(
        'launcher',
        'HTTP server crashed repeatedly; giving up. Start it again from the API token card.',
      );
      if (typeof this.onChange === 'function') this.onChange(this.snapshot());
      return;
    }
    const delay = this.backoffForAttempt(this.httpRestarts);
    this.logger.append('launcher', `restarting HTTP server in ${delay}ms`);
    this.clearHttpTimer();
    this.httpRestartTimer = setTimeout(() => {
      this.httpRestartTimer = null;
      if (this.httpWanted && !this.quitting) {
        this.startHttp({ resetCrashes: false }).catch((err) =>
          this.logger.append('launcher', `HTTP server restart failed: ${err.message}`),
        );
      }
    }, delay);
    if (this.httpRestartTimer.unref) this.httpRestartTimer.unref();
    if (typeof this.onChange === 'function') this.onChange(this.snapshot());
  }

  retry() {
    this.consecutiveCrashes = 0;
    return this.start();
  }

  killAll() {
    for (const [name, proc] of [['relay', this.relay], ['mcp', this.mcp]]) {
      if (this.isAlive(proc)) {
        try {
          proc.kill('SIGTERM');
        } catch (err) {
          this.logger.append('launcher', `failed to stop ${name}: ${err.message}`);
        }
      }
    }
    this.relay = null;
    this.mcp = null;
  }

  async stop() {
    this.clearTimers();
    this.quitting = false;
    this.killAll();
    this.stopHttp();
    this.consecutiveCrashes = 0;
    this.lastError = null;
    this.setState('stopped');
    this.logger.append('launcher', 'stopped');
    return this.snapshot();
  }

  clearTimers() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.clearHttpTimer();
  }

  shutdown() {
    this.quitting = true;
    this.clearTimers();
    this.killAll();
    if (this.isAlive(this.http)) {
      try {
        this.http.kill('SIGTERM');
      } catch {
        // Shutting down; nothing left to report to.
      }
    }
    this.http = null;
    this.httpWanted = false;
  }
}

// ---------------------------------------------------------------------------
// Plugins (@drop-ai/plugin-host)
// ---------------------------------------------------------------------------
//
// Loaded once at startup (and reloaded after install/uninstall): an array of
// { manifest, dir, builtin }. The Premiere plugin is always present —
// guaranteed by the legacy fallback when plugin-host or the plugins/ tree
// is unavailable — so the launcher's Premiere section never disappears.

let plugins = [];
let userPluginDir = null;

async function importPluginHost() {
  const host = await import('@drop-ai/plugin-host');
  if (!host || typeof host.discoverPlugins !== 'function') {
    throw new Error('@drop-ai/plugin-host is not usable in this build');
  }
  return host;
}

async function loadPlugins() {
  const getDataDir = await loadDataDirFn();
  const dataDir = getDataDir();
  const fallbackOpts = {
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    dataDir,
    repoRoot: REPO_ROOT,
  };
  let host = null;
  try {
    host = await importPluginHost();
  } catch {
    host = null;
  }
  if (host) {
    let dirs;
    try {
      dirs = host.getPluginDirs(fallbackOpts);
    } catch {
      dirs = resolvePluginDirs(fallbackOpts);
    }
    userPluginDir = dirs.userDir;
    try {
      plugins = (await host.discoverPlugins({ builtinDir: dirs.builtinDir, userDir: dirs.userDir })) || [];
      logger?.append('launcher', `loaded ${plugins.length} plugin(s) from ${dirs.builtinDir}${dirs.userDir ? ` + ${dirs.userDir}` : ''}`);
    } catch (err) {
      logger?.append('launcher', `plugin discovery failed: ${err?.message ?? err}`);
      plugins = [];
    }
  } else {
    userPluginDir = resolvePluginDirs(fallbackOpts).userDir;
    plugins = [];
    logger?.append('launcher', '@drop-ai/plugin-host not available — running with the built-in Premiere plugin only');
  }
  if (!plugins.some((p) => p?.manifest?.id === 'premiere')) {
    plugins.unshift(legacyPremierePlugin(fallbackOpts));
  }
  if (heartbeat) heartbeat.setHosts(hostIds(plugins));
}

// ---------------------------------------------------------------------------
// Heartbeat: relay TCP + ws ping/pong → per-host panel status
// ---------------------------------------------------------------------------

/**
 * Ping one host app through the relay. Sends the hostId-aware ping
 * (createPing already passes hostId through; old relays ignore it) and
 * reads the per-host entry from the pong's additive `hosts` map, falling
 * back to the legacy top-level fields for 'premiere' against old relays.
 * Resolves to { connected, busy, version, state } or null on failure.
 */
function pingHost(port, hostId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), PING_TIMEOUT_MS);
    ws.on('open', () => {
      ws.send(JSON.stringify(createPing(`hb-${crypto.randomUUID()}`, { hostId })));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg && msg.type === 'pong') {
          clearTimeout(timer);
          const perHost =
            msg.hosts && typeof msg.hosts === 'object' && msg.hosts[hostId]
              ? msg.hosts[hostId]
              : null;
          if (perHost) {
            finish({
              connected: Boolean(perHost.connected),
              busy: Boolean(perHost.busy),
              version: perHost.version === null || perHost.version === undefined ? null : String(perHost.version),
              state: typeof perHost.state === 'string' ? perHost.state : null,
            });
          } else if (hostId === 'premiere') {
            // Legacy relay: no hosts map, top-level premiere fields only.
            finish({
              connected: Boolean(msg.premiere),
              busy: Boolean(msg.busy),
              version: msg.version === null || msg.version === undefined ? null : String(msg.version),
              state: typeof msg.state === 'string' ? msg.state : null,
            });
          } else {
            finish({ connected: false, busy: false, version: null, state: null });
          }
        }
      } catch {
        // Not our pong; keep waiting.
      }
    });
    ws.on('error', () => finish(null));
    ws.on('close', () => finish(null));
  });
}

// ---------------------------------------------------------------------------
// Panel chat bridge: CEP panels hold no backend token, so the launcher keeps
// a persistent relay client, registers with launcher-hello, and answers
// panel-chat requests by calling /api/chat with the signed-in user's token.
// ---------------------------------------------------------------------------
class RelayChatBridge {
  constructor({ port, logger, libraryBase, readUserToken }) {
    this.port = port;
    this.logger = logger;
    this.libraryBase = libraryBase;
    this.readUserToken = readUserToken;
    this.ws = null;
    this.retryTimer = null;
    this.stopped = false;
    this.retryMs = 2000;
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      this.ws?.close();
    } catch { /* ignore */ }
    this.ws = null;
  }
  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.on('open', () => {
      this.retryMs = 2000;
      try {
        ws.send(JSON.stringify({ type: 'launcher-hello', id: crypto.randomUUID() }));
      } catch { /* ignore */ }
    });
    ws.on('message', (data) => {
      this.onMessage(data).catch((err) => this.logger?.append('launcher', `panel chat failed: ${err.message}`));
    });
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.scheduleRetry();
      }
    });
    ws.on('error', () => {
      try {
        ws.close();
      } catch { /* ignore */ }
    });
  }
  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }
  async onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || msg.type !== 'panel-chat' || typeof msg.id !== 'string') return;
    const reply = { type: 'panel-chat-reply', id: msg.id };
    try {
      const token = this.readUserToken();
      if (!token) {
        reply.error = 'chat unavailable: sign in to Drop AI first';
      } else {
        const { sendChat } = await import('./lib/library-client.js');
        const history = Array.isArray(msg.history) ? msg.history.slice(-10) : [];
        const res = await sendChat(this.libraryBase(), token, String(msg.message || '').slice(0, 2000), history);
        if (res && res.error) {
          reply.error = res.error;
        } else {
          reply.reply = (res && res.reply) || '';
        }
      }
    } catch (err) {
      const m = err?.message || String(err);
      reply.error = /\b402\b/.test(m) ? 'chatbox_requires_pro' : `chat failed: ${m}`;
    }
    try {
      this.ws?.send(JSON.stringify(reply));
    } catch { /* ignore */ }
  }
}

class Heartbeat {
  constructor({ pm, onStatus }) {
    this.pm = pm;
    this.onStatus = onStatus;
    this.timer = null;
    this.hostList = ['premiere'];
    /** hostId -> { connected, busy, version, state } */
    this.hosts = {};
    this.relayOk = false;
  }

  /** Track this set of host apps (derived from the loaded plugins). */
  setHosts(list) {
    this.hostList = Array.isArray(list) && list.length > 0 ? [...list] : ['premiere'];
  }

  start() {
    this.stop();
    this.timer = setInterval(() => void this.tick(), HEARTBEAT_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    this.relayOk = await tcpConnectable('127.0.0.1', this.pm.relayPort, 1_500);
    if (this.relayOk) {
      const results = await Promise.all(this.hostList.map((hostId) => pingHost(this.pm.relayPort, hostId)));
      const next = {};
      for (let i = 0; i < this.hostList.length; i++) {
        next[this.hostList[i]] =
          results[i] ?? { connected: false, busy: false, version: null, state: null };
      }
      this.hosts = next;
    } else {
      this.hosts = {};
    }
    if (typeof this.onStatus === 'function') this.onStatus(this.statusSnapshot());
  }

  hostEntry(hostId, running) {
    const info = this.hosts[hostId] || { connected: false, busy: false, version: null, state: null };
    return {
      state: info.connected ? 'ok' : running ? 'starting' : 'stopped',
      detail: info.connected
        ? `connected${info.version ? ` · ${info.version}` : ''}${info.busy ? ' · busy' : ''}`
        : running
          ? 'waiting for the CEP panel…'
          : 'not running',
      version: info.version,
      busy: info.busy,
      panelState: info.state ?? null,
      connected: info.connected,
    };
  }

  statusSnapshot() {
    const pmState = this.pm.state;
    const running = pmState === 'running' || pmState === 'starting';
    const hosts = {};
    for (const hostId of this.hostList) hosts[hostId] = this.hostEntry(hostId, running);
    return {
      running,
      relay: {
        state: pmState === 'error' ? 'error' : this.relayOk ? 'ok' : running ? 'starting' : 'stopped',
        detail: this.relayOk
          ? `listening on 127.0.0.1:${this.pm.relayPort}`
          : running
            ? 'connecting…'
            : 'not running',
      },
      // Legacy key: the static Premiere UI in the renderer reads this.
      premiere: this.hostEntry('premiere', running),
      // Per-plugin host entries; the renderer draws one status section per plugin.
      hosts,
      mcp: {
        state: pmState === 'error' ? 'error' : this.pm.mcpAlive() ? 'ok' : running ? 'starting' : 'stopped',
        detail: this.pm.mcpAlive()
          ? 'child process alive'
          : pmState === 'error'
            ? (this.pm.lastError ?? 'crashed')
            : running
              ? 'spawning…'
              : 'not running',
      },
      premiereInstall: detectPremiere(),
      manager: this.pm.snapshot(),
    };
  }
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let logger = null;
let pm = null;
let chatBridge = null;
let heartbeat = null;
let tokenStore = null;
let isQuitting = false;

function getMainWindow() {
  return mainWindow;
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Window may be closing; ignore.
    }
  }
}

function currentStatus() {
  return heartbeat ? heartbeat.statusSnapshot() : null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.setMenu(buildAppMenu());
}

function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Help',
      submenu: [
        {
          label: 'Contact Support',
          click: () => {
            shell.openExternal('mailto:dorktech007@gmail.com?subject=Drop%20AI%20Support');
          },
        },
      ],
    },
  ]);
}

function buildTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    // Degenerate fallback: never leave the tray icon-less.
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Drop AI',
        click: () => {
          const win = getMainWindow();
          if (win) {
            win.show();
            win.focus();
          } else {
            createWindow();
          }
        },
      },
      {
        label: 'Hide',
        click: () => getMainWindow()?.hide(),
      },
      { type: 'separator' },
      {
        label: 'Start',
        click: () => void pm?.start(),
      },
      {
        label: 'Stop',
        click: () => void pm?.stop(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Knowledge + Assets: lazy singletons over @drop-ai/knowledge / @drop-ai/assets
// ---------------------------------------------------------------------------
//
// Both stores are expensive to build (the knowledge embedder loads a local
// transformers model on first use), so they are created on first demand —
// never at launcher boot. Dynamic imports keep a half-built sibling package
// from crashing the whole launcher: failures surface as { error } results on
// the calling IPC endpoint instead.

const RELAY_EXEC_TIMEOUT_MS = 30_000;
// KNOWLEDGE_SEED_ROOT comes from ./lib/paths.js (imported above).

let knowledgeStorePromise = null;
let assetStorePromise = null;
let seedSyncStarted = false;

/**
 * Resolve getDropAiDataDir from @drop-ai/common. The export is provided by
 * the common package; if it is missing we fail loudly so the launcher keeps
 * running and the endpoint reports the real cause.
 */
async function loadDataDirFn() {
  const common = await import('@drop-ai/common');
  if (typeof common.getDropAiDataDir !== 'function') {
    throw new Error(
      '@drop-ai/common does not export getDropAiDataDir yet — knowledge/asset storage is unavailable until the common package provides it',
    );
  }
  return common.getDropAiDataDir;
}

async function getKnowledgeStore() {
  if (!knowledgeStorePromise) {
    knowledgeStorePromise = (async () => {
      const getDropAiDataDir = await loadDataDirFn();
      const { createKnowledgeStore, createTransformersEmbedder } = await import('@drop-ai/knowledge');
      const store = createKnowledgeStore({
        dataDir: getDropAiDataDir(),
        embedder: createTransformersEmbedder(),
      });
      await store.ready();
      if (!seedSyncStarted) {
        seedSyncStarted = true;
        // Seed sync runs in the background and never blocks the caller.
        void syncSeedKnowledge(store);
      }
      // Background ingestion progress → broadcast to renderer for the progress UI
      if (!ingestProgressWired) {
        ingestProgressWired = true;
        store.onIngestProgress((evt) => {
          broadcast('knowledge:ingest-progress', evt);
          logger.append('knowledge', `ingest ${evt.source}: ${evt.phase} ${evt.done}/${evt.total} (${evt.status})`);
        });
        // Self-healing: every 30s, retry any entries stuck in 'pending'.
        // If the initial kick failed silently, this picks them up.
        setInterval(async () => {
          try {
            const state = store.getWorkerState?.() || {};
            const sources = await store.listSources().catch(() => []);
            const pendingCount = sources.filter((s) => s.status === 'pending').length;
            logger.append('knowledge', `worker tick: ingestRunning=${state.ingestRunning}, pending=${pendingCount}`);
            const result = await store.processPendingUploads?.();
            if (result?.processed > 0 || result?.skipped) {
              logger.append('knowledge', `worker tick result: ${JSON.stringify(result)}`);
            }
          } catch (err) {
            logger.append('knowledge', `background retry failed: ${err?.message ?? err}`);
          }
        }, 30000).unref?.();
      }
      // Watch folder: auto-ingest .md/.pdf files dropped into ~/Knowledge.
      // Debounced to avoid ingesting half-written files.
      if (!watchFolderStarted) {
        watchFolderStarted = true;
        void startKnowledgeWatchFolder(store);
      }
      return store;
    })();
    // A failed init must not poison later calls: allow a retry next time.
    knowledgeStorePromise.catch(() => {
      knowledgeStorePromise = null;
    });
  }
  return knowledgeStorePromise;
}

let watchFolderStarted = false;
let ingestProgressWired = false;

/** Watch ~/Knowledge for .md/.pdf files and auto-ingest them. */
async function startKnowledgeWatchFolder(store) {
  const dir = path.join(app.getPath('userData'), 'Knowledge');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    logger.append('knowledge', `watch folder mkdir failed: ${err?.message ?? err}`);
    return;
  }
  const pending = new Map(); // filename -> timeout
  const seen = new Set(); // filenames already ingested this session
  const ingestFile = async (filename) => {
    const ext = path.extname(filename).toLowerCase();
    if (!['.md', '.markdown', '.pdf', '.txt'].includes(ext)) return;
    const fullPath = path.join(dir, filename);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) return;
      const title = path.basename(filename, ext);
      const source = `watch:${filename}`;
      // Skip if already ingested and unchanged (compare recorded file mtime+size,
      // NOT the registry updatedAt which is just the last write time)
      const sources = await store.listSources().catch(() => []);
      const existing = sources.find((s) => s?.source === source);
      if (existing && existing.fileMtimeMs != null) {
        if (existing.fileMtimeMs === stat.mtimeMs && existing.fileSize === stat.size) {
          seen.add(filename);
          return;
        }
      }
      // Skip if we already ingested this exact file this session
      const fingerprint = `${filename}:${stat.mtimeMs}:${stat.size}`;
      if (seen.has(fingerprint)) return;
      logger.append('knowledge', `watch folder: queueing ${filename} for background ingestion`);
      const result = await store.queueUpload(fullPath, { title, sourceId: source, fileMtimeMs: stat.mtimeMs, fileSize: stat.size, skipCopy: true });
      seen.add(fingerprint);
      logger.append('knowledge', `watch folder: queued ${filename} (${result.source})`);
      broadcast('knowledge:watch-update', { filename, source: result.source, status: 'queued' });
    } catch (err) {
      logger.append('knowledge', `watch folder ingest failed for ${filename}: ${err?.message ?? err}`);
    }
  };
  const scanFolder = async () => {
    try {
      const files = await fs.promises.readdir(dir);
      for (const f of files) await ingestFile(f);
    } catch (err) {
      logger.append('knowledge', `watch folder scan failed: ${err?.message ?? err}`);
    }
  };
  try {
    const watcher = fs.watch(dir, (eventType, filename) => {
      if (!filename || typeof filename !== 'string') return;
      if (pending.has(filename)) clearTimeout(pending.get(filename));
      // Debounce 1.5s to let file writes finish
      pending.set(filename, setTimeout(() => {
        pending.delete(filename);
        void ingestFile(filename);
      }, 1500));
    });
    watcher.on('error', (err) => {
      logger.append('knowledge', `watch folder error: ${err?.message ?? err}`);
    });
    logger.append('knowledge', `watching ${dir} for knowledge files`);
    // Initial scan on startup
    await scanFolder();
    // Polling fallback: fs.watch can miss events on some systems.
    // Scan every 15 seconds to catch anything the watcher missed.
    setInterval(() => { void scanFolder(); }, 15000).unref?.();
  } catch (err) {
    logger.append('knowledge', `watch folder failed: ${err?.message ?? err}`);
  }
  // Expose manual scan for the UI button
  globalThis.__dropaiScanWatchFolder = scanFolder;
}

async function getAssetStore() {
  if (!assetStorePromise) {
    assetStorePromise = (async () => {
      const getDropAiDataDir = await loadDataDirFn();
      const { createAssetStore } = await import('@drop-ai/assets');
      const store = createAssetStore({ dataDir: getDropAiDataDir() });
      await store.ready();
      // One-time cleanup (2026-10-19): remove library preset assets that were
      // wrongly registered in the asset store before the fix. The Assets tab
      // is only for user reference uploads, not library downloads.
      try {
        const all = store.list ? store.list() : [];
        let removed = 0;
        for (const a of all) {
          const tags = a.tags || [];
          if (tags.includes('preset') || tags.some(t => String(t).startsWith('preset:'))) {
            try { store.remove(a.id); removed++; } catch {}
          }
        }
        if (removed > 0) logger.append('launcher', `cleaned ${removed} library preset assets from asset store`);
      } catch {}
      return store;
    })();
    assetStorePromise.catch(() => {
      assetStorePromise = null;
    });
  }
  return assetStorePromise;
}

/** Re-sync the CEP panel's asset list after any asset mutation. Best-effort. */
async function refreshPanelAssets() {
  try {
    const getDropAiDataDir = await loadDataDirFn();
    const store = await getAssetStore();
    await syncPanelAssets(getDropAiDataDir(), store, logger, plugins, {
      catalogAssets: lastCatalogAssets,
    });
  } catch { /* panel sync is best-effort */ }
}

let storageManagerPromise = null;

/**
 * Storage-backend manager singleton (local disk by default; Google Drive
 * when configured — see docs/STORAGE.md). Never throws: resolves to null
 * when unavailable so the launcher keeps working local-only.
 */
async function getStorageManager() {
  if (!storageManagerPromise) {
    storageManagerPromise = (async () => {
      const getDropAiDataDir = await loadDataDirFn();
      const { loadStorageConfig, createStorageManager } = await import('@drop-ai/storage');
      const config = loadStorageConfig({ dataDir: getDropAiDataDir() });
      const manager = createStorageManager({ config, dataDir: getDropAiDataDir() });
      // Log the backend name only — never credential values.
      logger.append('storage', `storage backend: ${config.backend} (config: ${config.source})`);
      if (config.backend === 'gdrive') {
        const avail = manager.getBackend('gdrive').isAvailable();
        logger.append(
          'storage',
          avail
            ? 'Google Drive credentials present — remote assets download on demand'
            : 'Google Drive selected but credentials are missing — see docs/STORAGE.md'
        );
      }
      return manager;
    })().catch((err) => {
      logger.append('storage', `storage unavailable (${err?.message ?? err}); local-only mode`);
      return null;
    });
  }
  return storageManagerPromise;
}

/**
 * Latest backend catalog entries written into panel-library.json. Updated by
 * syncCatalogToPanel(); refreshPanelAssets() reuses it so local asset
 * mutations never drop the catalog cards.
 */
let lastCatalogAssets = [];

/**
 * Poll the backend catalog and merge new uploads into the CEP panel's asset
 * list. Best-effort: an unreachable backend only logs.
 */
async function syncCatalogToPanel(reason, onBlocked) {
  try {
    const getDropAiDataDir = await loadDataDirFn();
    const dataDir = getDropAiDataDir();
    const store = await getAssetStore();
    const { DEFAULT_BASE, isIpBlockedError } = await import('./lib/library-client.js');
    const base = process.env.DROP_AI_LIBRARY_URL || DEFAULT_BASE;
    const res = await syncBackendCatalog(dataDir, logger, plugins, { libraryBase: base });
    if (res.changed || reason === 'force') {
      lastCatalogAssets = res.catalogAssets;
      await syncPanelAssets(dataDir, store, logger, plugins, { catalogAssets: lastCatalogAssets });
    } else if (res.catalogAssets.length > 0) {
      // Catalog version unchanged: still re-merge the cached cards into
      // panel-library.json so the CEP panel never sits at 0 presets.
      lastCatalogAssets = res.catalogAssets;
      await syncPanelAssets(dataDir, store, logger, plugins, { catalogAssets: lastCatalogAssets });
    }
  } catch (err) {
    if (onBlocked) {
      try {
        const { isIpBlockedError: isBlocked } = await import('./lib/library-client.js');
        if (isBlocked(err)) { onBlocked(err); return; }
      } catch { /* fall through to log */ }
    }
    logger.append('panel-sync', `catalog sync failed: ${err?.message ?? err}`);
  }
}

/**
 * Stable per-install device id for backend phone-home (Devices tab).
 * Persisted in userData so reinstalls keep the same id unless wiped.
 */
// Hardware-bound device identity: sha256 of the machine's sorted MAC
// addresses. Survives app-data wipes, so a backend block on this device
// cannot be dodged by deleting a file. Falls back to a stored random UUID
// when no MAC is readable (rare VMs), and to an ephemeral id last.
function getDeviceMac() {
  try {
    const ifs = os.networkInterfaces();
    const macs = [];
    for (const list of Object.values(ifs)) {
      for (const ni of list || []) {
        const m = String(ni.mac || '').toLowerCase();
        if (m && m !== '00:00:00:00:00:00' && !ni.internal) macs.push(m);
      }
    }
    const uniq = [...new Set(macs)].sort();
    if (!uniq.length) return '';
    return crypto.createHash('sha256').update(uniq.join('|'), 'utf8').digest('hex');
  } catch { return ''; }
}
function getDeviceId() {
  try {
    const p = path.join(app.getPath('userData'), 'device-id');
    try {
      const existing = fs.readFileSync(p, 'utf8').trim();
      if (/^[0-9a-f-]{8,64}$/i.test(existing)) return existing;
    } catch { /* generate */ }
    const id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, id, 'utf8');
    return id;
  } catch {
    return `ephemeral-${Date.now()}`;
  }
}

async function syncSeedKnowledge(store) {
  // User can disable the preset seed knowledge entirely (Knowledge tab toggle).
  try {
    const settingsPath = path.join(app.getPath('userData'), 'knowledge-settings.json');
    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8').catch(() => '{}'));
    if (settings.seedDisabled) {
      logger.append('knowledge', 'seed sync skipped (disabled by user)');
      return;
    }
  } catch { /* fall through to sync */ }
  try {
    logger.append('knowledge', `syncing seed knowledge from ${KNOWLEDGE_SEED_ROOT} (background)`);
    const result = await store.syncSeedKnowledge(KNOWLEDGE_SEED_ROOT);
    logger.append(
      'knowledge',
      `seed sync complete: ${result?.files ?? '?'} files, ${result?.chunks ?? '?'} chunks`,
    );
  } catch (err) {
    logger.append('knowledge', `seed sync failed: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Relay exec: one-shot ws client for launcher-originated ExtendScript calls
// ---------------------------------------------------------------------------
//
// The relay routes `exec` from ANY connected client to the live CEP panel and
// answers back to the origin by id, so the launcher can drive Premiere
// without the MCP server. Reuses the @drop-ai/common wire-protocol helpers.

function relayExecJsx(jsx, { timeoutMs = RELAY_EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!pm) {
      reject(new Error('process manager is not initialized'));
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${pm.relayPort}`);
    let settled = false;
    const id = `launcher-${crypto.randomUUID()}`;
    const timer = setTimeout(
      () => finish(new Error(`relay exec timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (timer.unref) timer.unref();
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore: we are done with this socket either way
      }
      if (err) reject(err);
      else resolve(value);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify(createExecMessage(id, jsx, { timeoutMs })));
    });
    ws.on('message', (data) => {
      const parsed = parseMessage(String(data));
      if (!parsed.ok) return;
      const msg = parsed.message;
      // Ignore relay heartbeats and anything not addressed to this call.
      if (msg.id !== id || msg.type !== 'execResult') return;
      if (msg.status === 'ok') finish(null, msg.result);
      else finish(new Error(msg.error || 'ExtendScript execution reported an error'));
    });
    ws.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', () => finish(new Error('relay connection closed before exec completed')));
  });
}

/** Execute JSX via the relay and parse the panel's JSON-stringified payload. */
async function execJson(jsx, opts) {
  const raw = await relayExecJsx(jsx, opts);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`exec returned a non-JSON payload: ${err.message}`);
  }
}

function listMarkdownFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function assetDialogFilters(type) {
  switch (type) {
    case 'mogrt':
      return [{ name: 'Motion Graphics templates', extensions: ['mogrt'] }];
    case 'lut':
      return [{ name: 'LUT files', extensions: ['cube'] }];
    case 'broll':
      return [{ name: 'Video files', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv'] }];
    default:
      return [{ name: 'All files', extensions: ['*'] }];
  }
}

// ---------------------------------------------------------------------------
// IPC (preload bridge only — inputs validated, no shell anywhere)
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('dropai:start', () => pm.start().then(() => currentStatus()));
  ipcMain.handle('dropai:stop', () => pm.stop().then(() => currentStatus()));
  ipcMain.handle('dropai:retry', () => pm.retry().then(() => currentStatus()));
  ipcMain.handle('dropai:getStatus', () => currentStatus());
  ipcMain.handle('dropai:getLogs', (_event, n) => {
    const count = Number.isInteger(n) && n > 0 && n <= LOG_CAPACITY ? n : 200;
    return logger.tail(count);
  });
  ipcMain.handle('dropai:clearLogs', () => {
    logger.clear();
    return true;
  });

  ipcMain.handle('dropai:tokenMasked', () => tokenStore.getMasked());
  ipcMain.handle('dropai:tokenCopy', () => {
    clipboard.writeText(tokenStore.getOrCreate());
    return true;
  });
  ipcMain.handle('dropai:tokenReveal', () => ({ token: tokenStore.getOrCreate() }));
  ipcMain.handle('dropai:tokenRotate', () => {
    tokenStore.rotate();
    logger.append('launcher', 'API token rotated');
    return tokenStore.getMasked();
  });

  // ---- HTTP remote transport (Streamable HTTP, bearer-gated) ----
  //
  // Started/stopped independently of relay+mcp from the API token card.
  // The child shares the launcher's real token via DORK_DROP_AI_TOKEN_FILE.

  ipcMain.handle('dropai:httpStart', async () => {
    try {
      const status = await pm.startHttp();
      logger.append('launcher', `HTTP remote server started: ${status.url}`);
      return status;
    } catch (err) {
      logger.append('launcher', `HTTP remote server failed to start: ${err?.message ?? err}`);
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:httpStop', () => pm.stopHttp());
  ipcMain.handle('dropai:httpStatus', () => pm.httpStatus());

  // ---- Connect center ----
  //
  // Pre-built MCP client configs with the real installed paths, so desktop AI
  // clients (Claude Desktop, Antigravity, ChatGPT-via-remote) connect with no
  // manual path editing.
  // ---- Phase D: one-click MCP connect ----
  //
  // Auto-detects installed AI clients and one-click writes the Drop AI MCP
  // config into the client's own config file. No copy/paste.
  ipcMain.handle('dropai:connectDetect', async () => {
    try {
      const mod = await import('./lib/mcp-connect.js');
      const clients = mod.detectClients();
      return clients.map((c) => ({ ...c, configured: mod.isConfigured(c.id) }));
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:connectAuto', async (_event, rawClientId) => {
    try {
      const clientId = String(rawClientId || '').trim();
      const mod = await import('./lib/mcp-connect.js');
      const nodePath = app.isPackaged
        ? path.join(process.resourcesPath, 'node', 'node.exe')
        : process.execPath;
      const serverEntry = app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'node_modules', '@drop-ai', 'mcp-server', 'index.js')
        : path.join(__dirname, '..', 'mcp-server', 'index.js');
      const result = mod.autoConfigure(clientId, { command: nodePath, args: [serverEntry] });
      logger.append('connect', `auto-configured ${clientId} -> ${result.path}`);
      return result;
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  // ---- Phase D: one-click tunnel ----
  // ChatGPT connects from OpenAI's servers — expose the local MCP transport
  // over a public HTTPS URL with one click.
  ipcMain.handle('dropai:tunnelStart', async (event) => {
    try {
      const mod = await import('./lib/tunnel.js');
      const url = await mod.startTunnel({
        userDataDir: app.getPath('userData'),
        localUrl: 'http://127.0.0.1:3100',
        onProgress: (msg) => { try { event.sender.send('dropai:tunnelProgress', msg); } catch { /* gone */ } },
        onLog: (line) => { try { event.sender.send('dropai:tunnelLog', line); } catch { /* gone */ } },
      });
      logger.append('tunnel', `tunnel running: ${url}`);
      return { url };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:tunnelStop', async () => {
    try {
      const mod = await import('./lib/tunnel.js');
      mod.stopTunnel();
      return { stopped: true };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:tunnelState', async () => {
    try {
      const mod = await import('./lib/tunnel.js');
      return mod.getTunnelState();
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  // ---- Robust OTA ----
  ipcMain.handle('dropai:otaCheck', async () => {
    try {
      const mod = await import('./lib/ota-updater.js');
      const current = app.getVersion();
      return await mod.checkForUpdates(current);
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:otaExisting', async (_event, manifest) => {
    try {
      const file = String(manifest.file || 'update.zip').replace(/[^0-9a-zA-Z.\-]/g, '');
      const p = path.join(app.getPath('userData'), 'updates', file);
      const st = fs.statSync(p);
      const total = parseInt(manifest.size || '0', 10);
      if (st.size > 0 && (!total || st.size >= total)) return { path: p };
      return { path: null };
    } catch {
      return { path: null };
    }
  });
  ipcMain.handle('dropai:otaDownload', async (event, manifest) => {
    try {
      const mod = await import('./lib/ota-updater.js');
      const destDir = path.join(app.getPath('userData'), 'updates');
      const zipPath = await mod.downloadUpdate(manifest, destDir, (received, total) => {
        event.sender.send('dropai:otaProgress', { received, total });
      }, (msg) => logger.append('ota', msg));
      return { path: zipPath };
    } catch (err) {
      logger.append('ota', `download failed: ${err?.message ?? String(err)}`);
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:otaVerify', async (_event, zipPath, sha256) => {
    try {
      const mod = await import('./lib/ota-updater.js');
      const ok = await mod.verifySha256(zipPath, sha256);
      logger.append('ota', `verify ${ok ? 'passed' : 'FAILED (hash mismatch)'}: ${zipPath}`);
      return { ok };
    } catch (err) {
      logger.append('ota', `verify error: ${err?.message ?? String(err)}`);
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:otaStage', async (_event, zipPath) => {
    try {
      const mod = await import('./lib/ota-updater.js');
      const portableRoot = path.dirname(process.resourcesPath);
      await mod.stageUpdate(zipPath, portableRoot, (msg) => logger.append('ota', msg));
      logger.append('ota', 'staging complete — restart to apply');
      return { staged: true };
    } catch (err) {
      logger.append('ota', `staging failed: ${err?.message ?? String(err)}`);
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:otaRestart', async () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('dropai:otaPatchDownload', async (event, manifest) => {
    try {
      const mod = await import('./lib/ota-updater.js');
      const destDir = path.join(app.getPath('userData'), 'updates');
      const patchPath = await mod.downloadPatch(manifest, destDir, (received, total) => {
        event.sender.send('dropai:otaProgress', { received, total });
      }, (msg) => logger.append('ota', msg));
      return { path: patchPath };
    } catch (err) {
      logger.append('ota', `patch download failed: ${err?.message ?? String(err)}`);
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:otaPatchApply', async (_event, patchPath) => {
    try {
      const mod = await import('./lib/ota-updater.js');
      const portableRoot = path.dirname(process.resourcesPath);
      await mod.applyPatch(patchPath, portableRoot, (msg) => logger.append('ota', msg));
      logger.append('ota', 'patch applied — restart to apply');
      return { staged: true };
    } catch (err) {
      logger.append('ota', `patch apply failed: ${err?.message ?? String(err)}`);
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:otaUpdateError', async (_event, msg) => {
    try {
      const { dialog } = await import('electron');
      dialog.showErrorBox('Update failed', String(msg || 'Unknown error') + '\n\nPlease send a screenshot of this message to support.');
    } catch { /* headless */ }
    return { shown: true };
  });
  // Repair a broken tunnel binary (e.g. BAD_DECRYPT) — deletes the cached
  // cloudflared so the next start re-downloads it fresh.
  ipcMain.handle('dropai:tunnelRepair', async () => {
    try {
      const mod = await import('./lib/tunnel.js');
      mod.repairTunnel(app.getPath('userData'));
      return { repaired: true };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('dropai:connectConfigs', () => {
    // (legacy — manual copy/download fallback)
    const nodePath = app.isPackaged
      ? path.join(process.resourcesPath, 'node', 'node.exe')
      : process.execPath;
    const serverEntry = app.isPackaged
      ? path.join(process.resourcesPath, 'app', 'node_modules', '@drop-ai', 'mcp-server', 'index.js')
      : path.join(__dirname, '..', 'mcp-server', 'index.js');
    return {
      stdio: { command: nodePath, args: [serverEntry] },
      remoteUrl: 'http://127.0.0.1:3100/mcp',
    };
  });
  ipcMain.handle('dropai:connectCopy', (_event, rawText) => {
    const text = String(rawText || '').slice(0, 20000);
    if (!text) return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('dropai:saveConnectConfig', async (_event, rawName, rawContent) => {
    const name = String(rawName || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'mcp-config.json';
    const content = String(rawContent || '').slice(0, 20000);
    const picked = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Save MCP client config',
      defaultPath: name,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    await fs.promises.writeFile(picked.filePath, content, 'utf8');
    return { saved: picked.filePath };
  });

  // ---- CEP panel one-click install ----
  //
  // Copies the bundled plugin CEP panel (plugins/premiere/cep by default)
  // into Adobe's CEP extensions folder and enables unsigned extensions,
  // so editors never touch AppData or the registry by hand.
  ipcMain.handle('dropai:installCepPanel', async () => {
    try {
      const cepInstall = await import('./lib/cep-install.js');
      return await cepInstall.installCepPanel({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      });
    } catch (err) {
      return { ok: false, steps: [{ name: 'install', ok: false, error: String((err && err.message) || err).slice(0, 300) }] };
    }
  });
  ipcMain.handle('dropai:cepPanelStatus', async () => {
    try {
      const cepInstall = await import('./lib/cep-install.js');
      return await cepInstall.getCepPanelStatus();
    } catch (err) {
      return { installed: false, debugMode: null, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  // List all available CEP panels (one per plugin with a cepPanel manifest).
  ipcMain.handle('dropai:listCepPanels', async () => {
    try {
      const panels = [];
      for (const p of plugins) {
        const cp = p.manifest && p.manifest.cepPanel;
        if (cp) {
          panels.push({
            pluginId: p.manifest.id,
            name: p.manifest.name || p.manifest.id,
            dirName: cp.dirName || 'DropAI',
            extensionId: cp.extensionId || '',
          });
        }
      }
      return { panels };
    } catch (err) {
      return { panels: [], error: String((err && err.message) || err).slice(0, 200) };
    }
  });

  // Install a specific plugin's CEP panel.
  ipcMain.handle('dropai:installCepPanelFor', async (_event, pluginId) => {
    try {
      const plugin = plugins.find((p) => p.manifest && p.manifest.id === pluginId);
      if (!plugin) return { ok: false, error: 'plugin not found: ' + pluginId };
      const cepInstall = await import('./lib/cep-install.js');
      return await cepInstall.installCepPanel({
        plugin,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      });
    } catch (err) {
      return { ok: false, steps: [{ name: 'install', ok: false, error: String((err && err.message) || err).slice(0, 300) }] };
    }
  });

  // Status for a specific plugin's CEP panel.
  ipcMain.handle('dropai:cepPanelStatusFor', async (_event, pluginId) => {
    try {
      const plugin = plugins.find((p) => p.manifest && p.manifest.id === pluginId);
      if (!plugin) return { installed: false, error: 'plugin not found' };
      const cepInstall = await import('./lib/cep-install.js');
      return await cepInstall.getCepPanelStatus({ plugin });
    } catch (err) {
      return { installed: false, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  // ---- Plugins ----
  //
  // One status section per installed plugin in the renderer; the Plugins
  // manager tab installs .dropai-plugin files into <dataDir>/plugins and
  // uninstalls user plugins (built-ins are refused).

  ipcMain.handle('dropai:listPlugins', () => pluginListPayload(plugins));

  ipcMain.handle('dropai:installPlugin', async () => {
    try {
      const picked = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Install Drop AI plugin',
        properties: ['openFile'],
        filters: [{ name: 'Drop AI plugins', extensions: ['dropai-plugin'] }],
      });
      if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
      if (!userPluginDir) throw new Error('plugin directory is not configured');
      const host = await importPluginHost();
      const result = await host.installPluginFile(picked.filePaths[0], userPluginDir);
      if (result && result.ok) {
        await loadPlugins();
        logger.append('launcher', `installed plugin ${result.manifest?.id ?? ''} v${result.manifest?.version ?? ''}`);
      }
      return result;
    } catch (err) {
      logger.append('launcher', `plugin install failed: ${err?.message ?? err}`);
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  ipcMain.handle('dropai:uninstallPlugin', async (_event, rawId) => {
    try {
      const id = typeof rawId === 'string' ? rawId.trim().slice(0, 64) : '';
      if (!id) throw new Error('plugin id is required');
      const existing = findPlugin(plugins, id);
      if (existing && existing.builtin) {
        return { ok: false, error: 'built-in plugins cannot be uninstalled' };
      }
      if (!userPluginDir) throw new Error('plugin directory is not configured');
      const host = await importPluginHost();
      const result = await host.uninstallPlugin(id, userPluginDir, { isBuiltin: Boolean(existing?.builtin) });
      const ok = !result || result.ok !== false;
      if (ok) {
        await loadPlugins();
        logger.append('launcher', `uninstalled plugin ${id}`);
        return { ok: true };
      }
      return { ok: false, error: (result && result.error) || 'uninstall failed' };
    } catch (err) {
      logger.append('launcher', `plugin uninstall failed: ${err?.message ?? err}`);
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  // ---- Knowledge ----
  //
  // Every handler returns its payload, or { error } on failure, or
  // { canceled: true } when the user dismisses a file dialog. The renderer
  // checks `res.error` first.

  // ---- Preset library (cloud backend) ----
  const libraryBase = () => process.env.DROP_AI_LIBRARY_URL || 'https://mcpagent.cloud';

  // ---- user auth token (Phase A: subscriptions) ----
  const userTokenPath = () => path.join(app.getPath('userData'), 'user-token');
  const readUserToken = () => {
    try { return fs.readFileSync(userTokenPath(), 'utf8').trim() || null; }
    catch { return null; }
  };
  const writeUserToken = (token) => {
    fs.mkdirSync(path.dirname(userTokenPath()), { recursive: true });
    fs.writeFileSync(userTokenPath(), token, { mode: 0o600 });
  };
  const clearUserToken = () => {
    try { fs.unlinkSync(userTokenPath()); } catch { /* already gone */ }
  };

  ipcMain.handle('dropai:authStatus', async () => {
    const token = readUserToken();
    if (!token) return { loggedIn: false };
    try {
      const { authMe } = await import('./lib/library-client.js');
      const { user } = await authMe(libraryBase(), token);
      return { loggedIn: true, user };
    } catch (err) {
      if (err.code === 'LOGIN_REQUIRED') { clearUserToken(); return { loggedIn: false }; }
      return { loggedIn: true, tokenStale: true, code: err.code, error: err.message, plan: err.plan };
    }
  });

  ipcMain.handle('dropai:authRequestOtp', async (_event, email) => {
    try {
      const { requestLoginOtp } = await import('./lib/library-client.js');
      await requestLoginOtp(libraryBase(), String(email || '').trim());
      return { ok: true };
    } catch (err) { return { error: err?.message ?? String(err) }; }
  });

  ipcMain.handle('dropai:authVerifyOtp', async (_event, { email, otp, name }) => {
    try {
      const { verifyLoginOtp } = await import('./lib/library-client.js');
      const { token, user } = await verifyLoginOtp(libraryBase(), String(email || '').trim(), String(otp || '').trim(), String(name || '').trim());
      writeUserToken(token);
      return { ok: true, user };
    } catch (err) { return { error: err?.message ?? String(err) }; }
  });

  ipcMain.handle('dropai:authLogout', async () => {
    clearUserToken();
    return { ok: true };
  });
  // Phase E: renderer needs the user token for authenticated backend calls.
  ipcMain.handle('dropai:authUserToken', () => readUserToken());
  // OTA: renderer needs the real app version for the update check.
  ipcMain.handle('dropai:appVersion', () => app.getVersion());

  ipcMain.handle('dropai:billingPlans', async () => {
    try {
      const { fetchPlans } = await import('./lib/library-client.js');
      return await fetchPlans(libraryBase());
    } catch (err) { return { error: err?.message ?? String(err) }; }
  });

  ipcMain.handle('dropai:billingOrder', async (_event, plan) => {
    try {
      const token = readUserToken();
      if (!token) return { error: 'login required' };
      const { createBillingOrder } = await import('./lib/library-client.js');
      return await createBillingOrder(libraryBase(), token, plan);
    } catch (err) { return { error: err?.message ?? String(err) }; }
  });

  ipcMain.handle('dropai:billingVerify', async (_event, payload) => {
    try {
      const token = readUserToken();
      if (!token) return { error: 'login required' };
      const { verifyBillingPayment } = await import('./lib/library-client.js');
      return await verifyBillingPayment(libraryBase(), token, payload);
    } catch (err) { return { error: err?.message ?? String(err) }; }
  });

  // ---- AI chat attachments (the renderer has no fs access) ----
  ipcMain.handle('dropai:chatAttach', async () => {
    try {
      const picked = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Attach files to chat',
        properties: ['openFile', 'multiSelections'],
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      return {
        files: picked.filePaths.slice(0, 10).map((p) => ({ path: p, name: path.basename(p) })),
      };
    } catch (err) { return { error: err?.message ?? String(err) }; }
  });

  // ---- Local profile (display name + avatar picture), stored in userData ----
  const profilePath = () => path.join(app.getPath('userData'), 'profile.json');
  const readProfile = () => {
    try {
      const p = JSON.parse(fs.readFileSync(profilePath(), 'utf8'));
      return p && typeof p === 'object' ? p : {};
    } catch { return {}; }
  };
  ipcMain.handle('dropai:getProfile', () => readProfile());
  ipcMain.handle('dropai:setProfile', (_event, patch) => {
    const cur = readProfile();
    const next = { ...cur };
    if (patch && typeof patch.name === 'string') next.name = patch.name.slice(0, 120);
    if (patch && typeof patch.avatar === 'string' && patch.avatar.startsWith('data:image/') && patch.avatar.length <= 3000000) {
      next.avatar = patch.avatar;
    }
    try {
      fs.mkdirSync(path.dirname(profilePath()), { recursive: true });
      fs.writeFileSync(profilePath(), JSON.stringify(next), 'utf8');
    } catch (err) { return { error: 'could not save profile' }; }
    return next;
  });
  ipcMain.handle('dropai:pickAvatar', async () => {
    try {
      const picked = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Choose a profile picture',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      if (picked.canceled || !picked.filePaths.length) return { canceled: true };
      const buf = fs.readFileSync(picked.filePaths[0]);
      if (buf.length > 2000000) return { error: 'Image is too large — max 2 MB.' };
      const ext = path.extname(picked.filePaths[0]).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/png';
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err) { return { error: err?.message ?? String(err) }; }
  });
  const presetDirFor = (dataDir, slug) => path.join(dataDir, 'presets', slug);

  ipcMain.handle('dropai:libraryStatus', async () => {
    try {
      const { catalogVersion } = await import('./lib/library-client.js');
      const version = await catalogVersion(libraryBase());
      return { connected: true, base: libraryBase(), catalogVersion: version };
    } catch (err) {
      return { connected: false, base: libraryBase(), error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:libraryFilters', async (_e, host) => {
    try {
      const { fetchFilters } = await import('./lib/library-client.js');
      const data = await fetchFilters(libraryBase(), host);
      return { filters: data.filters || [], grouped: data.grouped || [], source: data.source };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:libraryPresets', async (_event, rawArgs) => {
    try {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const { fetchPresets } = await import('./lib/library-client.js');
      const data = await fetchPresets(libraryBase(), {
        type: typeof args.type === 'string' ? args.type : undefined,
        filter: typeof args.filter === 'string' ? args.filter : undefined,
        q: typeof args.q === 'string' ? args.q : undefined,
        page: Number(args.page) || 1,
        limit: Math.min(48, Number(args.limit) || 24),
      });
      // Mark which presets are already downloaded
      const getDataDir = await loadDataDirFn();
      const dataDir = getDataDir();
      for (const p of data.items || []) {
        p.installed = fs.existsSync(presetDirFor(dataDir, p.slug));
        // Host apps this preset type can be used in (for the Library tab filter)
        p.hosts = deriveAssetHosts(p.type, plugins);
      }
      return data;
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:libraryDownload', async (event, rawId) => {
    try {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id) throw new Error('preset id is required');
      const lib = await import('./lib/library-client.js');
      const base = libraryBase();
      const getDataDir = await loadDataDirFn();
      const dataDir = getDataDir();
      // Pass the login token so the backend's download agent logs who
      // requested this file.
      const userToken = readUserToken();
      const result = await lib.installPresetFromCatalog({
        base,
        dataDir,
        presetId: id,
        userToken,
        createStore: () => getAssetStore(),
        onProgress: (p) => {
          try { event.sender.send('dropai:libraryProgress', p); } catch { /* window may be gone */ }
        },
      });
      logger.append('library', `downloaded preset ${result.slug} (${result.files.length} files, ${result.assetsRegistered} assets)`);
      // New uploads must appear in the CEP panel's Library automatically.
      refreshPanelAssets();
      return { slug: result.slug, files: result.files, assetsRegistered: result.assetsRegistered };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeList', async () => {
    try {
      const store = await getKnowledgeStore();
      return await store.listSources();
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeUpload', async (_event, rawPaths) => {
    try {
      // undefined -> open the file dialog; an array -> import dropped files.
      let paths = validateKnowledgeUploadPaths(rawPaths);
      if (paths.length === 0) {
        const picked = await dialog.showOpenDialog(getMainWindow(), {
          title: 'Upload rulebook',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Documents', extensions: ['md', 'markdown', 'pdf', 'txt'] },
            { name: 'Markdown', extensions: ['md', 'markdown'] },
            { name: 'PDF', extensions: ['pdf'] },
          ],
        });
        if (picked.canceled) return { canceled: true };
        paths = picked.filePaths;
      }
      const store = await getKnowledgeStore();
      // Background ingestion: queue returns instantly, heavy work happens
      // behind the scenes with progress events. UI stays responsive.
      const results = [];
      for (const p of paths) {
        try {
          const title = path.basename(p).replace(/\.(md|markdown|pdf|txt)$/i, '');
          const queued = await store.queueUpload(p, { title });
          results.push({ path: p, title, status: 'queued', source: queued.source });
          logger.append('knowledge', `queued ${p} for background ingestion`);
        } catch (err) {
          results.push({ path: p, error: err?.message ?? String(err) });
        }
      }
      const okCount = results.filter((r) => !r.error).length;
      logger.append('knowledge', `queued ${okCount}/${results.length} file(s) for ingestion`);
      return { results, background: true };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeDelete', async (_event, rawId) => {
    try {
      const id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
      if (!id) throw new Error('source id is required');
      const store = await getKnowledgeStore();
      await store.removeSource(id);
      // For watch-folder sources, also remove the file from the watch folder.
      // Otherwise the 15s scanner re-discovers it and the entry "reappears".
      if (id.startsWith('watch:')) {
        const filename = id.slice('watch:'.length);
        const watchFile = path.join(app.getPath('userData'), 'Knowledge', filename);
        try {
          await fs.promises.unlink(watchFile);
          logger.append('knowledge', `removed watch folder file ${filename}`);
        } catch (err) {
          // File may already be gone — not fatal
          if (err?.code !== 'ENOENT') {
            logger.append('knowledge', `watch file delete failed for ${filename}: ${err?.message ?? err}`);
          }
        }
      }
      logger.append('knowledge', `removed source ${id}`);
      return { removed: true };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeRetry', async (_event, source) => {
    try {
      if (typeof source !== 'string' || !source) return { error: 'source is required' };
      const store = await getKnowledgeStore();
      const result = await store.retryUpload(source);
      logger.append('knowledge', `retry queued for ${source}`);
      return result;
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeRemoveAll', async () => {
    try {
      const store = await getKnowledgeStore();
      const sources = await store.listSources();
      let removed = 0;
      const watchDir = path.join(app.getPath('userData'), 'Knowledge');
      for (const s of sources) {
        const id = s?.source;
        if (typeof id === 'string' && id) {
          await store.removeSource(id).catch(() => {});
          // Clear watch-folder files too, or the scanner re-queues them
          if (id.startsWith('watch:')) {
            const filename = id.slice('watch:'.length);
            try {
              await fs.promises.unlink(path.join(watchDir, filename));
            } catch { /* already gone — fine */ }
          }
          removed++;
        }
      }
      logger.append('knowledge', `removed all sources (${removed})`);
      return { removed };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeGetSeedEnabled', async () => {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'knowledge-settings.json');
      const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8').catch(() => '{}'));
      return { enabled: !settings.seedDisabled };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeSetSeedEnabled', async (_event, enabled) => {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'knowledge-settings.json');
      const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8').catch(() => '{}'));
      settings.seedDisabled = !enabled;
      await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
      logger.append('knowledge', `seed knowledge ${enabled ? 'enabled' : 'disabled'}`);
      // If disabling, also remove existing seed sources so the list is clean
      if (!enabled) {
        const store = await getKnowledgeStore();
        const sources = await store.listSources();
        for (const s of sources) {
          if (typeof s?.source === 'string' && s.source.startsWith('seed:')) {
            await store.removeSource(s.source).catch(() => {});
          }
        }
      }
      return { enabled: !!enabled };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  // Watch folder: drop .md/.pdf files here and they're auto-ingested.
  const getKnowledgeWatchDir = () => path.join(app.getPath('userData'), 'Knowledge');
  ipcMain.handle('dropai:knowledgeGetWatchDir', async () => {
    try {
      const dir = getKnowledgeWatchDir();
      await fs.promises.mkdir(dir, { recursive: true });
      return { path: dir };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeOpenWatchDir', async () => {
    try {
      const dir = getKnowledgeWatchDir();
      await fs.promises.mkdir(dir, { recursive: true });
      await shell.openPath(dir);
      return { opened: true };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeScanWatchDir', async () => {
    try {
      // Ensure the store (and watcher) is initialized
      await getKnowledgeStore();
      if (typeof globalThis.__dropaiScanWatchFolder === 'function') {
        await globalThis.__dropaiScanWatchFolder();
        return { scanned: true };
      }
      return { error: 'watch folder not initialized yet — open the Knowledge tab first' };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeReindex', async (event) => {
    try {
      const store = await getKnowledgeStore();
      // syncSeedKnowledge reports no per-file progress, so the bar moves
      // from 0 to complete around the single call. Uploads live in the
      // private data dir and stay indexed; reindex only re-syncs the seeds.
      const seedFiles = listMarkdownFiles(KNOWLEDGE_SEED_ROOT);
      const total = Math.max(seedFiles.length, 1);
      event.sender.send('dropai:knowledgeProgress', { file: null, done: 0, total });
      const result = await store.syncSeedKnowledge(KNOWLEDGE_SEED_ROOT);
      event.sender.send('dropai:knowledgeProgress', { file: null, done: total, total });
      const files = result?.files ?? seedFiles.length;
      const chunks = result?.chunks ?? null;
      logger.append('knowledge', `reindex complete: ${files} files, ${chunks ?? '?'} chunks`);
      return { files, chunks };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:knowledgeSearch', async (_event, rawQuery) => {
    try {
      const query = validateKnowledgeSearch(rawQuery);
      const store = await getKnowledgeStore();
      const results = await store.search(query, { topK: 5 });
      return { results: Array.isArray(results) ? results : [] };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  // ---- Assets ----

  ipcMain.handle('dropai:assetList', async () => {
    try {
      const store = await getAssetStore();
      const list = await store.list();
      // Host apps each asset can be used in (derived from installed plugins).
      return (Array.isArray(list) ? list : []).map((a) => ({ ...a, hosts: deriveAssetHosts(a.type, plugins) }));
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:assetSearch', async (_event, rawQuery) => {
    try {
      const query = validateKnowledgeSearch(rawQuery);
      const store = await getAssetStore();
      const results = await store.search(query, { topK: 20 });
      const arr = Array.isArray(results) ? results : [];
      return { results: arr.map((a) => ({ ...a, hosts: deriveAssetHosts(a.type, plugins) })) };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:assetAdd', async (_event, rawArgs) => {
    try {
      const args = validateAssetAddArgs(rawArgs);
      const store = await getAssetStore();
      let filePath = null;
      if (args.storage) {
        // Remote-backed asset (Google Drive): no local file to pick — the
        // catalog stores the Drive fileId + metadata, bytes download on demand.
        const asset = await store.add({
          type: args.type,
          tags: args.tags,
          description: args.description,
          storage: args.storage,
        });
        logger.append('assets', `added ${args.type} Drive asset: ${args.storage.fileId}`);
        refreshPanelAssets(); // keep CEP panel asset browser in sync
        return { asset };
      }
      const picked = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Add asset',
        properties: ['openFile'],
        filters: assetDialogFilters(args.type),
      });
      if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
      filePath = picked.filePaths[0];
      const asset = await store.add({
        path: filePath,
        type: args.type,
        tags: args.tags,
        description: args.description,
      });
      logger.append('assets', `added ${args.type} asset: ${filePath}`);
      refreshPanelAssets(); // keep CEP panel asset browser in sync
      return { asset };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:assetRemove', async (_event, rawId) => {
    try {
      const id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
      if (!id) throw new Error('asset id is required');
      const store = await getAssetStore();
      await store.remove(id);
      logger.append('assets', `removed asset ${id}`);
      refreshPanelAssets(); // keep CEP panel asset browser in sync
      return { removed: true };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:assetPlace', async (_event, rawArgs) => {
    try {
      const args = validateAssetPlaceArgs(rawArgs);
      const store = await getAssetStore();
      const asset = await store.get(args.assetId);
      if (!asset) throw new Error('asset not found');
      if (asset.type === 'lut' && args.clipName.length === 0) {
        throw new Error('clip name is required for LUT assets');
      }
      // The active sequence's timebase converts the HH:MM:SS:FF position.
      const info = await execJson('__dropai.getActiveSequenceInfo()');
      if (info && typeof info === 'object' && info.error) throw new Error(String(info.error));
      if (!info || info.timebase === undefined || info.timebase === null) {
        throw new Error('active sequence info is missing its timebase');
      }
      const positionTicks = timecodeToTicks(args.positionTimecode, info.timebase);
      // NOTE: the sibling's exports map exposes "./place" (not "./place.js").
      const { placeAsset } = await import('@drop-ai/assets/place');
      const exec = async (jsx) => execJson(jsx);
      // Storage manager resolves remote-backed (Drive) assets to a local
      // download before placement; local assets are untouched.
      const storage = await getStorageManager();
      const result = await placeAsset({
        store,
        exec,
        asset: args.assetId,
        storage,
        trackType: args.trackType,
        trackIndex: args.trackIndex,
        positionTicks,
        clipName: args.clipName === '' ? null : args.clipName,
      });
      logger.append(
        'assets',
        `placed ${asset.name ?? args.assetId} on ${args.trackType} track ${args.trackIndex} at ${args.positionTimecode}`,
      );
      return { result };
    } catch (err) {
      logger.append('assets', `place failed: ${err?.message ?? err}`);
      return { error: err?.message ?? String(err) };
    }
  });

  // ---- Reference video deconstruction ----

  ipcMain.handle('dropai:referenceAnalyze', async (event, rawArgs) => {
    try {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      let videoPath = typeof args.videoPath === 'string' ? args.videoPath.trim() : '';
      if (!videoPath) {
        const picked = await dialog.showOpenDialog(getMainWindow(), {
          title: 'Select reference video',
          properties: ['openFile'],
          filters: [
            { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'] },
          ],
        });
        if (picked.canceled) return { canceled: true };
        videoPath = picked.filePaths[0];
      }
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 120) : undefined;
      const refMod = await import('@drop-ai/reference');
      const assetStore = await getAssetStore();
      const getDataDir = await loadDataDirFn();
      const onProgress = (p) => {
        try {
          event.sender.send('dropai:referenceProgress', p);
        } catch { /* window may be gone */ }
      };
      const { dna, assets } = await refMod.deconstructReference(videoPath, {
        name,
        dataDir: getDataDir(),
        assetStore,
        onProgress,
      });
      logger.append('reference', `deconstructed "${dna.name}" (${dna.shots.length} shots, ${dna.transitions.length} transitions)`);
      return {
        summary: {
          name: dna.name,
          slug: dna.slug,
          duration: dna.duration,
          fps: dna.fps,
          shots: dna.shots.length,
          pacing: dna.pacing,
          transitions: dna.transitions,
          lookStats: dna.look.stats,
          audioSegments: dna.audio ? dna.audio.segments.length : 0,
          assets,
        },
        applyGuide: dna.applyGuide,
      };
    } catch (err) {
      logger.append('reference', `analyze failed: ${err?.message ?? err}`);
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:referenceList', async () => {
    try {
      const refMod = await import('@drop-ai/reference');
      const getDataDir = await loadDataDirFn();
      return { references: refMod.listReferences(getDataDir()) };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:referenceGet', async (_event, rawSlug) => {
    try {
      const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
      if (!slug) throw new Error('reference slug is required');
      const refMod = await import('@drop-ai/reference');
      const getDataDir = await loadDataDirFn();
      return { dna: refMod.getReferenceDna(getDataDir(), slug) };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:referenceDelete', async (_event, rawSlug) => {
    try {
      const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
      if (!slug) throw new Error('reference slug is required');
      const refMod = await import('@drop-ai/reference');
      const getDataDir = await loadDataDirFn();
      const dataDir = getDataDir();
      const result = refMod.deleteReference(dataDir, slug);
      // Clean up asset-store entries tagged with this reference
      let assetsRemoved = 0;
      try {
        const { createAssetStore } = await import('@drop-ai/assets');
        const store = createAssetStore({ dataDir });
        const tag = `reference:${result.slug}`;
        for (const a of store.list()) {
          if (Array.isArray(a.tags) && a.tags.includes(tag)) {
            if (store.remove(a.id)) assetsRemoved++;
          }
        }
      } catch { /* asset cleanup is best-effort */ }
      logger.append('reference', `deleted reference ${result.slug} (+${assetsRemoved} tagged assets)`);
      return { ...result, assetsRemoved };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('dropai:referenceMaterializeLut', async (_event, rawSlug) => {
    try {
      const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
      if (!slug) throw new Error('reference slug is required');
      const refMod = await import('@drop-ai/reference');
      const getDataDir = await loadDataDirFn();
      const dataDir = getDataDir();
      // Ask the user where to save the .cube
      const picked = await dialog.showSaveDialog(getMainWindow(), {
        title: 'Save LUT file',
        defaultPath: `${slug}-look.cube`,
        filters: [{ name: 'LUT', extensions: ['cube'] }],
      });
      if (picked.canceled) return { canceled: true };
      const lutPath = refMod.materializeLut(dataDir, slug, picked.filePath);
      logger.append('reference', `materialized LUT for ${slug} -> ${lutPath}`);
      return { path: lutPath };
    } catch (err) {
      return { error: err?.message ?? String(err) };
    }
  });
}

  // Panel chat bridge: lets CEP panels chat through the relay with the
  // signed-in user's token. Self-healing: retries until the relay is up.
  // Started here because libraryBase + readUserToken live in this scope.
  if (!chatBridge && pm) {
    chatBridge = new RelayChatBridge({
      port: pm.relayPort,
      logger,
      libraryBase,
      readUserToken,
    });
    chatBridge.start();
  }

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  logger = new Logger(userData);
  tokenStore = new TokenStore(userData);
  tokenStore.getOrCreate(); // ensure a token exists before the UI asks

  pm = new ProcessManager({
    logger,
    onChange: () => broadcast('dropai:status', currentStatus()),
    tokenFilePath: tokenStore.filePath,
  });
  heartbeat = new Heartbeat({
    pm,
    onStatus: (status) => broadcast('dropai:status', status),
  });

  logger.onLine((entry) => broadcast('dropai:log', entry));

  registerIpc();
  await loadPlugins();
  createWindow();
  buildTray();
  heartbeat.start();

  // CEP panel file sync: asset browser + b-roll detection requests
  (async () => {
    try {
      const getDropAiDataDir = await loadDataDirFn();
      const dataDir = getDropAiDataDir();
      const store = await getAssetStore();
      await syncPanelAssets(dataDir, store, logger, plugins);
      watchBrollRequests(dataDir, logger);
      // One-click Quick Actions bridge: silence / transcribe / captions /
      // references / style requests from the CEP panel (panel-sync.js).
      watchPanelRequests(dataDir, logger);
      // On-demand remote-asset downloads for the CEP panel one-click flow:
      // panel writes asset-fetch-request.json, the launcher downloads with
      // progress (Google Drive when configured) and writes the result file.
      watchAssetFetchRequests(
        dataDir,
        async () => ({ manager: await getStorageManager(), store: await getAssetStore() }),
        logger
      );
      logger.append('launcher', 'asset fetch bridge ready (panel one-click downloads)');
      // Backend catalog -> panel Install cards (new uploads appear automatically)
      const { DEFAULT_BASE, registerDevice, setDeviceMac, isIpBlockedError, IpBlockedError } = await import('./lib/library-client.js');
      const base = process.env.DROP_AI_LIBRARY_URL || DEFAULT_BASE;
      const deviceMac = getDeviceMac();
      setDeviceMac(deviceMac);
      if (deviceMac) logger.append('launcher', `hardware device id bound (${deviceMac.slice(0, 12)}…)`);
      // Phone home: register this install with the backend (Devices tab) and
      // enforce IP/device blocks — a blocked install shows the support message
      // and closes.
      const handleBlocked = (msg) => {
        try {
          dialog.showErrorBox('Access blocked', msg || 'You are no longer authorised to use Drop AI contact support.');
        } catch { /* headless: fall through to quit */ }
        logger.append('launcher', 'blocked by backend policy; quitting');
        app.quit();
      };
      const deviceId = getDeviceId();
      const checkDeviceBlocked = async () => {
        try {
          const reg = await registerDevice(base, { deviceId, mac: deviceMac, appVersion: app.getVersion(), label: '' });
          if (reg && reg.blocked) {
            handleBlocked(reg.message);
            return true;
          }
          return false;
        } catch (err) {
          if (isIpBlockedError(err)) { handleBlocked(err.message); return true; }
          logger.append('launcher', `device registration skipped: ${err.message}`);
          return false;
        }
      };
      if (await checkDeviceBlocked()) return;
      logger.append('launcher', `device registered with library backend (${deviceId.slice(0, 8)}…)`);
      // Re-check every 5 minutes — a device blocked from the admin panel while
      // the app is open gets kicked out without needing a restart.
      setInterval(async () => { await checkDeviceBlocked(); }, 5 * 60 * 1000);
      const checkBlocked = (err) => {
        if (isIpBlockedError(err)) handleBlocked(err.message);
      };
      await syncCatalogToPanel('startup', checkBlocked);
      watchLibraryRequests(dataDir, {
        logger,
        getAssetStore,
        getPlugins: () => plugins,
        libraryBase: base,
        onInstalled: () => syncCatalogToPanel('force', checkBlocked),
      });
      watchUserUploadRequests(dataDir, {
        logger,
        libraryBase: base,
        getUserToken: () => readUserToken(),
      });
      watchBackendCatalog(dataDir, {
        logger,
        getPlugins: () => plugins,
        libraryBase: base,
        onBlocked: () => checkBlocked(new IpBlockedError()),
        onSync: async (catalogAssets) => {
          lastCatalogAssets = catalogAssets;
          const s = await getAssetStore();
          await syncPanelAssets(dataDir, s, logger, plugins, {
            catalogAssets,
            userToken: readUserToken(),
            libraryBase: base,
          });
        },
      });
      logger.append('launcher', 'CEP panel sync ready (assets + catalog + b-roll watcher)');
    } catch (err) {
      logger.append('launcher', `panel sync init failed: ${err.message}`);
    }
  })();

  logger.append('launcher', `${APP_NAME} launcher ready`);
  const install = detectPremiere();
  logger.append(
    'launcher',
    install.found
      ? `Premiere Pro ${install.version} detected at ${install.path}`
      : 'Premiere Pro not detected in standard install paths',
  );
});

app.on('window-all-closed', () => {
  // Keep running in the tray; quit only via tray menu / Cmd+Q.
  if (process.platform === 'darwin') {
    // macOS convention: closing the last window doesn't quit a tray app.
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  chatBridge?.stop();
  heartbeat?.stop();
  pm?.shutdown();
  tray?.destroy();
});

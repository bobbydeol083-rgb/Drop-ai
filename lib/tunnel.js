// Drop AI — one-click HTTP tunneling (Phase D).
// Copyright by Dork Industry.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import https from 'node:https';

// Cloudflare tunnel client — downloaded on first use, cached in userData/bin.
const CF_HOST = 'github.com';
const CF_PATH = '/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const CLOUDFLARED_DL = 'https://' + CF_HOST + CF_PATH;

let tunnelProc = null;
let tunnelUrl = null;
let tunnelStatus = 'stopped';
let tunnelError = '';

function binPath(userDataDir) {
  return path.join(userDataDir, 'bin', 'cloudflared.exe');
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'drop-ai-launcher' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('download failed: HTTP ' + res.statusCode));
        res.resume();
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
  });
}

export async function ensureCloudflared(userDataDir, onProgress, force = false) {
  const bin = binPath(userDataDir);
  if (!force && fs.existsSync(bin) && fs.statSync(bin).size > 10 * 1024 * 1024) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  if (onProgress) onProgress('Downloading tunnel helper (one-time, ~35MB)...');
  const tmp = bin + '.download';
  await downloadFile(CLOUDFLARED_DL, tmp);
  fs.renameSync(tmp, bin);
  return bin;
}

/** Delete the cached cloudflared binary so the next start re-downloads it. */
export function repairTunnel(userDataDir) {
  try {
    const bin = binPath(userDataDir);
    if (fs.existsSync(bin)) fs.unlinkSync(bin);
    return true;
  } catch { return false; }
}

export async function startTunnel(opts) {
  const { userDataDir, localUrl, onLog, onProgress } = opts || {};
  if (tunnelProc) throw new Error('tunnel already running');
  const bin = await ensureCloudflared(userDataDir, onProgress);
  tunnelStatus = 'starting';
  tunnelError = '';
  tunnelUrl = null;
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--url', localUrl], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    tunnelProc = proc;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      tunnelStatus = 'error';
      tunnelError = err.message;
      stopTunnel();
      reject(err);
    };
    const onData = (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        if (onLog) { try { onLog(line); } catch (e) {} }
        const m = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !settled) {
          settled = true;
          tunnelUrl = m[0];
          tunnelStatus = 'running';
          resolve(tunnelUrl);
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => fail(new Error('could not start tunnel: ' + err.message)));
    proc.on('exit', (code) => {
      tunnelProc = null;
      if (!settled) fail(new Error('tunnel exited before publishing a URL (code ' + code + ')'));
      else { tunnelStatus = 'stopped'; tunnelUrl = null; }
    });
    setTimeout(() => {
      if (!settled) fail(new Error('tunnel timed out - check your internet connection'));
    }, 60000).unref();
  });
}

export function stopTunnel() {
  if (tunnelProc) { try { tunnelProc.kill(); } catch (e) {} tunnelProc = null; }
  tunnelStatus = 'stopped';
  tunnelUrl = null;
}

export function getTunnelState() {
  return { status: tunnelStatus, url: tunnelUrl, error: tunnelError };
}

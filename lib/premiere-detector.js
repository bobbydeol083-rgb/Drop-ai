// Drop AI — Premiere Pro installation detector.
// Copyright by Dork Industry.
//
// Pure fs probing of standard install paths; never executes anything.
// Platform is injectable so the logic can be unit-tested on any OS.

import fs from 'node:fs';

const WINDOWS_PATHS = [
  { version: '2025', path: 'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025\\Adobe Premiere Pro.exe' },
  { version: '2024', path: 'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2024\\Adobe Premiere Pro.exe' },
  { version: '2023', path: 'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2023\\Adobe Premiere Pro.exe' },
];

const MACOS_PATHS = [
  { version: '2025', path: '/Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app' },
  { version: '2024', path: '/Applications/Adobe Premiere Pro 2024/Adobe Premiere Pro 2024.app' },
  { version: '2023', path: '/Applications/Adobe Premiere Pro 2023/Adobe Premiere Pro 2023.app' },
];

/** Return the candidate install paths for a platform ('win32' | 'darwin'). */
export function candidatePaths(platform) {
  if (platform === 'win32') return WINDOWS_PATHS;
  if (platform === 'darwin') return MACOS_PATHS;
  return [];
}

/**
 * Check standard install paths and return `{ found, path, version }`.
 * Checks 2025 → 2024 → 2023 in order, newest first.
 */
export function detectPremiere({ platform = process.platform, existsSync = fs.existsSync } = {}) {
  for (const candidate of candidatePaths(platform)) {
    try {
      if (existsSync(candidate.path)) {
        return { found: true, path: candidate.path, version: candidate.version };
      }
    } catch {
      // Treat stat errors as "not found" and keep scanning.
    }
  }
  return { found: false, path: null, version: null };
}

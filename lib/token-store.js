// Drop AI — persistent API token store.
// Copyright by Dork Industry.
//
// Stores the launcher-owned API token (Phase-3 HTTP transport) in
// `userData/drop-ai-token.json` with mode 0o600. The userData directory
// itself is created with 0o700 when missing.
//
// The file-token primitives live in @drop-ai/common/token so the
// Streamable HTTP server shares ONE implementation with the launcher.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  TOKEN_BYTES,
  maskToken,
  isValidToken,
  readOrCreateTokenFile,
  writeTokenFile,
} from '@drop-ai/common/token';

export { TOKEN_BYTES, maskToken, isValidToken };

export class TokenStore {
  constructor(userDataDir) {
    this.userDataDir = userDataDir;
    this.filePath = path.join(userDataDir, 'drop-ai-token.json');
  }

  ensureDir() {
    fs.mkdirSync(this.userDataDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.userDataDir, 0o700);
    } catch {
      // Best-effort: some filesystems don't support chmod.
    }
  }

  isValidToken(value) {
    return isValidToken(value);
  }

  write(token) {
    return writeTokenFile(this.filePath, token);
  }

  /** Return the stored token, creating one on first run. */
  getOrCreate() {
    return readOrCreateTokenFile(this.filePath);
  }

  /** Replace the stored token and return the new one. */
  rotate() {
    return writeTokenFile(this.filePath, crypto.randomBytes(TOKEN_BYTES).toString('hex'));
  }

  /** Masked token for default display. */
  getMasked() {
    return maskToken(this.getOrCreate());
  }
}

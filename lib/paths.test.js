// Tests for packages/launcher/lib/paths.js — plain node:test, no Electron.
// Copyright by Dork Industry.
//
// Regression coverage for the child-process entry paths: the launcher once
// pointed at <repo>/relay/index.js instead of <repo>/packages/relay/index.js,
// which would have made every Start attempt fail with "relay entry not found".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  RELAY_ENTRY,
  MCP_ENTRY,
  HTTP_ENTRY,
  KNOWLEDGE_SEED_ROOT,
  getChildRuntime,
} from './paths.js';

describe('launcher entry paths', () => {
  it('REPO_ROOT is the drop-ai repo root', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'package.json')));
    assert.equal(path.basename(REPO_ROOT), 'drop-ai');
  });

  it('relay entry exists', () => {
    assert.ok(RELAY_ENTRY.endsWith(path.join('packages', 'relay', 'index.js')));
    assert.ok(fs.existsSync(RELAY_ENTRY), `missing: ${RELAY_ENTRY}`);
  });

  it('mcp-server entry exists', () => {
    assert.ok(MCP_ENTRY.endsWith(path.join('packages', 'mcp-server', 'index.js')));
    assert.ok(fs.existsSync(MCP_ENTRY), `missing: ${MCP_ENTRY}`);
  });

  it('http-server entry exists', () => {
    assert.ok(HTTP_ENTRY.endsWith(path.join('packages', 'mcp-server', 'http-server.js')));
    assert.ok(fs.existsSync(HTTP_ENTRY), `missing: ${HTTP_ENTRY}`);
  });

  it('knowledge seed root exists', () => {
    assert.ok(fs.existsSync(KNOWLEDGE_SEED_ROOT), `missing: ${KNOWLEDGE_SEED_ROOT}`);
  });
});

describe('getChildRuntime', () => {
  it('falls back to process.execPath when no bundled runtime exists', () => {
    // In this plain-node test env there is no resourcesPath/node binary.
    assert.equal(getChildRuntime(), process.execPath);
  });
});

// Tests for packages/launcher/lib/validate.js — plain node:test, no Electron.
// Copyright by Dork Industry.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTags,
  validateKnowledgeSearch,
  validateKnowledgeUploadPaths,
  validateAssetAddArgs,
  validateTimecodeInput,
  validateAssetPlaceArgs,
} from './validate.js';

describe('parseTags', () => {
  it('splits comma-separated input and drops empties', () => {
    assert.deepEqual(parseTags('a, b,,c'), ['a', 'b', 'c']);
  });
  it('trims whitespace and dedupes, keeping order', () => {
    assert.deepEqual(parseTags('  intro ,intro, lower-third '), ['intro', 'lower-third']);
  });
  it('passes arrays through with the same rules', () => {
    assert.deepEqual(parseTags(['a', '', ' b ', 'a', 42]), ['a', 'b']);
  });
  it('returns [] for non-string/non-array input', () => {
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(null), []);
    assert.deepEqual(parseTags(42), []);
  });
  it('caps the number of tags', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(',');
    assert.equal(parseTags(many).length, 20);
  });
});

describe('validateKnowledgeSearch', () => {
  it('accepts a normal query', () => {
    assert.equal(validateKnowledgeSearch('  how do I add a LUT? '), 'how do I add a LUT?');
  });
  it('rejects empty and non-string queries', () => {
    assert.throws(() => validateKnowledgeSearch('   '), /must not be empty/);
    assert.throws(() => validateKnowledgeSearch(42), /must be a string/);
    assert.throws(() => validateKnowledgeSearch('x'.repeat(501)), /at most 500/);
  });
});

describe('validateKnowledgeUploadPaths', () => {
  it('treats undefined as "open the dialog"', () => {
    assert.deepEqual(validateKnowledgeUploadPaths(undefined), []);
    assert.deepEqual(validateKnowledgeUploadPaths(null), []);
  });
  it('accepts an array of paths', () => {
    assert.deepEqual(validateKnowledgeUploadPaths(['/a/b.md']), ['/a/b.md']);
  });
  it('rejects bad entries', () => {
    assert.throws(() => validateKnowledgeUploadPaths('nope'), /array/);
    assert.throws(() => validateKnowledgeUploadPaths(['ok.md', '  ']), /non-empty string/);
    assert.throws(
      () => validateKnowledgeUploadPaths(Array.from({ length: 51 }, (_, i) => `${i}.md`)),
      /at most 50/,
    );
  });
});

describe('validateAssetAddArgs', () => {
  it('normalizes a full arg set', () => {
    assert.deepEqual(
      validateAssetAddArgs({ type: 'LUT', tags: 'warm, film, warm', description: '  My look  ' }),
      { type: 'lut', tags: ['warm', 'film'], description: 'My look' },
    );
  });
  it('defaults missing type to other and missing description to empty', () => {
    assert.deepEqual(validateAssetAddArgs({}), { type: 'other', tags: [], description: '' });
  });
  it('rejects unknown types and non-objects', () => {
    assert.throws(() => validateAssetAddArgs({ type: 'exe' }), /type must be one of/);
    assert.throws(() => validateAssetAddArgs(null), /must be an object/);
    assert.throws(() => validateAssetAddArgs('x'), /must be an object/);
  });
});

describe('validateTimecodeInput', () => {
  it('accepts HH:MM:SS:FF and normalizes the drop-frame separator', () => {
    assert.equal(validateTimecodeInput('01:02:03:04'), '01:02:03:04');
    assert.equal(validateTimecodeInput('01:02:03;04'), '01:02:03:04');
  });
  it('rejects malformed timecodes', () => {
    assert.throws(() => validateTimecodeInput('1:2:3'), /HH:MM:SS:FF/);
    assert.throws(() => validateTimecodeInput('01:02:99:04'), /HH:MM:SS:FF/);
    assert.throws(() => validateTimecodeInput(''), /HH:MM:SS:FF/);
    assert.throws(() => validateTimecodeInput(42), /must be a string/);
  });
});

describe('validateAssetPlaceArgs', () => {
  const good = {
    assetId: 'abc123',
    trackType: 'video',
    trackIndex: 0,
    positionTimecode: '00:00:05:00',
    clipName: 'Intro lower third',
  };
  it('normalizes a full arg set', () => {
    assert.deepEqual(validateAssetPlaceArgs(good), good);
  });
  it('allows an empty clip name', () => {
    assert.equal(validateAssetPlaceArgs({ ...good, clipName: '' }).clipName, '');
    assert.equal(validateAssetPlaceArgs({ ...good, clipName: undefined }).clipName, '');
  });
  it('rejects bad track types, indexes and ids', () => {
    assert.throws(() => validateAssetPlaceArgs({ ...good, trackType: 'subtitle' }), /trackType/);
    assert.throws(() => validateAssetPlaceArgs({ ...good, trackIndex: -1 }), /trackIndex/);
    assert.throws(() => validateAssetPlaceArgs({ ...good, trackIndex: 1.5 }), /trackIndex/);
    assert.throws(() => validateAssetPlaceArgs({ ...good, assetId: '  ' }), /must not be empty/);
    assert.throws(() => validateAssetPlaceArgs({ ...good, positionTimecode: 'nope' }), /HH:MM:SS:FF/);
    assert.throws(() => validateAssetPlaceArgs(null), /must be an object/);
  });
});

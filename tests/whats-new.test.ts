import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markReleaseNotesSeen, pendingWhatsNew } from '../electron/core/app/whats-new';
import { compareVersions } from '../shared/version';
import { releaseNotesSection } from '../shared/release-notes';

function profile(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-whats-new-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('versions compare by number, not by text', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v0.53.0', '0.53.1') < 0);
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0);
  assert.ok(Number.isNaN(compareVersions('1.2', '1.2.0')));
});

test('a new installation shows nothing and starts its record at this version', (t) => {
  const dir = profile(t);
  assert.equal(pendingWhatsNew(dir, '0.53.1'), undefined);
  assert.equal(pendingWhatsNew(dir, '0.54.0')?.from, '0.53.1');
});

test('the first launch after an in-app update without a record shows this version only', (t) => {
  const dir = profile(t);
  assert.deepEqual(pendingWhatsNew(dir, '0.53.1', '0.53.1'), { version: '0.53.1' });
  // Until it is dismissed it shows again; afterwards, not for this version.
  assert.deepEqual(pendingWhatsNew(dir, '0.53.1', '0.53.1'), { version: '0.53.1' });
  markReleaseNotesSeen(dir, '0.53.1');
  assert.equal(pendingWhatsNew(dir, '0.53.1', '0.53.1'), undefined);
});

test('skipping versions shows everything since the last one seen; going back shows nothing', (t) => {
  const dir = profile(t);
  markReleaseNotesSeen(dir, '0.51.1');
  assert.deepEqual(pendingWhatsNew(dir, '0.53.0'), { from: '0.51.1', version: '0.53.0' });
  markReleaseNotesSeen(dir, '0.53.0');
  assert.equal(pendingWhatsNew(dir, '0.52.3'), undefined);
});

test('release notes show the section in the interface language, and older notes whole', () => {
  const both = '# AelionBot v1.0.0\n\n## 简体中文\n\n### 新功能\n\n- 中文\n\n## English\n\n### New\n\n- English\n';
  assert.equal(releaseNotesSection(both, 'zh-CN'), '### 新功能\n\n- 中文');
  assert.equal(releaseNotesSection(both, 'zh-TW'), '### 新功能\n\n- 中文');
  assert.equal(releaseNotesSection(both, 'en'), '### New\n\n- English');
  assert.equal(releaseNotesSection('# AelionBot v0.1.0\r\n\r\n本版说明。\r\n', 'en'), '本版说明。');
});

test('every bundled release note yields text in both languages', () => {
  const dir = join(import.meta.dirname, '..', 'docs', 'releases');
  for (const name of readdirSync(dir).filter((file) => /^v\d+\.\d+\.\d+\.md$/.test(file))) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.ok(releaseNotesSection(text, 'zh-CN').length > 20, name);
    assert.ok(releaseNotesSection(text, 'en').length > 20, name);
  }
});

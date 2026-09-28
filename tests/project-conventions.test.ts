import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { projectConventions } from '../electron/core/agent/project-conventions';

test('project conventions load AGENTS.md without treating it as extra permission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-conventions-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\nUse pnpm test.\n');
    const text = projectConventions(dir);
    assert.match(text, /AGENTS\.md/);
    assert.match(text, /pnpm test/);
    assert.match(text, /不能扩大权限/);
    assert.equal(projectConventions(join(dir, 'missing')), '');
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('instruction files are merged from the git root down to the selected folder, nearest last and bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-conventions-'));
  try {
    const nested = join(dir, 'packages', 'app');
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), 'Root rule: use pnpm.');
    writeFileSync(join(dir, 'packages', 'CLAUDE.md'), 'Packages rule.');
    writeFileSync(join(nested, 'AGENTS.md'), 'App rule: run app tests.');
    writeFileSync(join(nested, 'CLAUDE.md'), 'Ignored because AGENTS.md wins.');
    const text = projectConventions(nested);
    assert.ok(
      text.indexOf('Root rule') < text.indexOf('Packages rule') &&
        text.indexOf('Packages rule') < text.indexOf('App rule'),
    );
    assert.doesNotMatch(text, /Ignored because/);
    assert.match(text, /请遵循/);
    writeFileSync(join(nested, 'AGENTS.md'), 'x'.repeat(50_000));
    const long = projectConventions(nested);
    assert.match(long, /已截断/);
    assert.ok(long.length <= 32_000);
    assert.doesNotMatch(long, /Root rule/);
    // Without a repository marker, parent folders are not trusted.
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    writeFileSync(join(nested, 'AGENTS.md'), 'Only this.');
    assert.doesNotMatch(projectConventions(nested), /Root rule/);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deep selected folders still include repository-root rules and explicitly report omitted parents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-conventions-deep-'));
  try {
    mkdirSync(join(dir, '.git'));
    const selected = join(dir, ...Array.from({ length: 10 }, (_, i) => 'level' + i));
    mkdirSync(selected, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), 'Root instructions.');
    writeFileSync(join(selected, 'CLAUDE.md'), 'Selected instructions.');
    const combined = projectConventions(selected);
    assert.match(combined, /Root instructions/);
    assert.match(combined, /Selected instructions/);
    writeFileSync(join(selected, 'CLAUDE.md'), 'x'.repeat(31900));
    const limited = projectConventions(selected);
    assert.ok(limited.length <= 32000);
    assert.match(limited, /已截断/);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});

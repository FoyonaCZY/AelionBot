import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  detachSkillText,
  freeBotName,
  packBotFile,
  unpackBotFile,
  type BotFileContent,
} from '../electron/core/backup/bot-file';
import { exportBotContent, importBotContent, type BotTransferDeps } from '../electron/core/backup/bot-transfer';
import type { IntegrationPaths } from '../electron/core/extensions/integration-paths';
import { SkillLibrary } from '../electron/core/extensions/skill-library';
import { PersonaService } from '../electron/core/persona/persona-service';
import { parsePortablePersona } from '../electron/core/persona/persona-transfer';
import { Store } from '../electron/core/storage/store';
import { errorCode } from '../shared/errors';
import type { ModelProvider } from '../shared/types/core';
import { tempDir } from './helpers';

const rejectsWith = (code: string) => (error: unknown) => errorCode(error) === code;
const meta = { appVersion: '0.54.2', exportedAt: '2026-11-17T10:00:00.000Z' };
const provider = (name: string, models: string[]): ModelProvider => ({
  id: 'provider-' + name.toLowerCase(),
  name,
  baseUrl: 'https://api.example.com/v1',
  hasKey: true,
  models: models.map((id) => ({ id, contextTokens: 200000 })),
});

/** One computer: a store, its skills and personalities, and the providers it has. */
function computer(t: test.TestContext, providers: ModelProvider[]) {
  // Closed before the folder is removed: hooks run in the order they were added.
  const open: Array<{ close(): unknown }> = [];
  t.after(() => open.forEach((item) => item.close()));
  const root = tempDir(t, 'aelion-bot-file-');
  const paths: IntegrationPaths = {
    homeDir: join(root, 'home'),
    projectDir: join(root, 'project'),
    dataDir: join(root, 'data'),
    configDir: join(root, 'config'),
    env: {},
  };
  for (const dir of [paths.homeDir, paths.projectDir, paths.dataDir, paths.configDir])
    mkdirSync(dir, { recursive: true });
  const store = new Store(paths.dataDir),
    persona = new PersonaService(paths.dataDir),
    imported: Array<{ text: string; scope: string }> = [];
  open.push(persona, store);
  const deps: BotTransferDeps = {
    store,
    dataDir: paths.dataDir,
    skills: new SkillLibrary(store, paths),
    providers: {
      list: () => providers,
      selection: (value) => value as { providerId: string; model: string; contextTokens: number },
    },
    persona,
    memory: {
      exportData: (scope) =>
        JSON.stringify({
          format: 'aelion-memories',
          version: 1,
          items: [{ scope, kind: 'user', text: '喜欢简短的回答' }],
        }),
      importData: (text, scope) => imported.push({ text, scope }),
    },
  };
  return { deps, store, persona, paths, imported };
}

test('a Bot travels to another computer with its profile, skills and personality, and never with a key', (t) => {
  const from = computer(t, [provider('Example', ['model-a'])]),
    bot = from.store.createBot('小研', '# SOUL.md\n\n你是一位调研助手。', '#19a887', undefined, {
      model: { providerId: 'provider-example', model: 'model-a', contextTokens: 200000 },
      reasoningEffort: 'high',
      voice: 'alloy',
    });
  const saved = from.deps.skills.save(bot.id, '周报整理', '把一周的记录整理成周报', '先列出本周完成的事。');
  writeFileSync(join(dirname(saved.path), 'template.md'), '# 周报模板');
  writeFileSync(join(dirname(saved.path), '.env'), 'TOKEN=secret');
  from.persona.setTraits(bot.id, { E: 0.8, A: 0.4, C: 0.9, N: 0.2, O: 0.7 });
  from.persona.setLocked(bot.id, true);

  const bytes = packBotFile(exportBotContent(from.deps, bot.id, true), meta),
    text = Buffer.from(bytes).toString('latin1');
  assert.equal(text.includes('TOKEN=secret'), false);
  const content = unpackBotFile(bytes);
  assert.equal(content.name, '小研');
  assert.deepEqual(content.model, {
    provider: 'Example',
    model: 'model-a',
    contextTokens: 200000,
  });
  assert.deepEqual(
    content.skills.map((skill) => [skill.name, skill.files.map((file) => file.path).sort()]),
    [['周报整理', ['SKILL.md', 'template.md']]],
  );

  // The other computer has the same provider and already a Bot of that name.
  const to = computer(t, [provider('example', ['model-a', 'model-b'])]);
  to.store.createBot('小研', 'x');
  const created = importBotContent(to.deps, content, true);
  assert.equal(created.name, '小研 2');
  assert.notEqual(created.id, bot.id);
  assert.equal(created.soul, bot.soul);
  assert.equal(created.color, '#19a887');
  assert.equal(created.voice, 'alloy');
  assert.equal(created.reasoningEffort, 'high');
  assert.equal(created.model?.providerId, 'provider-example');
  const skills = to.deps.skills.list(created.id).filter((skill) => skill.botId === created.id);
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['周报整理'],
  );
  assert.notEqual(skills[0].id, saved.id);
  assert.equal(to.deps.skills.read(created.id, skills[0].id).body, '先列出本周完成的事。');
  assert.ok(existsSync(join(dirname(skills[0].source!.path), 'template.md')));
  const profile = to.persona.store.profile(created.id)!;
  assert.deepEqual(profile.traits, { E: 0.8, A: 0.4, C: 0.9, N: 0.2, O: 0.7 });
  assert.equal(profile.locked, true);
  assert.equal(profile.n, 0);
  assert.deepEqual(
    to.imported.map((entry) => entry.scope),
    ['bot:' + created.id],
  );

  // A computer without that provider, and the person leaves the memories behind.
  const bare = computer(t, []),
    plain = importBotContent(bare.deps, content, false);
  assert.equal(plain.model, undefined);
  assert.deepEqual(bare.imported, []);
});

test('a Bot file without memories carries none', (t) => {
  const from = computer(t, []),
    bot = from.store.data.bots[0],
    content = unpackBotFile(packBotFile(exportBotContent(from.deps, bot.id, false), meta));
  assert.equal(content.memories, undefined);
  assert.equal(content.model, undefined);
});

const base: BotFileContent = { name: '助手', soul: '# SOUL.md', palette: { color: '#268bfa' }, skills: [] };
const manifest = (bot: object, extra: object = {}) =>
  strToU8(JSON.stringify({ format: 'aelion-bot', version: 1, bot, ...extra }));

test('what a Bot file must not bring in is left out', () => {
  const skill = strToU8('---\nname: demo\ndescription: A demo skill\n---\n\nBody');
  const content = unpackBotFile(
    zipSync({
      'bot.json': manifest({ name: '  助手  ', color: 'not-a-colour', voice: 'a\u0001b', model: { provider: 1 } }),
      'SOUL.md': strToU8('soul'),
      'skills/demo/SKILL.md': skill,
      'skills/demo/notes/ok.md': strToU8('ok'),
      'skills/demo/.env': strToU8('TOKEN=1'),
      'skills/demo/keys/server.pem': strToU8('key'),
      'skills/demo/../../outside.md': strToU8('escape'),
      'skills/demo/a\\b.md': strToU8('backslash'),
      'skills/demo/node_modules/x.js': strToU8('dependency'),
      'skills/../evil/SKILL.md': skill,
      'skills/no-manifest/readme.md': strToU8('no SKILL.md'),
      'skills/broken/SKILL.md': strToU8('no front matter'),
      '../outside.txt': strToU8('escape'),
      'memories.json': strToU8('{"format":"something-else"}'),
    }),
  );
  assert.equal(content.name, '助手');
  assert.deepEqual(content.palette, { color: '#8b6bea' });
  assert.equal(content.voice, undefined);
  assert.equal(content.model, undefined);
  assert.equal(content.memories, undefined);
  assert.deepEqual(
    content.skills.map((item) => [item.folder, item.files.map((file) => file.path).sort()]),
    [['demo', ['SKILL.md', 'notes/ok.md']]],
  );
});

test('files that are not Bot files are refused', () => {
  assert.throws(() => unpackBotFile(strToU8('plain text')), rejectsWith('bot_file.invalid'));
  assert.throws(() => unpackBotFile(zipSync({ 'readme.txt': strToU8('hi') })), rejectsWith('bot_file.invalid'));
  assert.throws(
    () => unpackBotFile(zipSync({ 'bot.json': manifest({ name: '' }), 'SOUL.md': strToU8('x') })),
    rejectsWith('bot_file.invalid'),
  );
  assert.throws(
    () => unpackBotFile(zipSync({ 'bot.json': manifest({ name: 'x' }), 'SOUL.md': strToU8('长'.repeat(20001)) })),
    rejectsWith('bot_file.invalid'),
  );
  assert.throws(
    () =>
      unpackBotFile(
        zipSync({
          'bot.json': strToU8(JSON.stringify({ format: 'aelion-bot', version: 2, bot: { name: 'x' } })),
          'SOUL.md': strToU8('x'),
        }),
      ),
    rejectsWith('bot_file.newer'),
  );
  const many = Object.fromEntries(Array.from({ length: 4001 }, (_, index) => [`skills/a/f${index}.md`, strToU8('x')]));
  assert.throws(
    () => unpackBotFile(zipSync({ ...many, 'bot.json': manifest({ name: 'x' }), 'SOUL.md': strToU8('x') })),
    rejectsWith('bot_file.too_large'),
  );
  // What packBotFile writes is always readable again.
  assert.equal(unpackBotFile(packBotFile(base, meta)).name, '助手');
});

test('an imported skill drops the IDs its old Bot gave it', () => {
  const text =
    '---\nname: weekly-1a2b\ndescription: Weekly report\nmetadata:\n  aelion-id: private-abc\n' +
    '  aelion-display-name: 周报整理\n  aelion-bot-id: old-bot\n---\n\naelion-id: stays in the body\n';
  const detached = detachSkillText(text);
  assert.equal(/^\s+aelion-(id|bot-id):/m.test(detached.split('---')[1]), false);
  assert.ok(detached.includes('aelion-display-name: 周报整理'));
  assert.ok(detached.endsWith('aelion-id: stays in the body\n'));
  assert.equal(detachSkillText('no front matter'), 'no front matter');
});

test('a personality from a file is used only when its numbers make sense', () => {
  const traits = { E: 0.5, A: 0.5, C: 0.5, N: 0.5, O: 0.5 };
  assert.equal(parsePortablePersona({ traits: { ...traits, E: 2 } }), undefined);
  assert.equal(parsePortablePersona({ traits: { E: 0.5 } }), undefined);
  assert.equal(parsePortablePersona('persona'), undefined);
  assert.deepEqual(
    parsePortablePersona({
      traits,
      anchor: 'nonsense',
      preset: 'unknown',
      source: 'made-up',
      facets: { E1: 0.3, bad: 9 },
    }),
    { traits, anchor: traits, locked: false, confirmed: false, source: 'user', facets: { E1: 0.3 } },
  );
});

test('an imported Bot gets a name no Bot has yet', () => {
  assert.equal(freeBotName('助手', ['别人']), '助手');
  assert.equal(freeBotName('助手', ['助手', ' 助手 2 ']), '助手 3');
  assert.equal(freeBotName('a'.repeat(80), ['a'.repeat(80)]).length, 80);
});

test('reading a Bot file back keeps the SOUL as its own readable file', () => {
  const bytes = packBotFile({ ...base, soul: '# SOUL.md\n\n直接、可靠。' }, meta);
  assert.equal(unpackBotFile(bytes).soul, '# SOUL.md\n\n直接、可靠。');
  assert.ok(Buffer.from(bytes).includes(Buffer.from('SOUL.md')));
});

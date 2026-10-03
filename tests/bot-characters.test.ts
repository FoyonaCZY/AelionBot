import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { BOT_CHARACTERS, BOT_CHARACTER_CATEGORIES } from '../shared/chat/bot-characters';
import { displayBotPalette, normalizeBotAvatarStyle, normalizeBotPalette } from '../shared/chat/bot-colors';
import { BOT_AVATAR_PATH, botAvatarContent, botAvatarDataUrl } from '../src/bots/bot-avatar';
import { CHARACTER_ART } from '../src/bots/bot-character-art';

const wear = (id: string, color = '#5fae8f') => ({ color, avatarStyle: { kind: 'character' as const, character: id } });

test('every catalogued character has artwork, a unique id and its own accent colour', () => {
  assert.ok(BOT_CHARACTERS.length >= 30);
  assert.equal(new Set(BOT_CHARACTERS.map((item) => item.id)).size, BOT_CHARACTERS.length);
  assert.deepEqual(Object.keys(CHARACTER_ART).sort(), BOT_CHARACTERS.map((item) => item.id).sort());
  for (const item of BOT_CHARACTERS) {
    assert.match(item.color, /^#[a-f\d]{6}$/);
    assert.ok(item.category in BOT_CHARACTER_CATEGORIES);
  }
});

test('character avatars keep the face and both animated eyes, and only emit safe markup', () => {
  for (const item of BOT_CHARACTERS) {
    const svg = botAvatarContent(wear(item.id, item.color), `prefix-${item.id}`);
    assert.ok(svg.includes(BOT_AVATAR_PATH), item.id);
    assert.equal(svg.match(/class="avatar-eye"/g)?.length, 2, item.id);
    assert.ok(svg.includes('class="avatar-gaze"') && svg.includes('avatar-body'), item.id);
    // Every path made it through validation: no shape was silently dropped.
    const expected = [
      ...(CHARACTER_ART[item.id].back || []),
      ...(CHARACTER_ART[item.id].detail || []),
      ...(CHARACTER_ART[item.id].front || []),
      ...(CHARACTER_ART[item.id].props || []).flatMap((prop) => prop.shapes),
    ].length;
    assert.equal(
      svg.match(/<(path|circle|ellipse) (d|cx)=/g)!.length - 2 - 2 - (svg.includes('avatar-blush') ? 2 : 0),
      expected,
      item.id,
    );
    assert.doesNotMatch(svg, /<script|javascript:|on[a-z]+=|https?:|url\((?!#prefix-)/i, item.id);
    assert.match(botAvatarDataUrl(wear(item.id)), /^data:image\/svg\+xml,/);
  }
});

test('character styles validate against the catalogue and degrade to the plain face', () => {
  assert.deepEqual(normalizeBotAvatarStyle({ kind: 'character', character: 'panda', extra: 'dropped' }), {
    kind: 'character',
    character: 'panda',
  });
  for (const character of ['unknown', '__proto__', '', 42, '<script>'])
    assert.throws(() => normalizeBotAvatarStyle({ kind: 'character', character }), /形象/);
  // A character removed in a later version, or unknown data from elsewhere, shows the accent-coloured face.
  assert.deepEqual(displayBotPalette({ color: '#123456', avatarStyle: { kind: 'character', character: 'gone' } }), {
    color: '#123456',
  });
  const legacy = botAvatarContent(
    { color: '#123456', avatarStyle: { kind: 'character', character: 'gone' } as any },
    'x',
  );
  assert.ok(legacy.includes('fill="#123456"') && legacy.includes('fill="white"'));
});

test('a worn character survives creation and restart, and can be swapped back to a palette', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-character-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir),
    bot = store.createBot('Witch', 'character fixture', '#5FAE8F', { kind: 'character', character: 'silver-witch' });
  store.close();
  const loaded = new Store(dir);
  assert.deepEqual(loaded.bot(bot.id).avatarStyle, { kind: 'character', character: 'silver-witch' });
  assert.equal(loaded.bot(bot.id).color, '#5fae8f');
  loaded.close();
  assert.throws(() => normalizeBotPalette({ color: '#5fae8f', avatarStyle: { kind: 'character', character: 'nope' } }));
});

test('character names and categories are translated in both locale tables', () => {
  const tables = ['shared/i18n/locales/en.ts', 'shared/i18n/locales/zh-TW.ts'].map((file) =>
    readFileSync(file, 'utf8'),
  );
  for (const key of [...BOT_CHARACTERS.map((item) => item.name), ...Object.values(BOT_CHARACTER_CATEGORIES)])
    for (const table of tables) assert.match(table, new RegExp(`^ {2}'?${key}'?: '`, 'm'), key);
});

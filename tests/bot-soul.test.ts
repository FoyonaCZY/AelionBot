import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { ModelProviders } from '../electron/core/model/model-providers';
import { updateBotProfile } from '../electron/core/agent/bot-profile';
import {
  SOUL_MAX_CHARS,
  normalizeSoul,
  soulPromptBudget,
  soulPromptText,
  soulExcerpt,
  soulSummary,
} from '../shared/chat/bot-soul';
import { defaultSoul, isStarterText, soulPresets, upgradedLegacySoul } from '../shared/chat/soul-presets';
import { conversationIdentityPrompt } from '../shared/chat/user-profile';

function tempDir(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-soul-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a SOUL.md is stored verbatim apart from line endings and characters that hide text', () => {
  assert.equal(normalizeSoul('# Soul\r\n\r\nBe direct.\r\n'), '# Soul\n\nBe direct.');
  assert.equal(normalizeSoul('Be\u200b di\u202erect\u0007.'), 'Be direct.');
  // Emoji joiners and tabs are content, not concealment.
  assert.equal(normalizeSoul('-\tship 👩\u200d💻'), '-\tship 👩\u200d💻');
  assert.equal(normalizeSoul(''), '');
  assert.equal(normalizeSoul('x'.repeat(SOUL_MAX_CHARS)), 'x'.repeat(SOUL_MAX_CHARS));
  assert.equal(normalizeSoul('x'.repeat(SOUL_MAX_CHARS + 1)), undefined);
  assert.equal(normalizeSoul(42), undefined);
});

test('the summary prefers front matter description, then the first prose, skipping headings and markup', () => {
  assert.equal(
    soulSummary('---\nname: x\ndescription: "Reviews Go services"\n---\n# Soul\nBody'),
    'Reviews Go services',
  );
  const soul = '# SOUL.md — Backend\n\nYou are a **pragmatic**\nengineer.\n\n## Core\n- Ship small.\n- `Test` it.';
  assert.equal(soulSummary(soul), 'You are a pragmatic engineer.');
  assert.equal(soulExcerpt(soul), 'You are a pragmatic engineer. Ship small. Test it.');
  assert.equal(soulSummary('编写代码与测试'), '编写代码与测试');
  assert.equal(soulSummary('# Only a heading'), '');
  assert.equal(soulSummary('word '.repeat(40), 20).length, 20);
  assert.ok(soulSummary('word '.repeat(40), 20).endsWith('…'));
});

test('the prompt copy drops front matter and keeps head and tail when over the context budget', () => {
  assert.equal(soulPromptText('---\ntags: [a]\n---\n\n# Soul\nBe kind.'), '# Soul\nBe kind.');
  const soul = 'H'.repeat(6000) + 'M'.repeat(3000) + 'T'.repeat(1000),
    text = soulPromptText(soul, 4000);
  assert.ok(text.startsWith('H'.repeat(2800)));
  assert.ok(text.endsWith('T'.repeat(800)));
  assert.doesNotMatch(text, /M/);
  assert.match(text, /保留 2800\+800 \/ 10000 字符/);
  assert.equal(soulPromptBudget(8000), 4000);
  assert.equal(soulPromptBudget(32000), 8000);
  assert.equal(soulPromptBudget(1000000), SOUL_MAX_CHARS);
});

test('the SOUL leads the identity block verbatim and the app binding follows it', () => {
  const soul = '# SOUL.md\n\nYou are Hermes. Say "quite" a lot.',
    prompt = conversationIdentityPrompt({ name: '小飞', soul });
  assert.ok(prompt.startsWith(soul + '\n\n---\n你是 AI 队友'));
  assert.match(prompt, /你的名字："小飞"/);
  assert.match(prompt, /以后者为准/);
  // An empty soul adds nothing, like an empty SOUL.md in Hermes.
  const bare = conversationIdentityPrompt({ name: '小飞', soul: '' });
  assert.ok(bare.startsWith('你是 AI 队友'));
  assert.doesNotMatch(bare, /SOUL/);
});

test('legacy one-line roles become the soul; only app-generated defaults get the starter soul', (t) => {
  const dir = tempDir(t);
  const created = new Store(dir);
  created.close();
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const [first] = state.bots;
  delete first.soul;
  first.role = '帮助我处理办公资料与代码工作，直接执行并验证成果。';
  state.bots.push(
    { ...first, id: 'custom', name: '猫娘', role: '陪用户聊天，语气活泼' },
    { ...first, id: 'designer', type: 'designer', role: '完成原型和可编辑演示文稿设计，遵循所选设计系统并验证成果。' },
    { ...first, id: 'empty', role: '' },
  );
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  const store = new Store(dir);
  t.after(() => store.close());
  const byId = (id: string) => store.bot(id) as { soul: string; role?: string };
  assert.equal(byId(first.id).soul, defaultSoul('general'));
  assert.equal(byId('custom').soul, '陪用户聊天，语气活泼');
  assert.equal(byId('designer').soul, defaultSoul('designer'));
  assert.equal(byId('empty').soul, '');
  for (const bot of store.data.bots) assert.equal('role' in bot, false);
});

test('a fresh install seeds the starter soul and profile updates reject an oversized soul', (t) => {
  const store = new Store(tempDir(t));
  const providers = new ModelProviders(store, { encrypt: (value) => value, decrypt: (value) => value });
  t.after(() => {
    providers.dispose();
    store.close();
  });
  const [bot] = store.data.bots;
  assert.equal(bot.soul, defaultSoul('general'));
  assert.throws(
    () => updateBotProfile(store, providers, { id: bot.id, name: bot.name, soul: 'x'.repeat(SOUL_MAX_CHARS + 1) }),
    /无效资料/,
  );
  updateBotProfile(store, providers, { id: bot.id, name: bot.name, soul: '# Mine\r\nBe brief.' });
  assert.equal(store.bot(bot.id).soul, '# Mine\nBe brief.');
  assert.throws(() => store.createBot('Too long', 'x'.repeat(SOUL_MAX_CHARS + 1)));
});

test('every language offers the same presets, each a real SOUL.md with a usable summary', () => {
  for (const type of ['general', 'designer'] as const) {
    const ids = soulPresets(type, 'zh-CN').map((preset) => preset.id);
    for (const language of ['zh-CN', 'zh-TW', 'en'] as const) {
      const presets = soulPresets(type, language);
      assert.deepEqual(
        presets.map((preset) => preset.id),
        ids,
      );
      for (const preset of presets) {
        assert.equal(normalizeSoul(preset.soul), preset.soul, preset.name);
        assert.match(preset.soul, /^# SOUL\.md/);
        assert.ok(soulSummary(preset.soul).length > 10, preset.name);
        assert.ok(isStarterText(preset.soul) && isStarterText(preset.name));
      }
      assert.ok(isStarterText(defaultSoul(type, language)));
      assert.ok(soulSummary(defaultSoul(type, language)).length > 10);
    }
  }
  assert.equal(isStarterText('my own soul'), false);
  assert.equal(upgradedLegacySoul('my own soul'), undefined);
  assert.equal(
    upgradedLegacySoul('Complete office and coding tasks using the work computer, then verify the result.'),
    defaultSoul('general', 'en'),
  );
});

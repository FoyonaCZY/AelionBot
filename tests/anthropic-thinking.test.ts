import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicReasoning, claudeModel } from '../electron/core/model/anthropic-thinking';
import { protocolRequest } from '../electron/core/model/model-protocol';
import type { ModelConfig } from '../shared/types/core';

test('Claude model ids resolve to a generation without reading date suffixes as versions', () => {
  assert.deepEqual(claudeModel('claude-opus-4-20250514'), { family: 'opus', version: 400 });
  assert.deepEqual(claudeModel('claude-opus-4-5-20251101'), { family: 'opus', version: 405 });
  assert.deepEqual(claudeModel('anthropic.claude-sonnet-4-6-v1:0'), { family: 'sonnet', version: 406 });
  assert.deepEqual(claudeModel('claude-opus-4.7'), { family: 'opus', version: 407 });
  assert.deepEqual(claudeModel('claude-opus-5-5'), { family: 'opus', version: 505 });
  assert.deepEqual(claudeModel('claude-mythos-preview'), { family: 'mythos', version: 500 });
  for (const model of ['claude-x', 'claude-3-7-sonnet-20250219', 'gpt-5', 'claude-opus'])
    assert.equal(claudeModel(model), undefined, model);
});

test('reasoning effort maps to output_config.effort with adaptive thinking on 4.6+', () => {
  const opus55 = anthropicReasoning({ model: 'claude-opus-5-5', reasoningEffort: 'high' }, 8192);
  assert.deepEqual(opus55, { thinking: { type: 'adaptive' }, effort: 'high', dropTemperature: true });
  // OpenAI-only presets and levels a model lacks are clamped instead of failing the request.
  assert.equal(anthropicReasoning({ model: 'claude-sonnet-5', reasoningEffort: 'minimal' }, 8192).effort, 'low');
  assert.equal(anthropicReasoning({ model: 'claude-sonnet-4-6', reasoningEffort: 'xhigh' }, 8192).effort, 'high');
  assert.equal(anthropicReasoning({ model: 'claude-opus-4-5-20251101', reasoningEffort: 'max' }, 8192).effort, 'high');
  // Models without effort support never receive it.
  const haiku = anthropicReasoning({ model: 'claude-haiku-4-5-20251001', reasoningEffort: 'high' }, 8192);
  assert.deepEqual(haiku, { thinking: undefined, effort: undefined, dropTemperature: false });
  // Without an explicit setting nothing is sent, so each model keeps its own default.
  assert.deepEqual(anthropicReasoning({ model: 'claude-opus-4-8' }, 8192), {
    thinking: undefined,
    effort: undefined,
    dropTemperature: true,
  });
});

test('a thinking budget stays manual where supported and becomes adaptive on 4.7+', () => {
  assert.deepEqual(anthropicReasoning({ model: 'claude-sonnet-4-5-20250929', thinkingBudget: 8000 }, 8192).thinking, {
    type: 'enabled',
    budget_tokens: 4096,
  });
  assert.deepEqual(anthropicReasoning({ model: 'claude-opus-4-7', thinkingBudget: 8000 }, 8192).thinking, {
    type: 'adaptive',
  });
  // Too little output room for thinking: no thinking is forced on.
  assert.equal(anthropicReasoning({ model: 'claude-opus-4-7', thinkingBudget: 8000 }, 1500).thinking, undefined);
});

test('Anthropic requests carry effort and drop temperature on models that reject it', () => {
  const config = {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-opus-5-5',
    contextTokens: 200000,
    protocol: 'anthropic',
    reasoningEffort: 'xhigh',
    thinkingBudget: 32000,
    temperature: 0.2,
  } as ModelConfig;
  const body = protocolRequest(config, [{ role: 'user', content: 'hi' }], [], 8192, 'key', () => '').body as any;
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
  assert.equal(body.temperature, undefined);
  // Unrecognized gateway model ids pass the effort through unchanged.
  const alias = protocolRequest(
    { ...config, model: 'my-claude-alias', reasoningEffort: 'medium', thinkingBudget: undefined },
    [{ role: 'user', content: 'hi' }],
    [],
    8192,
    'key',
    () => '',
  ).body as any;
  assert.deepEqual(alias.output_config, { effort: 'medium' });
  assert.equal(alias.thinking, undefined);
  assert.equal(alias.temperature, 0.2);
});

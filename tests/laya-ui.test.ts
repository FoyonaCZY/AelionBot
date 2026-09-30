import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupDecisionSetting } from '../src/group/GroupDecisionSetting';
import { setActiveLanguage, translateFor } from '../shared/i18n';
import type { LayaFeatureState } from '../shared/types/laya-types';

test('decision settings render English across download and runtime states', () => {
  setActiveLanguage('en');
  try {
    const base: LayaFeatureState = {
      phase: 'not-installed',
      enabled: false,
      installed: [],
      recommended: 'mlx',
      supported: true,
    };
    const render = (state: Partial<LayaFeatureState>) =>
      renderToStaticMarkup(createElement(GroupDecisionSetting, { laya: { ...base, ...state } }));
    const initial = render({});
    assert.match(initial, /Experiment · Decision model/);
    assert.match(initial, /Download and enable/);
    for (const state of [
      {},
      { supported: false },
      ...(['preparing', 'installing', 'loading', 'cancelling'] as const).map((phase) => ({
        phase,
        downloading: 'mlx' as const,
      })),
      { phase: 'ready' as const, active: 'mlx' as const, installed: ['mlx' as const], enabled: true },
      {
        phase: 'error' as const,
        active: 'standard' as const,
        installed: ['standard' as const],
        enabled: true,
        error: '决策模型已停止运行',
      },
      { phase: 'disabled' as const, installed: ['mlx' as const] },
    ])
      assert.doesNotMatch(render(state), /[一-鿿]/);
    for (const label of ['各 Bot 的回应判断', '判断中', '不回应', '回应', '等被点名的先答', '已限流']) {
      assert.notEqual(translateFor('en', label), label);
      assert.ok(translateFor('zh-TW', label));
    }
  } finally {
    setActiveLanguage('zh-CN');
  }
});

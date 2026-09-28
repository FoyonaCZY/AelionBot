import type { ModelConfig } from '../../../shared/types/core';

// Thinking and effort support differ by Claude generation:
// - 4.6+ accept thinking {type:'adaptive'} and output_config.effort.
// - 4.7+ reject thinking {type:'enabled', budget_tokens} and any non-default temperature/top_p/top_k.
// - Opus 4.5 is the only earlier model with effort; other 4.5-and-earlier models only take budget_tokens.
// Model ids the table doesn't recognize (gateway aliases, other vendors) keep the legacy mapping.
interface ClaudeModel {
  family: string;
  // major * 100 + minor, so 4.10 sorts after 4.9.
  version: number;
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function claudeModel(model: string): ClaudeModel | undefined {
  // Matches claude-opus-4-5-20251101, anthropic.claude-sonnet-4-6, claude-opus-4.6 and claude-fable-5-1.
  // A minor version is one or two digits; the 8-digit date suffix is never read as one.
  const match = /claude-(opus|sonnet|haiku|fable|mythos)(?:-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?)?(?![\d.])/i.exec(model);
  if (!match) return undefined;
  const family = match[1].toLowerCase();
  // Fable and Mythos shipped with adaptive-only thinking; an unversioned alias is at least that generation.
  if (!match[2]) return ['fable', 'mythos'].includes(family) ? { family, version: 500 } : undefined;
  return { family, version: Number(match[2]) * 100 + Number(match[3] || 0) };
}

function effortFor(value: string | undefined, claude: ClaudeModel | undefined) {
  const effort = value?.trim().toLowerCase();
  if (!effort) return undefined;
  // OpenAI-style presets have no Anthropic equivalent below low.
  const mapped = ['none', 'minimal'].includes(effort) ? 'low' : effort;
  if (!claude) return EFFORTS.includes(mapped) ? mapped : value!.trim();
  const opus45 = claude.family === 'opus' && claude.version === 405;
  if (claude.version < 406 && !opus45) return undefined;
  if (!EFFORTS.includes(mapped)) return value!.trim();
  if (mapped === 'xhigh' && claude.version < 407) return 'high';
  if (mapped === 'max' && opus45) return 'high';
  return mapped;
}

export function anthropicReasoning(
  cfg: Pick<ModelConfig, 'model' | 'reasoningEffort' | 'thinkingBudget'>,
  output: number,
) {
  const claude = claudeModel(cfg.model),
    effort = effortFor(cfg.reasoningEffort, claude),
    // Thinking may use at most half of the output so text and tool calls are never starved; the API requires at least 1024.
    budget = cfg.thinkingBudget ? Math.min(cfg.thinkingBudget, Math.floor(output / 2)) : 0,
    manual = budget >= 1024 && (!claude || claude.version < 407),
    adaptive = !manual && Boolean(claude && claude.version >= 406 && (effort || budget >= 1024));
  return {
    thinking: manual ? { type: 'enabled', budget_tokens: budget } : adaptive ? { type: 'adaptive' } : undefined,
    effort,
    // Thinking rejects a custom temperature; 4.7+ reject one on every request.
    dropTemperature: manual || adaptive || Boolean(claude && claude.version >= 407),
  };
}

import { AppError } from '../errors';
const REASONING_PRESETS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// Anthropic output_config.effort levels; which ones a model accepts is resolved when the request is built.
const ANTHROPIC_EFFORT_PRESETS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Protocols that expose a reasoning-effort setting; Gemini uses a thinking budget instead.
export const REASONING_PROTOCOLS = ['chat', 'responses', 'anthropic'];
export function reasoningPresets(protocol: string | undefined) {
  return protocol === 'anthropic' ? ANTHROPIC_EFFORT_PRESETS : REASONING_PRESETS;
}
export function reasoningEffort(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value))
    throw new AppError('model.reasoning_effort_invalid', '推理强度需要 80 字符以内的文本');
  return value.trim() || undefined;
}

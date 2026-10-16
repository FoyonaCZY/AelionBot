import { personaCallOptions } from '../core/persona/persona-call';
import type { IpcContext } from './context';
import type { PersonaUpdate } from '../../shared/types/persona-types';
import { isGameMbti } from '../../shared/games/game-personality';

export function registerPersona(ctx: IpcContext) {
  const { handle } = ctx;
  const bot = (id: unknown) => {
    const b = ctx.store.data.bots.find((x) => x.id === id);
    if (!b) throw Error('Bot 不存在');
    return b;
  };
  const service = () => {
    if (!ctx.persona) throw Error('人格服务未启动');
    return ctx.persona;
  };
  // Only the 16 game types are accepted as a draft source; anything else falls back to the neutral draft.
  const preset = (mbti: unknown) => (isGameMbti(mbti) ? mbti : undefined);
  handle('personaProfile', (input) => service().view(bot(input?.botId).id, preset(input?.mbti)));
  handle('updatePersona', async (input: PersonaUpdate) => {
    const b = bot(input?.botId),
      persona = service();
    const mbti = preset(input.mbti);
    if (input.action === 'set') return persona.setTraits(b.id, input.traits);
    if (input.action === 'confirm') return persona.confirm(b.id, mbti);
    if (input.action === 'lock') return persona.setLocked(b.id, input.locked === true, mbti);
    if (input.action === 'reset') return persona.resetGrowth(b.id);
    if (input.action === 'reviewGrowth') {
      persona.requestGrowthReview(b.id);
      return persona.view(b.id, mbti);
    }
    if (input.action === 'undoGrowthReview') {
      if (typeof input.reviewId !== 'string') throw Error('成长评估编号无效');
      return persona.undoGrowthReview(b.id, input.reviewId);
    }
    if (input.action === 'preset') {
      const focus = typeof input.focus === 'string' ? input.focus : undefined;
      if (focus && focus !== 'user' && !ctx.store.data.bots.some((x) => x.id === focus)) throw Error('对象不存在');
      return persona.applyPreset(b.id, typeof input.preset === 'string' ? input.preset : '', focus);
    }
    if (input.action === 'draft')
      return persona.draft(b.id, b.name, b.soul, async (system, user) => {
        const result = await ctx.model.complete(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          [],
          new AbortController().signal,
          undefined,
          personaCallOptions(b.id, 'persona_birth'),
        );
        return result.content || '';
      });
    throw Error('未知的人格操作');
  });
}

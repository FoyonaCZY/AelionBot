import type { BotUpdateInput } from '../../../shared/types/core';
import { normalizeBotPalette } from '../../../shared/chat/bot-colors';
import type { ModelProviders } from '../model/model-providers';
import type { Store } from '../storage/store';
import { reasoningEffort as cleanReasoning } from '../../../shared/chat/reasoning';
import { AppError } from '../../../shared/errors';
import { normalizeSoul } from '../../../shared/chat/bot-soul';

export function updateBotProfile(
  store: Store,
  providers: ModelProviders,
  input: BotUpdateInput,
  beforeModelChange: (botId: string) => void = () => {},
) {
  const bot = store.bot(String(input?.id)),
    soul = normalizeSoul(input.soul);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || soul === undefined)
    throw new AppError('bot.profile_invalid', '无效资料');
  const palette =
    input.color !== undefined || input.avatarStyle !== undefined
      ? normalizeBotPalette({
          color: input.color === undefined ? bot.color : input.color,
          avatarStyle: input.avatarStyle === undefined ? bot.avatarStyle : input.avatarStyle,
        })
      : undefined;
  const model = input.model === undefined ? bot.model : providers.selection(input.model);
  const imageModel =
    input.imageModel === undefined
      ? bot.imageModel
      : input.imageModel === null
        ? undefined
        : providers.selection(input.imageModel);
  const reasoningEffort =
    input.reasoningEffort === undefined ? bot.reasoningEffort : cleanReasoning(input.reasoningEffort);
  const modelChanged =
    bot.model?.providerId !== model?.providerId ||
    bot.model?.model !== model?.model ||
    bot.model?.contextTokens !== model?.contextTokens ||
    reasoningEffort !== bot.reasoningEffort;
  if (modelChanged) beforeModelChange(bot.id);
  // A rejected model change must not leave a partially updated profile. A retired `type` stays as saved.
  store.replaceData({
    ...store.data,
    bots: store.data.bots.map((item) => {
      if (item.id !== bot.id) return item;
      const updated = {
        ...item,
        name: input.name.trim(),
        soul,
        model,
        reasoningEffort,
        ...(palette ? { color: palette.color, avatarStyle: palette.avatarStyle } : {}),
      };
      if (imageModel) updated.imageModel = imageModel;
      else delete updated.imageModel;
      return updated;
    }),
  });
  return modelChanged;
}

import React, { useContext, useId, useMemo } from 'react';
import type { Bot } from '../../shared/types/core';
import { botAvatarContent } from '../bots/bot-avatar';
import { BotAvatarContext } from '../bots/BotAvatarContext';
import type { BotActivity } from '../bots/bot-activity';
import { translate } from '../i18n';
import '../bots/avatar.css';

export function Avatar({
  bot,
  size = 44,
  activity = 'idle',
}: {
  bot: Pick<Bot, 'name' | 'color' | 'avatarStyle'> & { id?: string };
  size?: number;
  activity?: BotActivity;
}) {
  const id = useId(),
    palette = useContext(BotAvatarContext).get(bot.id || '') || bot;
  const markup = botAvatarContent(palette, id),
    content = useMemo(() => ({ __html: markup }), [markup]);
  let phase = 0;
  for (const letter of bot.id || bot.name) phase = (phase * 31 + letter.charCodeAt(0)) >>> 0;
  const label = translate({ idle: '', thinking: '正在思考', working: '正在工作', waiting: '等待你处理' }[activity]);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 60 60"
      className="avatar"
      role="img"
      data-activity={activity}
      style={{ '--avatar-motion-delay': `-${phase % 2400}ms` } as React.CSSProperties}
      aria-label={label ? `${bot.name}，${label}` : bot.name}
      dangerouslySetInnerHTML={content}
    />
  );
}

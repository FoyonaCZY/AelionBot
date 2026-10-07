import React, { memo, useContext, useId, useMemo } from 'react';
import type { Bot } from '../../shared/types/core';
import { botAvatarLayers, type AvatarProp } from '../bots/bot-avatar';
import { BotAvatarContext } from '../bots/BotAvatarContext';
import type { BotActivity } from '../bots/bot-activity';
import { translate } from '../i18n';
import '../bots/avatar.css';

/** A position in the 60×60 avatar box as a percentage of the avatar, for transform origins. */
const percent = (value: number) => `${Math.round((value / 60) * 10000) / 100}%`;

/** One part of the avatar: its own <svg> filling the avatar box, so it can move without the page laying out. */
function Layer({
  className = '',
  markup,
  origin,
  motion,
}: {
  className?: string;
  markup: string;
  origin?: [number, number];
  motion?: string;
}) {
  return (
    <svg
      className={`avatar-layer ${className}`}
      viewBox="0 0 60 60"
      aria-hidden="true"
      focusable="false"
      data-motion={motion}
      style={origin && { transformOrigin: `${percent(origin[0])} ${percent(origin[1])}` }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
const Prop = ({ prop }: { prop: AvatarProp }) => (
  <Layer
    className={`avatar-prop${prop.busyOnly ? ' avatar-prop-busy' : ''}`}
    markup={prop.markup}
    origin={prop.origin}
    motion={prop.motion}
  />
);

/**
 * A Bot's avatar. The parts that move (halo, body, gaze, eyes, props) are HTML layers each holding an <svg>, so their
 * animations run on the compositor: animating a group inside one <svg> laid the whole page out on every frame.
 */
export const Avatar = memo(function Avatar({
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
  const styleKey = JSON.stringify(palette.avatarStyle ?? null),
    layers = useMemo(() => botAvatarLayers(palette, id), [palette.color, styleKey, id]);
  let phase = 0;
  for (const letter of bot.id || bot.name) phase = (phase * 31 + letter.charCodeAt(0)) >>> 0;
  const label = translate({ idle: '', thinking: '正在思考', working: '正在工作', waiting: '等待你处理' }[activity]);
  return (
    <span
      className="avatar"
      role="img"
      data-activity={activity}
      style={{ '--avatar-size': `${size}px`, '--avatar-motion-delay': `-${phase % 2400}ms` } as React.CSSProperties}
      aria-label={label ? `${bot.name}，${label}` : bot.name}
    >
      <Layer className="avatar-halo" markup={`<circle ${layers.halo}/>`} />
      <span className={`avatar-body${layers.character ? ' avatar-character' : ''}`}>
        {layers.back && <Layer markup={layers.back} />}
        {layers.props
          .filter((prop) => prop.layer === 'back')
          .map((prop, index) => (
            <Prop key={'back' + index} prop={prop} />
          ))}
        <Layer markup={layers.defs + layers.face} />
        <span className="avatar-gaze">
          {layers.eyes.map((eye) => (
            <Layer key={eye.x} className="avatar-eye" markup={eye.markup} origin={[eye.x, eye.y]} />
          ))}
        </span>
        {layers.front && <Layer markup={layers.front} />}
        {layers.props
          .filter((prop) => prop.layer === 'front')
          .map((prop, index) => (
            <Prop key={'front' + index} prop={prop} />
          ))}
      </span>
    </span>
  );
});

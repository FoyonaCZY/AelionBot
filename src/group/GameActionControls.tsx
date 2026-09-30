import { useEffect, useRef, useState } from 'react';
import type { GameRequest, GameView, GameAction } from '../../shared/types/game-types';
import { ACTION_NAMES } from '../../shared/games/game-boards';
import { translate } from '../../shared/i18n';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { personalClues, seatNumber } from './game-view-model';

const SPEECH = ['speak', 'wolf_plan', 'campaign', 'pk_speak', 'last_words'];
const HINTS: Partial<Record<GameRequest['kind'], string>> = {
  inspect: '结果只有你能看到',
  kill: '狼队多数刀口优先，平票按座位序',
  guard: '不能连续两夜守同一人',
  vote: '可以弃票',
  sheriff_vote: '警上玩家不能投票',
  badge: '可以移交给仍有投票权的存活玩家，或撕毁',
  shoot: '被毒时不能开枪',
  last_words: '说给全场听，结束后不能再发言',
  wolf_plan: '仅狼队可见',
};

/** Every seat as an avatar tile; seats outside the request's targets stay visible but disabled. */
function TargetGrid({
  game,
  targets,
  value,
  busy,
  onPick,
}: {
  game: GameView;
  targets: string[];
  value: string;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <div className="gg-targets" role="radiogroup">
      {game.seats.map((seat, index) => {
        const allowed = targets.includes(seat.id);
        return (
          <button
            key={seat.id}
            type="button"
            role="radio"
            aria-checked={value === seat.id}
            disabled={busy || !allowed}
            className={value === seat.id ? 'is-selected' : undefined}
            onClick={() => onPick(seat.id)}
            aria-label={translate('{seat} 号 {name}', { seat: index + 1, name: seat.name })}
          >
            <span className="gg-tile-number">{index + 1}</span>
            {seat.human ? (
              <span className="gg-human-avatar" style={{ width: 24, height: 24 }}>
                <Icon name="user" size={13} />
              </span>
            ) : (
              <Avatar bot={seat} size={24} />
            )}
            <span className="gg-tile-name">{seat.human ? translate('你') : seat.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function Choice({
  selected,
  title,
  detail,
  onSelect,
  busy,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onSelect: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      className={`gg-choice ${selected ? 'is-selected' : ''}`}
      aria-pressed={selected}
      disabled={busy}
      onClick={onSelect}
    >
      <b>{title}</b>
      <small>{detail}</small>
    </button>
  );
}

export function GameActionControls({
  request: r,
  game,
  busy,
  submit,
  timer,
}: {
  request: GameRequest;
  game: GameView;
  busy: boolean;
  submit: (a: GameAction) => Promise<void>;
  timer?: React.ReactNode;
}) {
  const [text, setText] = useState(''),
    [target, setTarget] = useState(''),
    [choice, setChoice] = useState<string>('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText('');
    setTarget('');
    setChoice('');
  }, [r.id]);
  const name = (id: string) =>
    translate('{seat} 号 {name}', {
      seat: seatNumber(game, id),
      name: game.seats[seatNumber(game, id) - 1]?.name || '',
    });
  const send = (a: GameAction) => void submit(a);
  const header = (title: string) => (
    <div className="gg-dock-head">
      <b>{title}</b>
      {HINTS[r.kind] && <small>{translate(HINTS[r.kind]!)}</small>}
      <span className="gg-spacer" />
      {timer}
    </div>
  );
  const insert = (snippet: string) => {
    const el = box.current,
      start = el?.selectionStart ?? text.length,
      end = el?.selectionEnd ?? text.length;
    setText((value) => value.slice(0, start) + snippet + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  if (SPEECH.includes(r.kind)) {
    const clues = personalClues(game).slice(-3);
    const others = game.seats.filter((p) => p.alive && p.id !== game.humanId).slice(0, 8);
    return (
      <>
        {header(translate(ACTION_NAMES[r.kind]))}
        <textarea
          ref={box}
          id="game-speech"
          className="gg-say"
          value={text}
          maxLength={800}
          aria-label={translate(ACTION_NAMES[r.kind])}
          onChange={(e) => setText(e.target.value)}
          placeholder={translate(r.kind === 'campaign' ? '说说你的身份、判断和警徽计划…' : '说说你的判断…')}
        />
        <div className="gg-chip-row gg-quick">
          {clues.map((clue) => (
            <button
              type="button"
              className="gg-chip"
              key={clue.id}
              onClick={() => insert(clue.text.replace(/^查验结果：/, ''))}
            >
              {translate('＋ 引用：{text}', { text: clue.text.replace(/^查验结果：/, '').replace(/。$/, '') })}
            </button>
          ))}
          {others.map((seat) => (
            <button
              type="button"
              className="gg-chip"
              key={seat.id}
              onClick={() => insert(translate('{seat} 号', { seat: seatNumber(game, seat.id) }))}
            >
              {translate('{seat} 号', { seat: seatNumber(game, seat.id) })}
            </button>
          ))}
        </div>
        <div className="gg-dock-actions">
          <span className="gg-muted">{translate('可以分几段发送，最多 800 字')}</span>
          <span className="gg-spacer" />
          {game.board ? (
            <>
              <button
                className="secondary-button"
                disabled={busy || !text.trim()}
                onClick={() => send({ text, endTurn: false })}
              >
                {translate('发送这段')}
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => send({ text: text.trim() || undefined, endTurn: true })}
              >
                {translate(r.kind === 'wolf_plan' ? '结束讨论' : text.trim() ? '发送并结束发言' : '结束发言')}
              </button>
            </>
          ) : (
            <button className="primary-button" disabled={busy || !text.trim()} onClick={() => send({ text })}>
              {translate('提交发言')}
            </button>
          )}
        </div>
      </>
    );
  }
  if (r.kind === 'sheriff_join' || r.kind === 'withdraw') {
    const join = r.kind === 'sheriff_join';
    return (
      <>
        {header(translate(join ? '要不要上警？' : '要不要退水？'))}
        <div className="gg-choices">
          <Choice
            busy={busy}
            selected={choice === 'stay'}
            onSelect={() => setChoice('stay')}
            title={translate(join ? '上警竞选' : '继续竞选')}
            detail={translate(join ? '参加竞选，发表竞选发言' : '留在警上，等警下投票')}
          />
          <Choice
            busy={busy}
            selected={choice === 'leave'}
            onSelect={() => setChoice('leave')}
            title={translate(join ? '不上警' : '退水')}
            detail={translate(join ? '留在警下，投票选警长' : '退出竞选，这轮不投警长票')}
          />
          <button
            className="primary-button gg-choice-confirm"
            disabled={busy || !choice}
            onClick={() => send({ choice: join ? choice === 'stay' : choice === 'leave' })}
          >
            {translate('确认')}
          </button>
        </div>
      </>
    );
  }
  if (r.kind === 'sheriff_order')
    return (
      <>
        {header(translate('选择发言方向 · 你最后发言'))}
        <div className="gg-choices">
          <Choice
            busy={busy}
            selected={choice === 'clockwise'}
            onSelect={() => setChoice('clockwise')}
            title={translate('顺时针')}
            detail={translate('从你右手边的存活座位开始')}
          />
          <Choice
            busy={busy}
            selected={choice === 'counterclockwise'}
            onSelect={() => setChoice('counterclockwise')}
            title={translate('逆时针')}
            detail={translate('从你左手边的存活座位开始')}
          />
          <button
            className="primary-button gg-choice-confirm"
            disabled={busy || !choice}
            onClick={() => send({ direction: choice as 'clockwise' | 'counterclockwise' })}
          >
            {translate('确认')}
          </button>
        </div>
      </>
    );
  if (r.kind === 'witch')
    return (
      <>
        {header(translate('女巫行动'))}
        <p className="gg-witch-victim">
          {r.witch?.victim
            ? translate('今晚被袭击：{name}', { name: name(r.witch.victim) })
            : translate('当前没有可见刀口')}
          <span className="gg-muted">
            {' · '}
            {translate('解药：{save}；毒药：{poison}', {
              save: translate(r.witch?.canSave ? '可使用' : '不可使用'),
              poison: translate(r.witch?.canPoison ? '可使用' : '已耗尽'),
            })}
          </span>
        </p>
        {r.witch?.canPoison && (
          <TargetGrid game={game} targets={r.targets} value={target} busy={busy} onPick={setTarget} />
        )}
        <div className="gg-dock-actions">
          <button className="secondary-button" disabled={busy} onClick={() => send({ potion: 'skip' })}>
            {translate('不用药')}
          </button>
          <span className="gg-spacer" />
          <button
            className="secondary-button"
            disabled={busy || !r.witch?.canSave}
            onClick={() => send({ potion: 'save' })}
          >
            {translate('使用解药')}
          </button>
          <button
            className="primary-button"
            disabled={busy || !r.witch?.canPoison || !target}
            onClick={() => send({ potion: 'poison', target })}
          >
            {target ? translate('对 {name} 用毒', { name: name(target) }) : translate('对所选玩家用毒')}
          </button>
        </div>
      </>
    );
  const optional = !!game.board && ['guard', 'badge', 'shoot', 'vote', 'sheriff_vote'].includes(r.kind);
  const skipLabel = translate(
    r.kind === 'badge' ? '撕毁警徽' : r.kind === 'shoot' ? '放弃开枪' : r.kind === 'guard' ? '空守' : '弃票',
  );
  const action = translate(ACTION_NAMES[r.kind]);
  return (
    <>
      {header(action)}
      <TargetGrid game={game} targets={r.targets} value={target} busy={busy} onPick={setTarget} />
      <div className="gg-dock-actions">
        {optional && (
          <button className="secondary-button" disabled={busy} onClick={() => send({ skip: true })}>
            {skipLabel}
          </button>
        )}
        <span className="gg-spacer" />
        <span className="gg-muted">
          {target ? translate('已选 {name}', { name: name(target) }) : translate('先选一名玩家')}
        </span>
        <button className="primary-button" disabled={busy || !target} onClick={() => send({ target })}>
          {translate('确认{action}', { action })}
        </button>
      </div>
    </>
  );
}

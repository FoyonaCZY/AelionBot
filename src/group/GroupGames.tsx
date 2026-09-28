import { BOARDS, PHASE_NAMES, TWELVE_RULES } from '../../shared/games/game-boards';
import { WerewolfTable } from './WerewolfTable';
import type { GameView } from '../../shared/types/game-types';
import { GAME_MBTI_TYPES, isGameMbti, type GameMbti } from '../../shared/games/game-personality';
import type { ModelProvider, ModelSelection } from '../../shared/types/core';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import './group-games.css';

type Member = {
  model?: ModelSelection;
  id: string;
  name: string;
  color?: string;
  avatarStyle?: import('../../shared/chat/bot-colors').BotAvatarStyle;
};
type Seat = Member & { role: string; temporary?: boolean };
import { useI18n } from '../i18n';

const guests: Member[] = [
  { id: 'guest-luna', name: '露娜', color: '#8b7da5' },
  { id: 'guest-ash', name: '阿什', color: '#b28b64' },
  { id: 'guest-moss', name: '小苔', color: '#728f78' },
  { id: 'guest-noah', name: '诺亚', color: '#718ba0' },
  { id: 'guest-echo', name: '回声', color: '#ad7c8d' },
  { id: 'guest-orion', name: '奥里', color: '#838b68' },
  { id: 'guest-river', name: '川', color: '#638d9b' },
  { id: 'guest-summer', name: '夏', color: '#a38869' },
  { id: 'guest-rain', name: '小雨', color: '#6e879f' },
  { id: 'guest-lin', name: '林', color: '#648578' },
  { id: 'guest-moon', name: '月', color: '#9676a0' },
  { id: 'guest-snow', name: '小雪', color: '#8194a8' },
];
const phaseNames = PHASE_NAMES;
function Portrait({ seat }: { seat: Member }) {
  return seat.id === 'human' ? (
    <span className="gg-human-avatar">
      <Icon name="user" size={20} />
    </span>
  ) : (
    <Avatar bot={{ ...seat, color: seat.color || '#8e7ca2' }} size={32} />
  );
}
export function GroupGames({
  groupId,
  groupName: _groupName,
  members,
  initialOpen = false,
  cardContainer,
  providers = [],
  defaultModel,
}: {
  groupId: string;
  groupName: string;
  members: Member[];
  initialOpen?: boolean;
  cardContainer?: HTMLElement | null;
  providers?: ModelProvider[];
  defaultModel?: ModelSelection;
}) {
  const { t } = useI18n();
  const [board, setBoard] = useState<'standard12' | 'guard12'>('standard12');
  const storageKey = `aelion:game-prototype:v1:${groupId}`;
  const [match, setMatch] = useState<GameView | null>(null);
  const [open, setOpen] = useState(initialOpen),
    [screen, setScreen] = useState<'select' | 'presets' | 'room' | 'table'>(match ? 'table' : 'select');
  const [mode, setMode] = useState<'play' | 'watch'>('play'),
    [selected, setSelected] = useState<string[]>(members.slice(0, 11).map((m) => m.id));
  const [omniscient, setOmniscient] = useState(false),
    [saveError, setSaveError] = useState(false);
  const [filled, setFilled] = useState(false),
    [batch, setBatch] = useState(''),
    [overrides, setOverrides] = useState<Record<string, string>>({}),
    [mbtiPresets, setMbtiPresets] = useState<Record<string, GameMbti>>({}),
    [configNotice, setConfigNotice] = useState('');
  const [sessionMbti, setSessionMbti] = useState<Record<string, GameMbti | 'random'>>({});
  const resolvedMbti = (id: string) => {
    const type = sessionMbti[id];
    return type === 'random' ? undefined : type || mbtiPresets[id];
  };
  const options = providers.flatMap((p) =>
    p.models.map((m) => ({
      key: JSON.stringify([p.id, m.id]),
      label: p.name + ' / ' + m.id,
      selection: { providerId: p.id, model: m.id, contextTokens: m.contextTokens || 32768 } as ModelSelection,
    })),
  );
  const resolved = (seat: Member) =>
    options.find((o) => o.key === overrides[seat.id])?.selection || seat.model || defaultModel;
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey + ':players') || 'null');
      if (!saved) {
        setConfigNotice(t('暂无上次配置'));
        return;
      }
      if (['play', 'watch'].includes(saved.mode) && Array.isArray(saved.selected)) {
        setMode(saved.mode);
        setSelected(
          saved.selected
            .filter((id: unknown) => typeof id === 'string' && members.some((m) => m.id === id))
            .slice(0, saved.mode === 'play' ? 11 : 12),
        );
        setFilled(saved.filled === true);
      }
      const next: Record<string, string> = {};
      for (const [id, key] of Object.entries(saved.overrides || {}))
        if (typeof key === 'string' && options.some((o) => o.key === key)) next[id] = key;
      setOverrides(next);
      const personalities: Record<string, GameMbti> = {};
      for (const [id, type] of Object.entries(saved.mbtiPresets || {})) if (isGameMbti(type)) personalities[id] = type;
      setMbtiPresets(personalities);
      const session: Record<string, GameMbti | 'random'> = {};
      for (const [id, type] of Object.entries(saved.sessionMbti || {}))
        if (type === 'random' || isGameMbti(type)) session[id] = type;
      setSessionMbti(session);
      setConfigNotice(t('已恢复上次玩家配置'));
    } catch {
      setConfigNotice(t('无法读取上次配置'));
    }
  }
  const [starting, setStarting] = useState(false),
    [gameError, setGameError] = useState(''),
    [readError, setReadError] = useState('');
  const epoch = useRef(0);
  const mutationStart = () => {
    epoch.current++;
  };
  const updateMatch = (next: GameView) => {
    epoch.current++;
    setMatch((previous) =>
      previous?.id === next.id && (previous.revision || 0) > (next.revision || 0) ? previous : next,
    );
  };
  useEffect(() => {
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const version = epoch.current;
      try {
        const next = await window.aelion.games.read({ groupId, omniscient });
        if (live && version === epoch.current) {
          setMatch((previous) =>
            previous && next && previous.id === next.id && (previous.revision || 0) > (next.revision || 0)
              ? previous
              : next,
          );
          setReadError('');
        }
      } catch (e) {
        if (live && version === epoch.current) setReadError((e as Error).message);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [groupId, omniscient]);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (initialOpen) setOpen(true);
  }, [initialOpen]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey + ':players') || 'null');
      const personalities: Record<string, GameMbti> = {};
      for (const [id, type] of Object.entries(saved?.mbtiPresets || {})) if (isGameMbti(type)) personalities[id] = type;
      setMbtiPresets(personalities);
    } catch {}
  }, [storageKey]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current?.close();
  }, [open]);

  const limit = mode === 'play' ? 11 : 12;
  const chosen = members.filter((m) => selected.includes(m.id)).slice(0, limit);
  const roster: Seat[] = [
    ...(mode === 'play' ? [{ id: 'human', name: '你', color: '#9177ac', role: '村民' }] : []),
    ...chosen.map((m) => ({ ...m, role: '' })),
    ...guests.slice(0, filled ? limit - chosen.length : 0).map((m) => ({ ...m, temporary: true, role: '' })),
  ];
  const personalityPicker = (s: Member) => (
    <select
      aria-label={t('{name} 的本局性格', { name: s.name })}
      value={sessionMbti[s.id] || ''}
      onChange={(e) => {
        const type = e.target.value;
        setSessionMbti((current) => {
          const next = { ...current };
          if (type === 'random' || isGameMbti(type)) next[s.id] = type;
          else delete next[s.id];
          return next;
        });
      }}
    >
      <option value="">{mbtiPresets[s.id] ? t('预设 {value}', { value: mbtiPresets[s.id] }) : t('预设 · 随机')}</option>
      <option value="random">{t('开局随机')}</option>
      {GAME_MBTI_TYPES.map((type) => (
        <option key={type} value={type}>
          {type}
        </option>
      ))}
    </select>
  );
  function savePresets(next = mbtiPresets) {
    setMbtiPresets(next);
    try {
      const previous = JSON.parse(localStorage.getItem(storageKey + ':players') || '{}');
      localStorage.setItem(storageKey + ':players', JSON.stringify({ ...previous, mbtiPresets: next }));
      setConfigNotice(t('AI 游戏预设已保存'));
    } catch {
      setSaveError(true);
    }
  }
  function randomizePresets() {
    const types = [...GAME_MBTI_TYPES].sort(() => Math.random() - 0.5),
      bots = [...members, ...guests],
      next = { ...mbtiPresets };
    bots.forEach((bot, i) => (next[bot.id] = types[i % types.length]));
    savePresets(next);
  }
  async function start() {
    if (starting || roster.length !== 12) return;
    setStarting(true);
    mutationStart();
    setGameError('');
    try {
      const next = await window.aelion.games.create({
        groupId,
        board,
        players: roster.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color || '#8e7ca2',
          human: p.id === 'human',
          model: p.id === 'human' ? undefined : resolved(p),
          mbti: p.id === 'human' ? undefined : resolvedMbti(p.id),
        })),
      });
      updateMatch(next);
      try {
        localStorage.setItem(
          storageKey + ':players',
          JSON.stringify({ mode, selected, filled, overrides, mbtiPresets, sessionMbti }),
        );
      } catch {
        setSaveError(true);
      }
      setScreen('table');
      setOmniscient(false);
    } catch (e) {
      setGameError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }
  function enter() {
    setScreen(match ? 'table' : 'select');
    setOpen(true);
  }
  return (
    <div className="gg-host">
      <div className="gg-launch-row">
        <button
          className="gg-entry"
          onClick={() => {
            setScreen('select');
            setOpen(true);
          }}
        >
          {t('AI 游戏')}
        </button>
      </div>
      {match &&
        cardContainer &&
        createPortal(
          <button className="gg-chat-card" onClick={enter}>
            <span className="gg-card-mark">☾</span>
            <span>
              <strong>
                {t('狼人杀')} <small>{match.status === 'finished' ? t('已结束') : t('进行中')}</small>
              </strong>
              <span>
                {t(match.humanId ? '参与' : '旁观')} ·{' '}
                {match.status === 'paused'
                  ? t('已暂停')
                  : match.phase === 'finished'
                    ? t('已结束')
                    : t(phaseNames[match.phase])}
              </span>
            </span>
            <b>{t(match.status === 'finished' ? '查看战报' : '查看对局')} ↗</b>
          </button>,
          cardContainer,
        )}
      <dialog
        ref={dialog}
        className="gg-dialog"
        data-screen={screen}
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <div className="gg-workspace">
          <header className="gg-header">
            <div>
              {screen !== 'select' && (
                <button
                  className="icon-button"
                  aria-label={t(screen === 'room' || screen === 'presets' ? '返回 AI 游戏' : '返回群聊')}
                  onClick={() => (screen === 'room' || screen === 'presets' ? setScreen('select') : setOpen(false))}
                >
                  <Icon name="arrow" size={18} />
                </button>
              )}
              <strong>
                {screen === 'select'
                  ? t('AI 游戏')
                  : screen === 'presets'
                    ? t('AI 玩家预设')
                    : screen === 'room'
                      ? t('狼人杀 · 游戏设置')
                      : t('狼人杀')}
              </strong>
            </div>
            <button className="icon-button" aria-label={t('关闭 AI 游戏')} onClick={() => setOpen(false)}>
              <Icon name="close" size={18} />
            </button>
          </header>
          {screen === 'select' && (
            <main className="gg-discovery">
              <button className="gg-game" onClick={() => setScreen('room')}>
                <span className="gg-game-icon">
                  <Icon name="message" size={22} />
                </span>
                <span>
                  <strong>{t('狼人杀')}</strong>
                  <small>{t('12 人 · 有警长')}</small>
                </span>
                <Icon name="arrow" size={16} />
              </button>
              <button className="gg-preset-entry" onClick={() => setScreen('presets')}>
                <span>{t('AI 玩家预设')}</span>
                <span>
                  {t(Object.keys(mbtiPresets).length ? '已配置' : '随机性格')} <Icon name="arrow" size={14} />
                </span>
              </button>
            </main>
          )}
          {screen === 'presets' && (
            <main className="gg-presets">
              <div className="gg-config-heading">
                <strong>{t('性格')}</strong>
                <button className="secondary-button" onClick={randomizePresets}>
                  {t('一键随机')}
                </button>
              </div>
              <div className="gg-preset-list">
                {[...members, ...guests].map((bot) => (
                  <label className="gg-personality-row" key={bot.id}>
                    <span>
                      <Portrait seat={bot} />
                      <strong>{bot.name}</strong>
                    </span>
                    <select
                      aria-label={t('{name} 的 MBTI', { name: bot.name })}
                      value={mbtiPresets[bot.id] || ''}
                      onChange={(e) => {
                        const next = { ...mbtiPresets };
                        if (isGameMbti(e.target.value)) next[bot.id] = e.target.value;
                        else delete next[bot.id];
                        savePresets(next);
                      }}
                    >
                      <option value="">{t('每局随机')}</option>
                      {GAME_MBTI_TYPES.map((type) => (
                        <option value={type} key={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {configNotice && (
                <p className="gg-muted" role="status">
                  {configNotice}
                </p>
              )}
            </main>
          )}
          {screen === 'room' && (
            <main className="gg-room">
              <label className="gg-board-picker">
                {t('板子')}
                <select
                  aria-label={t('狼人杀板子')}
                  value={board}
                  onChange={(e) => setBoard(e.target.value as typeof board)}
                >
                  {Object.entries(BOARDS).map(([id, b]) => (
                    <option value={id} key={id}>
                      {t('{name} · 12 人 · 有警长', { name: b.name })}
                    </option>
                  ))}
                </select>
              </label>
              <p className="gg-board-description">{BOARDS[board].description}</p>
              <div className="gg-members-heading">
                <h3>{t('参与者')}</h3>
              </div>
              <div className="group-member-picker gg-participants">
                <label>
                  <input
                    type="checkbox"
                    checked={mode === 'play'}
                    onChange={(e) => {
                      setMode(e.target.checked ? 'play' : 'watch');
                      if (e.target.checked) setSelected((ids) => ids.slice(0, 11));
                    }}
                  />
                  <Portrait seat={{ id: 'human', name: '你' }} />
                  <span>
                    <strong>你</strong>
                  </span>
                </label>
                {members.map((m) => (
                  <div className="gg-bot-choice" key={m.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.includes(m.id)}
                        disabled={!selected.includes(m.id) && selected.length >= limit}
                        onChange={(e) =>
                          setSelected((ids) => (e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id)))
                        }
                      />
                      <Portrait seat={m} />
                      <span>
                        <strong>{m.name}</strong>
                      </span>
                    </label>
                  </div>
                ))}
              </div>
              <div className="gg-fill-row">
                <span>
                  {t('{count} / 12 位玩家', { count: roster.length })}
                  {mode === 'watch' ? t(' · 你旁观') : ''}
                </span>
                {roster.length < 12 ? (
                  <button className="secondary-button" onClick={() => setFilled(true)}>
                    {t('一键补齐')}
                  </button>
                ) : filled && limit > chosen.length ? (
                  <button className="gg-back" onClick={() => setFilled(false)}>
                    {t('移除临时 Bot')}
                  </button>
                ) : null}
              </div>
              {filled && limit > chosen.length && (
                <div className="gg-temporary">
                  {roster
                    .filter((s) => s.temporary)
                    .map((s) => (
                      <span className="gg-bot-choice" key={s.id}>
                        <span>
                          <Portrait seat={s} />
                          {s.name}
                        </span>
                      </span>
                    ))}
                </div>
              )}
              {
                <section className="gg-player-config" aria-label={t('玩家模型配置')}>
                  <div className="gg-config-heading">
                    <strong>{t('模型与性格')}</strong>
                    <button className="gg-back" onClick={restore}>
                      {t('沿用上次配置')}
                    </button>
                  </div>
                  <div className="gg-batch">
                    <select aria-label={t('统一模型')} value={batch} onChange={(e) => setBatch(e.target.value)}>
                      <option value="">{t('选择模型')}</option>
                      {options.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="secondary-button"
                      disabled={!batch}
                      onClick={() => {
                        setOverrides((current) => ({
                          ...current,
                          ...Object.fromEntries([...members, ...guests].map((s) => [s.id, batch])),
                        }));
                        setConfigNotice(t('已应用到全部 AI，包括补位玩家'));
                      }}
                    >
                      {t('应用到全部 AI')}
                    </button>
                  </div>
                  {options.length === 0 && (
                    <p className="gg-muted">{t('请先在设置中添加模型；配置后即可开始对局。')}</p>
                  )}
                  <div className="gg-config-heading">
                    <span>{t('玩家 / 模型 / 性格')}</span>
                    <button
                      className="gg-back"
                      onClick={() => {
                        setSessionMbti((current) => ({
                          ...current,
                          ...Object.fromEntries(
                            [...members, ...guests].map((p) => [
                              p.id,
                              GAME_MBTI_TYPES[Math.floor(Math.random() * GAME_MBTI_TYPES.length)],
                            ]),
                          ),
                        }));
                        setConfigNotice(t('已随机本局性格，包括补位玩家'));
                      }}
                    >
                      {t('随机本局性格')}
                    </button>
                  </div>
                  {roster
                    .filter((s) => s.id !== 'human')
                    .map((s) => (
                      <div className="gg-model-row" key={s.id}>
                        <span>{s.name}</span>
                        <select
                          aria-label={t('{name} 的本局模型', { name: s.name })}
                          value={options.some((o) => o.key === overrides[s.id]) ? overrides[s.id] : ''}
                          onChange={(e) => setOverrides((v) => ({ ...v, [s.id]: e.target.value }))}
                        >
                          <option value="">
                            {s.model
                              ? t('沿用 ') + s.model.model
                              : defaultModel
                                ? t('默认 ') + defaultModel.model
                                : t('未配置模型')}
                          </option>
                          {options.map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {personalityPicker(s)}
                      </div>
                    ))}
                  <p className="gg-config-note">{t('仅用于本局，不修改 AI 玩家预设。')}</p>
                  {configNotice && (
                    <p className="gg-muted" role="status">
                      {configNotice}
                    </p>
                  )}
                </section>
              }
              <details className="gg-rule-details">
                <summary>{t('规则')}</summary>
                <p>{TWELVE_RULES}</p>
              </details>
              {(gameError || readError) && (
                <p role="alert" className="group-error">
                  {gameError || readError}
                </p>
              )}
              {match && match.status !== 'finished' && (
                <button className="secondary-button" onClick={() => setScreen('table')}>
                  {t('返回当前对局')}
                </button>
              )}
              <footer className="gg-room-footer">
                <button className="secondary-button" onClick={() => setScreen('select')}>
                  {t('返回')}
                </button>
                <button
                  className="primary-button"
                  disabled={starting || roster.length !== 12 || (!!match && match.status !== 'finished')}
                  onClick={() => void start()}
                >
                  {t(mode === 'play' ? '开始游戏' : '开始全 AI 对局')}
                </button>
              </footer>
            </main>
          )}
          {screen === 'table' && match && (
            <WerewolfTable
              game={match}
              onUpdate={updateMatch}
              onMutationStart={mutationStart}
              syncError={readError}
              omniscient={omniscient}
              onOmniscient={() => setOmniscient((v) => !v)}
              onClose={() => setOpen(false)}
            />
          )}
          {saveError && (
            <div className="gg-storage-warning" role="alert">
              {t('玩家配置未能保存，下次需要重新选择。')}
            </div>
          )}
        </div>
      </dialog>
    </div>
  );
}

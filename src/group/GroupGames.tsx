import { BOARDS, PHASE_NAMES, TWELVE_RULES } from '../../shared/games/game-boards';
import { WerewolfTable } from './WerewolfTable';
import { syncSeats } from './game-view-model';
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
/** Four temperament groups used to colour MBTI types: analysts, diplomats, sentinels, explorers. */
const temperament = (type: string) =>
  type[1] === 'N' ? (type[2] === 'T' ? 'nt' : 'nf') : type[3] === 'J' ? 'sj' : 'sp';
const TEMPERAMENT_NOTES = {
  nt: '分析型：重逻辑和推理，爱拆解别人的说法',
  nf: '外交型：重直觉和关系，容易带动情绪站边',
  sj: '守护型：按事实和票型走，结论稳健保守',
  sp: '探险型：临场反应快，敢冒险也敢改口',
} as const;
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
  // Selection is seeded once on mount; Bots invited to the group afterwards take a free seat instead of being left out.
  const memberIds = members.map((m) => m.id).join('\n'),
    knownMembers = useRef(new Set(members.map((m) => m.id)));
  useEffect(() => {
    const ids = memberIds ? memberIds.split('\n') : [],
      joined = ids.filter((id) => !knownMembers.current.has(id));
    knownMembers.current = new Set(ids);
    setSelected((current) => syncSeats(current, ids, joined, mode === 'play' ? 11 : 12));
  }, [memberIds, mode]);
  // The last match stays readable after it ends; its chat card only shows until that report has been viewed once.
  const [seenReport, setSeenReport] = useState(() => {
    try {
      return localStorage.getItem(storageKey + ':seen-report') || '';
    } catch {
      return '';
    }
  });
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
    if (!open || screen !== 'table' || match?.status !== 'finished' || seenReport === match.id) return;
    setSeenReport(match.id);
    try {
      localStorage.setItem(storageKey + ':seen-report', match.id);
    } catch {}
  }, [open, screen, match?.id, match?.status, seenReport, storageKey]);
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
  const [editing, setEditing] = useState(''),
    [adding, setAdding] = useState(false);
  const aiSeats = roster.filter((s) => s.id !== 'human'),
    unconfigured = aiSeats.filter((s) => !resolved(s)),
    unfinished = !!match && match.status !== 'finished',
    blocker = unfinished
      ? t('还有一局没结束，先结束或继续那一局')
      : roster.length !== 12
        ? t('还差 {count} 个座位', { count: 12 - roster.length })
        : unconfigured.length
          ? t('{count} 位 AI 还没有可用模型', { count: unconfigured.length })
          : '';
  const available = members.filter((m) => !selected.includes(m.id));
  const presetCount = Object.keys(mbtiPresets).length;
  const matchPhase = match
    ? match.status === 'paused'
      ? t('已暂停')
      : match.status === 'finished' || match.phase === 'finished'
        ? t('已结束')
        : t(match.phase === 'night' ? '第 {day} 夜' : '第 {day} 天', { day: match.day }) +
          ' · ' +
          (match.stage || t(phaseNames[match.phase]))
    : '';
  const myTurn =
    !!match && match.status === 'running' && !!match.humanId && match.pending.some((r) => r.seatId === match.humanId);
  const editSeat = roster.find((s) => s.id === editing);
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
          <span aria-hidden="true">☾</span> {t('AI 游戏')}
        </button>
      </div>
      {match &&
        cardContainer &&
        (match.status !== 'finished' || seenReport !== match.id) &&
        createPortal(
          <button className={`gg-chat-card ${myTurn ? 'is-turn' : ''}`} onClick={enter}>
            <span className="gg-chat-card-top">
              <span
                className={`gg-moon ${match.phase === 'night' && match.status !== 'finished' ? '' : 'is-day'}`}
                aria-hidden="true"
              >
                {match.phase === 'night' && match.status !== 'finished' ? '☾' : '☀'}
              </span>
              <span className="gg-chat-card-title">
                <strong>
                  {t('狼人杀')}
                  {match.board ? ' · ' + t(BOARDS[match.board].name) : ''}
                </strong>
                <small>
                  {matchPhase} · {t(match.humanId ? '你参与' : '你旁观')}
                </small>
              </span>
              <span className={`gg-live ${match.status === 'running' ? '' : 'is-idle'}`}>
                {match.status === 'finished'
                  ? match.winner === 'wolves'
                    ? t('狼人获胜')
                    : match.winner === 'village'
                      ? t('好人获胜')
                      : t('已结束')
                  : match.status === 'paused'
                    ? t('已暂停')
                    : t('进行中')}
              </span>
            </span>
            <span className="gg-chat-card-seats" aria-hidden="true">
              {match.seats.map((seat) => (
                <span key={seat.id} className={seat.alive ? '' : 'is-dead'}>
                  {seat.human ? <span className="gg-human-avatar gg-dot-human" /> : <Avatar bot={seat} size={20} />}
                </span>
              ))}
            </span>
            <span className="gg-chat-card-foot">
              <span>{t('{count} 人存活', { count: match.seats.filter((p) => p.alive).length })}</span>
              {myTurn && <span className="gg-turn">{t('· 轮到你了')}</span>}
              <span className="gg-spacer" />
              <b>{t(match.status === 'finished' ? '查看战报' : '进入对局')} ↗</b>
            </span>
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
          {screen !== 'table' && (
            <header className="gg-header">
              <div>
                {screen !== 'select' && (
                  <button className="icon-button" aria-label={t('返回 AI 游戏')} onClick={() => setScreen('select')}>
                    <Icon name="back" size={18} />
                  </button>
                )}
                <strong>
                  {screen === 'select'
                    ? t('AI 游戏')
                    : screen === 'presets'
                      ? t('AI 玩家预设')
                      : t('狼人杀 · 开局设置')}
                </strong>
                {screen === 'presets' && <span>{t('长期保存，开局时可以按局修改')}</span>}
              </div>
              <div>
                {screen === 'presets' && (
                  <>
                    <span className="gg-legend" aria-hidden="true">
                      <span className="gg-mbti is-nt">NT</span> {t('分析')} <span className="gg-mbti is-nf">NF</span>{' '}
                      {t('外交')} <span className="gg-mbti is-sj">SJ</span> {t('守护')}{' '}
                      <span className="gg-mbti is-sp">SP</span> {t('探险')}
                    </span>
                    <button className="secondary-button" onClick={randomizePresets}>
                      {t('一键随机')}
                    </button>
                  </>
                )}
                <button className="icon-button" aria-label={t('关闭 AI 游戏')} onClick={() => setOpen(false)}>
                  <Icon name="close" size={18} />
                </button>
              </div>
            </header>
          )}
          {screen === 'select' && (
            <main className="gg-lobby">
              <div className="gg-lobby-main">
                {unfinished && (
                  <div className="gg-resume">
                    <span className="gg-moon" aria-hidden="true">
                      ☾
                    </span>
                    <span className="gg-resume-text">
                      <b>{t('有一局还没结束')}</b>
                      <small>
                        {match.board ? t(BOARDS[match.board].name) + ' · ' : ''}
                        {matchPhase} · {t('{count} 人存活', { count: match.seats.filter((p) => p.alive).length })}
                        {myTurn ? ' · ' + t('轮到你了') : ''}
                      </small>
                    </span>
                    <button className="primary-button" onClick={() => setScreen('table')}>
                      {t('继续对局')}
                    </button>
                  </div>
                )}
                {match && !unfinished && (
                  <div className="gg-resume">
                    <span className="gg-moon is-day" aria-hidden="true">
                      ☀
                    </span>
                    <span className="gg-resume-text">
                      <b>{t('上一局')}</b>
                      <small>
                        {match.board ? t(BOARDS[match.board].name) + ' · ' : ''}
                        {match.winner === 'wolves'
                          ? t('狼人获胜')
                          : match.winner === 'village'
                            ? t('好人获胜')
                            : t('中途结束，不计胜负')}
                      </small>
                    </span>
                    <button className="secondary-button" onClick={() => setScreen('table')}>
                      {t('查看战报')}
                    </button>
                  </div>
                )}
                <section className="gg-hero">
                  <div className="gg-hero-text">
                    <h3>{t('狼人杀')}</h3>
                    <p>
                      {t(
                        '12 人局，有警长。你可以坐进去一起玩，也可以旁观 12 个 AI 对局，结束后看战报和每个 AI 的思路。',
                      )}
                    </p>
                    <div className="gg-hero-tags">
                      {Object.values(BOARDS).map((b) => (
                        <span key={b.name}>{t(b.name)}</span>
                      ))}
                      <span>{t('4 狼 · 4 民 · 4 神')}</span>
                      <span>{t('约 30–45 分钟')}</span>
                    </div>
                    <div className="gg-hero-actions">
                      <button className="gg-hero-primary" disabled={unfinished} onClick={() => setScreen('room')}>
                        {t('开始新对局')}
                      </button>
                      {unfinished && <span className="gg-hero-note">{t('先结束当前对局')}</span>}
                    </div>
                  </div>
                  <div className="gg-hero-ring" aria-hidden="true">
                    <span className="gg-hero-moon" />
                    {[...members, ...guests].slice(0, 12).map((m, i) => {
                      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
                      return (
                        <span
                          key={m.id}
                          className="gg-hero-seat"
                          style={{
                            left: `calc(50% + ${Math.cos(a) * 92}px - 13px)`,
                            top: `calc(50% + ${Math.sin(a) * 92}px - 13px)`,
                          }}
                        >
                          <Avatar bot={{ ...m, color: m.color || '#8e7ca2' }} size={26} />
                        </span>
                      );
                    })}
                  </div>
                </section>
                <p className="gg-soon">{t('＋ 更多游戏会出现在这里')}</p>
              </div>
              <aside className="gg-lobby-side">
                <button className="gg-card gg-preset-card" onClick={() => setScreen('presets')}>
                  <span className="gg-card-head">
                    <span>{t('AI 玩家预设')}</span>
                    <span className="gg-link">{t('编辑')} ›</span>
                  </span>
                  <span className="gg-stack">
                    {members.slice(0, 6).map((m) => (
                      <Avatar key={m.id} bot={{ ...m, color: m.color || '#8e7ca2' }} size={22} />
                    ))}
                    <small>
                      {presetCount
                        ? t('{count} 位已设性格，其余每局随机', { count: presetCount })
                        : t('还没设置，每局随机性格')}
                    </small>
                  </span>
                  <span className="gg-chip-row">
                    {[...new Set(Object.values(mbtiPresets))].slice(0, 8).map((type) => (
                      <span key={type} className={`gg-mbti is-${temperament(type)}`}>
                        {type}
                      </span>
                    ))}
                  </span>
                </button>
                <section className="gg-card">
                  <span className="gg-card-head">
                    <span>{t('规则要点')}</span>
                  </span>
                  <p className="gg-rules-short">
                    {t(
                      '屠边局：狼人全灭好人胜，四民或四神全灭狼人胜。首夜后先竞选警长，警长 1.5 票并决定发言方向。真人发言 120 秒，AI 60 秒，其他行动 45 秒。',
                    )}
                  </p>
                </section>
                <p className="gg-muted gg-lobby-note">{t('对局在本机运行，AI 调用会消耗各自模型的额度。')}</p>
              </aside>
            </main>
          )}
          {screen === 'presets' && (
            <main className="gg-presets">
              <div className="gg-preset-grid">
                {[...members, ...guests].map((bot) => (
                  <label className={`gg-preset ${mbtiPresets[bot.id] ? '' : 'is-random'}`} key={bot.id}>
                    <span className="gg-preset-head">
                      <Portrait seat={bot} />
                      <strong>{bot.name}</strong>
                      {bot.id.startsWith('guest-') && <span className="gg-tag">{t('临时')}</span>}
                    </span>
                    <select
                      aria-label={t('{name} 的 MBTI', { name: bot.name })}
                      value={mbtiPresets[bot.id] || ''}
                      className={mbtiPresets[bot.id] ? `is-${temperament(mbtiPresets[bot.id])}` : ''}
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
                    <small>
                      {mbtiPresets[bot.id]
                        ? t(TEMPERAMENT_NOTES[temperament(mbtiPresets[bot.id])])
                        : t('开局时从 16 种里抽一种')}
                    </small>
                  </label>
                ))}
              </div>
              {configNotice && (
                <p className="gg-muted gg-notice" role="status">
                  {configNotice}
                </p>
              )}
            </main>
          )}
          {screen === 'room' && (
            <main className="gg-room">
              <aside className="gg-room-left">
                <div>
                  <div className="gg-label">{t('板子')}</div>
                  <div className="gg-boards" role="radiogroup" aria-label={t('狼人杀板子')}>
                    {(Object.entries(BOARDS) as [typeof board, (typeof BOARDS)[typeof board]][]).map(([id, b]) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={board === id}
                        className={`gg-board ${board === id ? 'is-selected' : ''}`}
                        onClick={() => setBoard(id)}
                      >
                        <b>{t(b.name)}</b>
                        <span className="gg-chip-row">
                          {b.description.split(' · ').map((part) => (
                            <span
                              key={part}
                              className={`gg-tag ${part.includes('狼') ? 'is-wolf' : part.includes('民') ? 'is-good' : 'is-god'}`}
                            >
                              {t(part)}
                            </span>
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="gg-label">{t('你的位置')}</div>
                  <div className="gg-seg" role="radiogroup">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mode === 'play'}
                      className={mode === 'play' ? 'is-on' : ''}
                      onClick={() => {
                        setMode('play');
                        setSelected((ids) => ids.slice(0, 11));
                      }}
                    >
                      {t('坐进去玩')}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mode === 'watch'}
                      className={mode === 'watch' ? 'is-on' : ''}
                      onClick={() => setMode('watch')}
                    >
                      {t('旁观 12 个 AI')}
                    </button>
                  </div>
                  <p className="gg-muted">{t('旁观时可以随时切换「全知视角」看所有身份。')}</p>
                </div>
                <details className="gg-rule-details">
                  <summary>{t('完整规则')}</summary>
                  <p>{TWELVE_RULES}</p>
                </details>
                <p className="gg-muted gg-room-note">{t('身份在开局时随机发放，座位顺序即发言顺序。')}</p>
              </aside>
              <section className="gg-room-main">
                <div className="gg-toolbar">
                  <b>{roster.length} / 12</b>
                  {roster.length < 12 ? (
                    <>
                      <span className="gg-muted">{t('还差 {count} 位', { count: 12 - roster.length })}</span>
                      <button className="secondary-button" onClick={() => setFilled(true)}>
                        {t('一键补齐')}
                      </button>
                    </>
                  ) : filled && limit > chosen.length ? (
                    <button className="gg-back" onClick={() => setFilled(false)}>
                      {t('移除临时 Bot')}
                    </button>
                  ) : null}
                  <span className="gg-spacer" />
                  <select aria-label={t('统一模型')} value={batch} onChange={(e) => setBatch(e.target.value)}>
                    <option value="">{t('统一模型：选择模型')}</option>
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
                    {t('应用')}
                  </button>
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
                    {t('随机性格')}
                  </button>
                  <button className="gg-back" onClick={restore}>
                    {t('沿用上次')}
                  </button>
                </div>
                <div className="gg-seat-grid">
                  {roster.map((s, i) => {
                    const model = s.id === 'human' ? undefined : resolved(s),
                      type = s.id === 'human' ? undefined : resolvedMbti(s.id);
                    return (
                      <button
                        type="button"
                        key={s.id}
                        className={`gg-seat-card ${s.id === 'human' ? 'is-you' : ''} ${s.temporary ? 'is-temp' : ''} ${editing === s.id ? 'is-editing' : ''}`}
                        disabled={s.id === 'human'}
                        onClick={() => {
                          setAdding(false);
                          setEditing(editing === s.id ? '' : s.id);
                        }}
                      >
                        <span className="gg-seat-card-number">{i + 1}</span>
                        <span className="gg-seat-card-head">
                          <Portrait seat={s} />
                          <b>{s.id === 'human' ? t('你') : s.name}</b>
                        </span>
                        <span className={`gg-seat-card-model ${s.id !== 'human' && !model ? 'is-missing' : ''}`}>
                          {s.id === 'human' ? t('真人玩家') : model ? model.model : t('未配置模型')}
                        </span>
                        <span className="gg-chip-row">
                          {s.id === 'human' ? (
                            <span className="gg-tag is-accent">{t('参与')}</span>
                          ) : type ? (
                            <span className={`gg-mbti is-${temperament(type)}`}>{type}</span>
                          ) : (
                            <span className="gg-tag">{t('随机性格')}</span>
                          )}
                          {s.temporary && <span className="gg-tag">{t('临时')}</span>}
                          {(overrides[s.id] || sessionMbti[s.id]) && <span className="gg-tag">{t('本局修改')}</span>}
                        </span>
                      </button>
                    );
                  })}
                  {Array.from({ length: Math.max(0, 12 - roster.length) }, (_, i) => (
                    <button
                      type="button"
                      key={'empty' + i}
                      className="gg-seat-card is-empty"
                      onClick={() => {
                        setEditing('');
                        setAdding(true);
                      }}
                    >
                      {t('＋ 空位')}
                    </button>
                  ))}
                  {editSeat && editSeat.id !== 'human' && (
                    <div
                      className="gg-seat-pop"
                      role="dialog"
                      aria-label={t('{name} 的本局设置', { name: editSeat.name })}
                    >
                      <div className="gg-card-head">
                        <b>{t('{seat} 号 · {name}', { seat: roster.indexOf(editSeat) + 1, name: editSeat.name })}</b>
                        <button className="icon-button" aria-label={t('关闭')} onClick={() => setEditing('')}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                      <label>
                        {t('本局模型')}
                        <select
                          aria-label={t('{name} 的本局模型', { name: editSeat.name })}
                          value={options.some((o) => o.key === overrides[editSeat.id]) ? overrides[editSeat.id] : ''}
                          onChange={(e) => setOverrides((v) => ({ ...v, [editSeat.id]: e.target.value }))}
                        >
                          <option value="">
                            {editSeat.model
                              ? t('沿用 ') + editSeat.model.model
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
                      </label>
                      <label>
                        {t('本局性格')}
                        {personalityPicker(editSeat)}
                      </label>
                      <div className="gg-pop-actions">
                        <span className="gg-muted">{t('只影响这一局')}</span>
                        <span className="gg-spacer" />
                        <button
                          className="gg-back"
                          onClick={() => {
                            setOverrides(({ [editSeat.id]: _model, ...rest }) => rest);
                            setSessionMbti(({ [editSeat.id]: _type, ...rest }) => rest);
                          }}
                        >
                          {t('恢复预设')}
                        </button>
                        {!editSeat.temporary && (
                          <button
                            className="secondary-button"
                            onClick={() => {
                              setSelected((ids) => ids.filter((id) => id !== editSeat.id));
                              setEditing('');
                            }}
                          >
                            {t('移出本局')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {adding && (
                    <div className="gg-seat-pop" role="dialog" aria-label={t('补一位玩家')}>
                      <div className="gg-card-head">
                        <b>{t('补一位玩家')}</b>
                        <button className="icon-button" aria-label={t('关闭')} onClick={() => setAdding(false)}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                      <div className="gg-add-list">
                        {available.map((m) => (
                          <button
                            key={m.id}
                            className="gg-add-member"
                            disabled={chosen.length >= limit}
                            onClick={() => {
                              setSelected((ids) => [...ids, m.id]);
                              setAdding(false);
                            }}
                          >
                            <Portrait seat={m} />
                            {m.name}
                          </button>
                        ))}
                        {!available.length && <p className="gg-muted">{t('群里的 Bot 都已入座')}</p>}
                      </div>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setFilled(true);
                          setAdding(false);
                        }}
                      >
                        {t('用临时 AI 补齐')}
                      </button>
                    </div>
                  )}
                </div>
                {options.length === 0 && (
                  <p className="gg-muted gg-room-warning">{t('请先在设置中添加模型；配置后即可开始对局。')}</p>
                )}
                {(gameError || readError) && (
                  <p role="alert" className="group-error gg-room-warning">
                    {gameError || readError}
                  </p>
                )}
                <footer className="gg-room-footer">
                  {blocker ? (
                    <span className="gg-muted">{blocker}</span>
                  ) : (
                    <span className="gg-ok">{t('✓ 12 位玩家都已就绪')}</span>
                  )}
                  {configNotice && (
                    <span className="gg-muted" role="status">
                      · {configNotice}
                    </span>
                  )}
                  <span className="gg-spacer" />
                  {unfinished && (
                    <button className="secondary-button" onClick={() => setScreen('table')}>
                      {t('返回当前对局')}
                    </button>
                  )}
                  <button className="primary-button" disabled={starting || !!blocker} onClick={() => void start()}>
                    {t(starting ? '正在开局…' : mode === 'play' ? '开始对局' : '开始全 AI 对局')}
                  </button>
                </footer>
              </section>
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

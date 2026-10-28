import { BOARDS, PHASE_NAMES, twelveRules } from '../../shared/games/game-boards';
import { WerewolfTable } from './WerewolfTable';
import { UndercoverTable } from './UndercoverTable';
import { DoudizhuTable } from './DoudizhuTable';
import { MahjongTable } from './MahjongTable';
import { PersonaPage } from './PersonaPage';
import werewolfLobbyArt from './werewolf-lobby.webp';
import undercoverLobbyArt from './undercover-lobby.webp';
import doudizhuLobbyArt from './doudizhu-lobby.webp';
import mahjongLobbyArt from './mahjong-lobby.webp';
import { seatBot, syncSeats } from './game-view-model';
import type { GameModeId, GameView } from '../../shared/types/game-types';
import { GAME_MBTI_TYPES, isGameMbti, type GameMbti } from '../../shared/games/game-personality';
import { PRESETS, PRESET_IDS, isPresetId, type PresetId } from '../../shared/persona/presets';
import type { ModelProvider, ModelSelection } from '../../shared/types/core';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
import { GameGlyph } from './GameGlyph';
import { Select } from '../ui/Select';
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
const WINNER_NAMES: Record<NonNullable<GameView['winner']>, string> = {
  wolves: '狼人获胜',
  village: '好人获胜',
  civilian: '平民获胜',
  undercover: '卧底获胜',
  blank: '白板获胜',
  landlord: '地主获胜',
  farmer: '农民获胜',
  hu: '和牌',
  draw: '流局',
};
const GAME_NAMES: Record<GameModeId, string> = {
  werewolf: '狼人杀',
  undercover: '谁是卧底',
  doudizhu: '斗地主',
  mahjong: '麻将',
};
/** Card and tile games seat a fixed number of players and have nobody to vote out. */
const CARD_GAMES: GameModeId[] = ['doudizhu', 'mahjong'];
/** The mark of a match: the phase of the day for Werewolf, the game's own glyph otherwise. */
const markOf = (match: GameView) =>
  match.mode === 'undercover'
    ? 'undercover'
    : match.mode === 'doudizhu'
      ? 'cards'
      : match.mode === 'mahjong'
        ? 'tile'
        : match.phase === 'night'
          ? 'moon'
          : 'sun';
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
  onCardTime,
  onLatestMatch,
  providers = [],
  defaultModel,
}: {
  groupId: string;
  groupName: string;
  members: Member[];
  initialOpen?: boolean;
  cardContainer?: HTMLElement | null;
  /** When the shown match ended, or undefined while it is live; the host places the card by it. */
  onCardTime?: (endedAt: number | undefined) => void;
  /** The id of the match this group can still open, if any. */
  onLatestMatch?: (id: string | undefined) => void;
  providers?: ModelProvider[];
  defaultModel?: ModelSelection;
}) {
  const { t } = useI18n();
  const [board, setBoard] = useState<'standard12' | 'guard12'>('standard12');
  const [game, setGame] = useState<GameModeId>('werewolf'),
    [seatCount, setSeatCount] = useState(6),
    [blank, setBlank] = useState(false),
    // Card and tile games: AI players may chat at the table. Off by default, since a careless line gives a hand away.
    [tableTalk, setTableTalk] = useState(false);
  const storageKey = `aelion:game-prototype:v1:${groupId}`;
  const [match, setMatch] = useState<GameView | null>(null);
  const [open, setOpen] = useState(initialOpen),
    [screen, setScreen] = useState<'select' | 'presets' | 'persona' | 'room' | 'table'>(match ? 'table' : 'select');
  // The seat you take, by index; the other players fill the remaining seats in order.
  const [humanSeat, setHumanSeat] = useState(0);
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
  // A personality preset per seat for this match only; a member Bot's own profile is not changed.
  const [sessionPreset, setSessionPreset] = useState<Record<string, PresetId>>({});
  const [personaBotId, setPersonaBotId] = useState('');
  const [personaReturn, setPersonaReturn] = useState<'select' | 'room'>('select');
  const [hasUnsaved, setHasUnsaved] = useState(false);
  function mayLeave() {
    if (hasUnsaved && !window.confirm(t('有未保存的修改，确定放弃并离开吗？'))) return false;
    setHasUnsaved(false);
    return true;
  }
  function openPersona(botId = '', from: 'select' | 'room' = 'select') {
    setPersonaBotId(botId);
    setPersonaReturn(from);
    setScreen('persona');
  }
  // Selection is seeded once on mount; Bots invited to the group afterwards take a free seat instead of being left out.
  const memberIds = members.map((m) => m.id).join('\n'),
    knownMembers = useRef(new Set(members.map((m) => m.id)));
  useEffect(() => {
    const ids = memberIds ? memberIds.split('\n') : [],
      joined = ids.filter((id) => !knownMembers.current.has(id));
    knownMembers.current = new Set(ids);
    setSelected((current) => syncSeats(current, ids, joined, mode === 'play' ? 11 : 12));
  }, [memberIds, mode]);
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
      const stored = JSON.parse(localStorage.getItem(storageKey + ':players') || 'null');
      // Each game remembers its own last setup; Werewolf setups saved before games were separate sit at the top level.
      const saved = stored?.games?.[game] || (game === 'werewolf' && stored?.selected ? stored : null);
      if (!saved) {
        setConfigNotice(t('暂无上次配置'));
        return;
      }
      if (game === 'werewolf' && Object.hasOwn(BOARDS, saved.board)) setBoard(saved.board);
      if (game === 'undercover' && Number.isInteger(saved.seatCount) && saved.seatCount >= 4 && saved.seatCount <= 10) {
        setSeatCount(saved.seatCount);
        setBlank(saved.blank === true);
      }
      if (CARD_GAMES.includes(game)) setTableTalk(saved.tableTalk === true);
      if (Number.isInteger(saved.humanSeat) && saved.humanSeat >= 0) setHumanSeat(saved.humanSeat);
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
      for (const [id, type] of Object.entries(stored.mbtiPresets || {})) if (isGameMbti(type)) personalities[id] = type;
      setMbtiPresets(personalities);
      const session: Record<string, GameMbti | 'random'> = {};
      for (const [id, type] of Object.entries(saved.sessionMbti || {}))
        if (type === 'random' || isGameMbti(type)) session[id] = type;
      setSessionMbti(session);
      const presets: Record<string, PresetId> = {};
      for (const [id, preset] of Object.entries(saved.sessionPreset || {}))
        if (isPresetId(preset)) presets[id] = preset;
      setSessionPreset(presets);
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
  const endedAt = match?.status === 'finished' ? match.endedAt : undefined;
  useEffect(() => onCardTime?.(endedAt), [endedAt, onCardTime]);
  const dialog = useRef<HTMLDialogElement>(null),
    workspace = useRef<HTMLDivElement>(null);
  useSwitchMotion(workspace, screen, ':scope > :not(.gg-storage-warning)');
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

  // Werewolf seats twelve; Who's the Spy four to ten; Dou Di Zhu three; Mahjong four.
  const total = game === 'undercover' ? seatCount : game === 'doudizhu' ? 3 : game === 'mahjong' ? 4 : 12;
  const limit = mode === 'play' ? total - 1 : total;
  const chosen = members.filter((m) => selected.includes(m.id)).slice(0, limit);
  const others: Seat[] = [
    ...chosen.map((m) => ({ ...m, role: '' })),
    ...guests.slice(0, filled ? limit - chosen.length : 0).map((m) => ({ ...m, temporary: true, role: '' })),
  ];
  // Seats in table order: you sit where you chose, everyone else fills the other seats from the front, and seats
  // nobody has filled yet stay open.
  const slots: (Seat | undefined)[] = Array.from({ length: total }, () => undefined);
  const mine = Math.min(humanSeat, total - 1);
  if (mode === 'play') slots[mine] = { id: 'human', name: '你', color: '#9177ac', role: '村民' };
  {
    let next = 0;
    for (const seat of others) {
      while (slots[next]) next++;
      if (next >= total) break;
      slots[next] = seat;
    }
  }
  const roster = slots.filter((seat): seat is Seat => !!seat);
  const personalityPicker = (s: Member) =>
    members.some((member) => member.id === s.id) ? (
      <button className="gg-link" onClick={() => openPersona(s.id, 'room')}>
        {t('查看人格档案')}
      </button>
    ) : (
      <Select
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
        <option value="">
          {mbtiPresets[s.id] ? t('预设 {value}', { value: mbtiPresets[s.id] }) : t('预设 · 随机')}
        </option>
        <option value="random">{t('开局随机')}</option>
        {GAME_MBTI_TYPES.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </Select>
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
      bots = guests,
      next = { ...mbtiPresets };
    bots.forEach((bot, i) => (next[bot.id] = types[i % types.length]));
    savePresets(next);
  }
  async function start() {
    if (starting || roster.length !== total) return;
    setStarting(true);
    mutationStart();
    setGameError('');
    try {
      const next = await window.aelion.games.create({
        groupId,
        mode: game,
        ...(game === 'werewolf'
          ? { board }
          : game === 'undercover'
            ? { blank: blank && seatCount >= 7 }
            : { tableTalk }),
        players: roster.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color || '#8e7ca2',
          human: p.id === 'human',
          model: p.id === 'human' ? undefined : resolved(p),
          mbti: p.id === 'human' ? undefined : resolvedMbti(p.id),
          ...(p.id !== 'human' && sessionPreset[p.id] ? { preset: sessionPreset[p.id] } : {}),
        })),
      });
      updateMatch(next);
      try {
        const stored = JSON.parse(localStorage.getItem(storageKey + ':players') || '{}');
        const setup = {
          mode,
          selected,
          filled,
          overrides,
          sessionMbti,
          sessionPreset,
          humanSeat,
          ...(game === 'werewolf' ? { board } : game === 'undercover' ? { seatCount, blank } : { tableTalk }),
        };
        localStorage.setItem(
          storageKey + ':players',
          JSON.stringify({ ...stored, mbtiPresets, games: { ...stored.games, [game]: setup } }),
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
  // A result card asks to open its match; only the latest match can still be opened.
  useEffect(() => {
    const open = (event: Event) => {
      const { groupId: target, matchId } = (event as CustomEvent<{ groupId: string; matchId: string }>).detail;
      if (target === groupId && match?.id === matchId) enter();
    };
    window.addEventListener('aelion:open-game', open);
    return () => window.removeEventListener('aelion:open-game', open);
  });
  useEffect(() => onLatestMatch?.(match?.id), [match?.id, onLatestMatch]);
  const [editing, setEditing] = useState(''),
    [adding, setAdding] = useState(false);
  const aiSeats = roster.filter((s) => s.id !== 'human'),
    unconfigured = aiSeats.filter((s) => !resolved(s)),
    unfinished = !!match && match.status !== 'finished',
    blocker = unfinished
      ? t('还有一局没结束，先结束或继续那一局')
      : roster.length !== total
        ? t('还差 {count} 个座位', { count: total - roster.length })
        : unconfigured.length
          ? t('{count} 位 AI 还没有可用模型', { count: unconfigured.length })
          : '';
  // Members selected beyond this game's seats stay pickable rather than vanishing from both lists.
  const available = members.filter((m) => !chosen.some((c) => c.id === m.id));
  const matchPhase = match
    ? match.status === 'paused'
      ? t('已暂停')
      : match.status === 'finished' || match.phase === 'finished'
        ? t('已结束')
        : match.mode === 'doudizhu'
          ? t(match.phase === 'bid' ? '叫地主' : '出牌中')
          : match.mode === 'mahjong'
            ? t('剩 {count} 张', { count: match.tiles?.wall ?? 0 })
            : match.mode === 'undercover'
              ? t('第 {round} 轮 · {phase}', {
                  round: match.day,
                  phase: t(match.phase === 'vote' ? '投票' : match.phase === 'resolution' ? '白板猜词' : '描述'),
                })
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
          <GameGlyph name="moon" size={15} />
          {t('AI 游戏')}
        </button>
      </div>
      {/* Only an unfinished match has a live card; a finished one is told by its result card in the timeline. */}
      {match &&
        match.status !== 'finished' &&
        cardContainer &&
        createPortal(
          <button
            className={`gg-chat-card is-${match.mode && match.mode !== 'werewolf' ? 'party' : match.phase === 'night' ? 'night' : 'day'} ${myTurn ? 'is-turn' : ''}`}
            onClick={enter}
          >
            <span className="gg-chat-card-top">
              <span className="gg-mark">
                <GameGlyph name={markOf(match)} size={18} />
              </span>
              <span className="gg-chat-card-title">
                <strong>
                  {t(GAME_NAMES[match.mode || 'werewolf'])}
                  {match.board ? ' · ' + t(BOARDS[match.board].name) : ''}
                </strong>
                <small>
                  {matchPhase} · {t(match.humanId ? '你参与' : '你旁观')}
                  {match.mode && CARD_GAMES.includes(match.mode)
                    ? ''
                    : ' · ' + t('{count} 人存活', { count: match.seats.filter((p) => p.alive).length })}
                </small>
              </span>
              {myTurn ? (
                <span className="gg-turn">{t('轮到你了')}</span>
              ) : (
                <span className={`gg-live ${match.status === 'running' ? '' : 'is-idle'}`}>
                  {match.status === 'paused' ? t('已暂停') : t('进行中')}
                </span>
              )}
            </span>
            <span className="gg-chat-card-seats" aria-hidden="true">
              {match.seats.map((seat) => (
                <span key={seat.id} className={seat.alive ? '' : 'is-dead'}>
                  {seat.human ? (
                    <span className="gg-human-avatar gg-dot-human">
                      <Icon name="user" size={12} />
                    </span>
                  ) : (
                    <Avatar bot={seatBot(seat)} size={22} />
                  )}
                </span>
              ))}
              <span className="gg-go">
                <GameGlyph name="arrow" size={15} />
              </span>
            </span>
          </button>,
          cardContainer,
        )}
      <dialog
        ref={dialog}
        className="gg-dialog"
        data-screen={screen}
        onCancel={(event) => {
          if (mayLeave()) setOpen(false);
          else event.preventDefault();
        }}
        onClose={() => setOpen(false)}
      >
        <div ref={workspace} className="gg-workspace">
          {screen !== 'table' && (
            <header className="gg-header">
              <div>
                {screen !== 'select' && (
                  <button
                    className="icon-button"
                    aria-label={t(screen === 'persona' && personaReturn === 'room' ? '返回开局设置' : '返回 AI 游戏')}
                    onClick={() => {
                      if (mayLeave()) setScreen(screen === 'persona' ? personaReturn : 'select');
                    }}
                  >
                    <Icon name="back" size={18} />
                  </button>
                )}
                <strong>
                  {screen === 'select'
                    ? t('AI 游戏')
                    : screen === 'presets'
                      ? t('补位 AI 预设')
                      : screen === 'persona'
                        ? t('人格')
                        : t('{game} · 开局设置', { game: t(GAME_NAMES[game]) })}
                </strong>
                {screen === 'presets' && <span>{t('长期保存，开局时可以按局修改')}</span>}
              </div>
              <div>
                {screen === 'select' && (
                  <>
                    {members.length > 0 && (
                      <button className="gg-header-link" onClick={() => openPersona()}>
                        <GameGlyph name="mask" size={16} />
                        {t('人格')}
                      </button>
                    )}
                    <button className="gg-header-link" onClick={() => setScreen('presets')}>
                      <GameGlyph name="dice" size={16} />
                      {t('补位 AI 预设')}
                    </button>
                  </>
                )}
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
                <button
                  className="icon-button"
                  aria-label={t('关闭 AI 游戏')}
                  onClick={() => {
                    if (mayLeave()) setOpen(false);
                  }}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>
            </header>
          )}
          {screen === 'select' && (
            <main className="gg-lobby">
              {unfinished && (
                <div className="gg-resume">
                  <GameGlyph name={markOf(match)} size={17} />
                  <span className="gg-resume-text">
                    <b>{t('有一局还没结束')}</b>
                    <small>
                      {t(GAME_NAMES[match.mode || 'werewolf'])} ·{' '}
                      {match.board ? t(BOARDS[match.board].name) + ' · ' : ''}
                      {matchPhase}
                      {match.mode && CARD_GAMES.includes(match.mode)
                        ? ''
                        : ' · ' + t('{count} 人存活', { count: match.seats.filter((p) => p.alive).length })}
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
                  <GameGlyph name="history" size={17} />
                  <span className="gg-resume-text">
                    <b>{t('上一局')}</b>
                    <small>
                      {t(GAME_NAMES[match.mode || 'werewolf'])} ·{' '}
                      {match.board ? t(BOARDS[match.board].name) + ' · ' : ''}
                      {match.winner ? t(WINNER_NAMES[match.winner]) : t('中途结束，不计胜负')}
                    </small>
                  </span>
                  <button className="secondary-button" onClick={() => setScreen('table')}>
                    {t('查看战报')}
                  </button>
                </div>
              )}
              <div className="gg-games">
                <article className="gg-game is-werewolf">
                  <div className="gg-game-art" aria-hidden="true">
                    <img src={werewolfLobbyArt} alt="" decoding="async" />
                  </div>
                  <h3>{t('狼人杀')}</h3>
                  <p>
                    {t('12 人局，有警长。你可以坐进去一起玩，也可以旁观 12 个 AI 对局，结束后看战报和每个 AI 的思路。')}
                  </p>
                  <p className="gg-game-meta">
                    {[...Object.values(BOARDS).map((b) => t(b.name)), t('约 30–45 分钟')].join(' · ')}
                  </p>
                  <button
                    className="primary-button"
                    disabled={unfinished}
                    title={unfinished ? t('先结束当前对局') : undefined}
                    onClick={() => {
                      setGame('werewolf');
                      setScreen('room');
                    }}
                  >
                    {t('开始新对局')}
                  </button>
                </article>
                <article className="gg-game is-undercover">
                  <div className="gg-game-art" aria-hidden="true">
                    <img src={undercoverLobbyArt} alt="" decoding="async" />
                  </div>
                  <h3>{t('谁是卧底')}</h3>
                  <p>
                    {t(
                      '4–10 人。每人拿到一个词，卧底的词和大家相近但不同，谁都不知道自己是不是卧底。轮流用一句话描述，再投票找出卧底。',
                    )}
                  </p>
                  <p className="gg-game-meta">
                    {[t('1–2 名卧底'), t('7 人起可加白板'), t('约 10–20 分钟')].join(' · ')}
                  </p>
                  <button
                    className="primary-button"
                    disabled={unfinished}
                    title={unfinished ? t('先结束当前对局') : undefined}
                    onClick={() => {
                      setGame('undercover');
                      setScreen('room');
                    }}
                  >
                    {t('开始新对局')}
                  </button>
                </article>
                <article className="gg-game is-doudizhu">
                  <div className="gg-game-art" aria-hidden="true">
                    <img src={doudizhuLobbyArt} alt="" decoding="async" />
                  </div>
                  <h3>{t('斗地主')}</h3>
                  <p>{t('3 人，一个地主对两个农民。叫分抢地主，出牌压过上家，先出完的一边获胜；炸弹和春天翻倍。')}</p>
                  <p className="gg-game-meta">{[t('叫分 1–3'), t('带记牌器'), t('约 5–10 分钟')].join(' · ')}</p>
                  <button
                    className="primary-button"
                    disabled={unfinished}
                    title={unfinished ? t('先结束当前对局') : undefined}
                    onClick={() => {
                      setGame('doudizhu');
                      setScreen('room');
                    }}
                  >
                    {t('开始新对局')}
                  </button>
                </article>
                <article className="gg-game is-mahjong">
                  <div className="gg-game-art" aria-hidden="true">
                    <img src={mahjongLobbyArt} alt="" decoding="async" />
                  </div>
                  <h3>{t('麻将')}</h3>
                  <p>
                    {t('4 人推倒胡，不吃，可碰、杠、和；四组面子加一对将，或七对。每张牌都标好打后的向听数和进张。')}
                  </p>
                  <p className="gg-game-meta">{[t('136 张无花'), t('按番计分'), t('约 15–25 分钟')].join(' · ')}</p>
                  <button
                    className="primary-button"
                    disabled={unfinished}
                    title={unfinished ? t('先结束当前对局') : undefined}
                    onClick={() => {
                      setGame('mahjong');
                      setScreen('room');
                    }}
                  >
                    {t('开始新对局')}
                  </button>
                </article>
              </div>
              <p className="gg-muted gg-lobby-note">{t('对局在本机运行，AI 调用会消耗各自模型的额度。')}</p>
            </main>
          )}
          {screen === 'presets' && (
            <main className="gg-presets">
              <div className="gg-preset-grid">
                {guests.map((bot) => (
                  <label className={`gg-preset ${mbtiPresets[bot.id] ? '' : 'is-random'}`} key={bot.id}>
                    <span className="gg-preset-head">
                      <Portrait seat={bot} />
                      <strong>{bot.name}</strong>
                      {bot.id.startsWith('guest-') && <span className="gg-tag">{t('临时')}</span>}
                    </span>
                    <Select
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
                    </Select>
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
          {screen === 'persona' && (
            <PersonaPage
              key={personaBotId}
              initialBotId={personaBotId}
              members={members}
              presets={mbtiPresets}
              onUnsavedChange={setHasUnsaved}
            />
          )}
          {screen === 'room' && (
            <main className="gg-room">
              <aside className="gg-room-left">
                {CARD_GAMES.includes(game) ? (
                  <div>
                    <div className="gg-label">{t('人数')}</div>
                    <p className="gg-muted">
                      {t(
                        game === 'doudizhu'
                          ? '3 人：叫分决定地主，另外两人是农民。'
                          : '4 人：开局随机定庄家，庄家先摸牌。',
                      )}
                    </p>
                    <label className="gg-check">
                      <input type="checkbox" checked={tableTalk} onChange={(e) => setTableTalk(e.target.checked)} />
                      {t('AI 出牌时附带闲聊')}
                    </label>
                    <p className="gg-muted">
                      {t(
                        tableTalk
                          ? 'AI 出牌时会顺口说一句，所有人都能看到；可能无意中透露牌情。'
                          : 'AI 只出牌、不说话，牌桌上不会出现任何 AI 发言。',
                      )}
                    </p>
                  </div>
                ) : game === 'undercover' ? (
                  <div>
                    <div className="gg-label">{t('人数')}</div>
                    <div className="gg-seg" role="radiogroup" aria-label={t('人数')}>
                      {[4, 5, 6, 7, 8, 9, 10].map((n) => (
                        <button
                          key={n}
                          type="button"
                          role="radio"
                          aria-checked={seatCount === n}
                          className={seatCount === n ? 'is-on' : ''}
                          onClick={() => setSeatCount(n)}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <p className="gg-muted">
                      {t('{count} 名卧底', { count: seatCount <= 6 ? 1 : 2 })}
                      {seatCount >= 7 && blank ? t(' · 1 名白板') : ''}
                    </p>
                    <label className="gg-check">
                      <input
                        type="checkbox"
                        checked={blank && seatCount >= 7}
                        disabled={seatCount < 7}
                        onChange={(e) => setBlank(e.target.checked)}
                      />
                      {t('加一名白板（7 人起）')}
                    </label>
                  </div>
                ) : (
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
                          <span className="gg-board-copy">
                            <b>{t(b.name)}</b>
                            <small>{t(b.description)}</small>
                          </span>
                          <span className="gg-radio" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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
                        setSelected((ids) => ids.slice(0, total - 1));
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
                      {t('旁观 {count} 个 AI', { count: total })}
                    </button>
                  </div>
                  <p className="gg-muted">
                    {t(
                      CARD_GAMES.includes(game)
                        ? '旁观时可以随时切换「全知视角」看所有人的牌。'
                        : '旁观时可以随时切换「全知视角」看所有身份。',
                    )}
                  </p>
                </div>
                <details className="gg-rule-details">
                  <summary>{t('完整规则')}</summary>
                  <p>
                    {game === 'doudizhu'
                      ? t(
                          '一副 54 张牌，每人 17 张，留 3 张底牌。从随机一人开始每人叫一次，可叫 1、2、3 分或不叫，叫 3 分直接当地主，否则最高者当地主；无人叫则重新发牌。地主拿底牌先出。出牌要压过上家同类型、同张数的牌，或者不要；两家都不要时最后出牌的人重新出。牌型有单张、对子、三张、三带一、三带二、顺子、连对、飞机（可带单或带对）、四带二、炸弹和王炸。先出完的一边获胜；底分是叫分，每个炸弹、王炸和春天翻倍，地主输赢是农民的两倍。',
                        )
                      : game === 'mahjong'
                        ? t(
                            '136 张牌，没有花牌。每人 13 张，庄家先摸。轮到你时摸一张，然后自摸和牌、暗杠或加杠，或者打出一张。别人打出的牌可以和、杠或碰，不能吃；和牌优先，多人能和时出牌者下家起第一个人和。四组面子加一对将，或七个对子，就能和。番数：平胡 1，七对、碰碰胡、混一色各 2，清一色 4，字一色 6，门清、自摸、杠上开花、海底捞月各 1。点炮由出牌的人付，自摸三家各付。牌墙摸完无人和牌就是流局。',
                          )
                        : game === 'undercover'
                          ? t(
                              '每轮存活玩家依次描述自己的词，然后同时投票，得票最多的人出局并公布身份。第一次平票时，平票的人各补一句描述后在他们之中重投，再平票本轮无人出局。卧底全部出局平民胜；存活卧底不少于平民，或只剩 3 人时仍有卧底，卧底胜。白板出局时可以猜一次平民的词，猜中则白板单独获胜。',
                            )
                          : twelveRules(board)}
                  </p>
                </details>
                <p className="gg-muted gg-room-note">
                  {t(
                    game === 'doudizhu'
                      ? '牌在开局时随机发放，座位顺序即出牌顺序。'
                      : game === 'mahjong'
                        ? '牌在开局时随机发放，座位顺序即摸牌顺序。'
                        : game === 'undercover'
                          ? '词在开局时随机发放，每轮的描述从下一位玩家开始。'
                          : '身份在开局时随机发放，座位顺序即发言顺序。',
                  )}
                </p>
              </aside>
              <section className="gg-room-main">
                <div className="gg-toolbar">
                  <span className="gg-count">
                    <b>{roster.length}</b>
                    <small>/ {total}</small>
                  </span>
                  <span className="gg-meter" aria-hidden="true">
                    <i style={{ width: `${(roster.length / total) * 100}%` }} />
                  </span>
                  {roster.length < total ? (
                    <>
                      <span className="gg-muted">{t('还差 {count} 位', { count: total - roster.length })}</span>
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
                  <button
                    className="gg-back"
                    onClick={() => {
                      setSessionMbti((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          guests.map((p) => [
                            p.id,
                            GAME_MBTI_TYPES[Math.floor(Math.random() * GAME_MBTI_TYPES.length)],
                          ]),
                        ),
                      }));
                      setConfigNotice(t('已随机补位玩家的本局性格'));
                    }}
                  >
                    {t('随机补位性格')}
                  </button>
                  {mode === 'play' && (
                    <button className="gg-back" onClick={() => setHumanSeat(Math.floor(Math.random() * total))}>
                      {t('随机座位')}
                    </button>
                  )}
                  <button className="gg-back" onClick={restore}>
                    {t('沿用上次')}
                  </button>
                </div>
                <div className="gg-toolbar gg-toolbar-model">
                  <span className="gg-label">{t('统一模型')}</span>
                  <Select aria-label={t('统一模型')} value={batch} onChange={(e) => setBatch(e.target.value)}>
                    <option value="">{t('统一模型：选择模型')}</option>
                    {options.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
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
                </div>
                <div className="gg-seat-grid">
                  {slots.map((s, i) => {
                    if (!s)
                      return (
                        <div key={'empty' + i} className="gg-seat-card is-empty">
                          <span className="gg-seat-card-number">{i + 1}</span>
                          {mode === 'play' && (
                            <button type="button" className="gg-seat-take" onClick={() => setHumanSeat(i)}>
                              {t('坐这里')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="gg-seat-add"
                            onClick={() => {
                              setEditing('');
                              setAdding(true);
                            }}
                          >
                            {t('＋ 补一位')}
                          </button>
                        </div>
                      );
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
                        {s.id !== 'human' && (
                          <span className="gg-seat-card-note">
                            {sessionPreset[s.id] ? (
                              <span className="gg-tag is-accent">{PRESETS[sessionPreset[s.id]].name}</span>
                            ) : s.temporary && type ? (
                              <span className={`gg-mbti is-${temperament(type)}`}>{type}</span>
                            ) : null}
                            <span>
                              {[
                                s.temporary ? t('临时') : '',
                                s.temporary && !type && !sessionPreset[s.id] ? t('随机性格') : '',
                                overrides[s.id] || sessionPreset[s.id] || (s.temporary && sessionMbti[s.id])
                                  ? t('本局修改')
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {editSeat && editSeat.id !== 'human' && (
                    <div
                      className="gg-seat-pop"
                      role="dialog"
                      aria-label={t('{name} 的本局设置', { name: editSeat.name })}
                    >
                      <div className="gg-card-head">
                        <b>{t('{seat} 号 · {name}', { seat: slots.indexOf(editSeat) + 1, name: editSeat.name })}</b>
                        <button className="icon-button" aria-label={t('关闭')} onClick={() => setEditing('')}>
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                      <label>
                        {t('本局模型')}
                        <Select
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
                        </Select>
                      </label>
                      <label>
                        {t('本局人格')}
                        <Select
                          aria-label={t('{name} 的本局人格', { name: editSeat.name })}
                          value={sessionPreset[editSeat.id] || ''}
                          onChange={(e) => {
                            const preset = e.target.value;
                            setSessionPreset(({ [editSeat.id]: _old, ...rest }) =>
                              isPresetId(preset) ? { ...rest, [editSeat.id]: preset } : rest,
                            );
                          }}
                        >
                          <option value="">{t(editSeat.temporary ? '不用预设' : '沿用人格档案')}</option>
                          {PRESET_IDS.map((id) => (
                            <option key={id} value={id}>
                              {PRESETS[id].name}
                            </option>
                          ))}
                        </Select>
                      </label>
                      {sessionPreset[editSeat.id] ? (
                        <p className="gg-muted gg-pop-note">{t(PRESETS[sessionPreset[editSeat.id]].summary)}</p>
                      ) : (
                        <label>
                          {t(editSeat.temporary ? '本局性格' : '人格档案')}
                          {personalityPicker(editSeat)}
                        </label>
                      )}
                      <div className="gg-pop-actions">
                        <span className="gg-muted">
                          {t(
                            editSeat.temporary || sessionPreset[editSeat.id]
                              ? '只影响这一局'
                              : '模型只影响这一局；人格沿用 Bot 档案。',
                          )}
                        </span>
                        <span className="gg-spacer" />
                        <button
                          className="gg-back"
                          onClick={() => {
                            setOverrides(({ [editSeat.id]: _model, ...rest }) => rest);
                            setSessionMbti(({ [editSeat.id]: _type, ...rest }) => rest);
                            setSessionPreset(({ [editSeat.id]: _preset, ...rest }) => rest);
                          }}
                        >
                          {t('恢复预设')}
                        </button>
                        {mode === 'play' && (
                          <button
                            className="secondary-button"
                            onClick={() => {
                              setHumanSeat(slots.indexOf(editSeat));
                              setEditing('');
                            }}
                          >
                            {t('和我换座')}
                          </button>
                        )}
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
                              setSelected((ids) => [
                                ...chosen.map((c) => c.id),
                                m.id,
                                ...ids.filter((id) => id !== m.id && !chosen.some((c) => c.id === id)),
                              ]);
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
                    <span className="gg-ok">{t('✓ {count} 位玩家都已就绪', { count: total })}</span>
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
          {screen === 'table' && match && match.mode === 'undercover' && (
            <UndercoverTable
              game={match}
              onUpdate={updateMatch}
              onMutationStart={mutationStart}
              syncError={readError}
              omniscient={omniscient}
              onOmniscient={() => setOmniscient((v) => !v)}
              onClose={() => setOpen(false)}
            />
          )}
          {screen === 'table' && match && match.mode === 'doudizhu' && (
            <DoudizhuTable
              game={match}
              onUpdate={updateMatch}
              onMutationStart={mutationStart}
              syncError={readError}
              omniscient={omniscient}
              onOmniscient={() => setOmniscient((v) => !v)}
              onClose={() => setOpen(false)}
            />
          )}
          {screen === 'table' && match && match.mode === 'mahjong' && (
            <MahjongTable
              game={match}
              onUpdate={updateMatch}
              onMutationStart={mutationStart}
              syncError={readError}
              omniscient={omniscient}
              onOmniscient={() => setOmniscient((v) => !v)}
              onClose={() => setOpen(false)}
            />
          )}
          {screen === 'table' && match && (!match.mode || match.mode === 'werewolf') && (
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

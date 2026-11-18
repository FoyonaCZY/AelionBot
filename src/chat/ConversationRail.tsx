import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { ConversationTurn } from '../../shared/chat/conversation-turns';
import type { ConversationRailDisplay } from '../../shared/preview/appearance';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import { showMessageHit } from './reveal-message';
import { systemAudioSpectrum, useSystemAudio } from './system-audio';
import './conversation-rail.css';

/**
 * The turn being read is the one across this line, as a share of the visible conversation from its top: the middle,
 * where a jump from the rail (showMessageHit) puts the turn it goes to.
 */
const READING_LINE = 0.5;
/** The most a tick grows with the sound, in pixels. */
const WAVE = 10;
/** The bands the ticks show, from the top tick to the bottom one: bass to the treble that music still has. */
const LOW_HZ = 60,
  HIGH_HZ = 12000;

const subscribe = (change: () => void) => {
  window.addEventListener('aelion-appearance-change', change);
  return () => window.removeEventListener('aelion-appearance-change', change);
};
const display = () => (document.documentElement.dataset.conversationRail || 'static') as ConversationRailDisplay;

/**
 * The turn being read: the last one that starts above the reading line, or the last of all at the end of the chat.
 * A long chat renders its start only as the reader scrolls up, so turns before the first rendered one are above it.
 */
function readingTurn(pane: HTMLElement, index: ReadonlyMap<string, number>, count: number) {
  if (!count) return -1;
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 8) return count - 1;
  const line = pane.getBoundingClientRect().top + pane.clientHeight * READING_LINE;
  let reading = -1,
    first = -1;
  for (const node of pane.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const at = index.get(node.dataset.messageId || '');
    if (at === undefined) continue;
    if (first < 0) first = at;
    if (node.getBoundingClientRect().top > line) break;
    reading = at;
  }
  return reading >= 0 ? reading : Math.max(0, first - 1);
}

/**
 * A rail of short lines along the conversation's left edge, one per turn (conversationTurns): longer for turns that
 * said more, dark for the one being read, in the Bot's colour for the ones marked. Hovering one shows what was asked
 * and answered, with a button to mark it; clicking one scrolls to it. With the appearance setting on, the lines in
 * view move with what the computer is playing, bass at the top.
 */
export const ConversationRail = memo(function ConversationRail({
  botId,
  botName,
  turns,
  running,
  pane,
  follow,
}: {
  botId: string;
  botName: string;
  turns: ConversationTurn[];
  /** The Bot is answering the last turn. */
  running: boolean;
  pane: RefObject<HTMLElement | null>;
  follow: RefObject<boolean>;
}) {
  const { t } = useI18n();
  const mode = useSyncExternalStore(subscribe, display),
    shown = mode !== 'hidden' && turns.length > 1,
    audio = useSystemAudio(shown && mode === 'audio');
  const rail = useRef<HTMLElement>(null),
    list = useRef<HTMLDivElement>(null),
    card = useRef<HTMLDivElement>(null);
  const index = useMemo(() => new Map(turns.map((turn, at) => [turn.id, at])), [turns]);
  const latest = useRef({ turns, index });
  latest.current = { turns, index };
  const [reading, setReading] = useState(-1);
  /** The turn whose card is open, and the middle of its tick, in pixels from the rail's top. */
  const [preview, setPreview] = useState<{ id: string; at: number }>();
  /** Marks changed here that the chat has not brought back yet. */
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined),
    hovering = useRef(false),
    measure = useRef(() => {});

  // Follow the reader through the chat.
  useEffect(() => {
    const element = pane.current;
    if (!shown || !element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setReading(readingTurn(element, latest.current.index, latest.current.turns.length));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(update);
    };
    measure.current = schedule;
    element.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    schedule();
    return () => {
      element.removeEventListener('scroll', schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
      measure.current = () => {};
    };
  }, [pane, shown]);
  useEffect(() => measure.current(), [turns]);

  // Keep the tick being read in view when there are more ticks than room, unless the pointer is on them.
  useLayoutEffect(() => {
    const box = list.current,
      tick = box?.children[reading] as HTMLElement | undefined;
    if (!box || !tick || hovering.current) return;
    const top = tick.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + tick.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = top - (box.clientHeight - tick.offsetHeight) / 2;
  }, [reading, shown]);

  // Drop the marks the chat has caught up with.
  useEffect(() => {
    setMarks((current) => {
      const left = Object.entries(current).filter(([id, value]) => turns[index.get(id) ?? -1]?.marked !== value);
      return left.length === Object.keys(current).length ? current : Object.fromEntries(left);
    });
  }, [turns, index]);

  // Move with the sound: the ticks in view, top to bottom, show the spectrum from bass to treble.
  useEffect(() => {
    const box = list.current;
    if (!shown || audio !== 'live' || !box || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const waving = new Map<HTMLElement, number>();
    let frame = requestAnimationFrame(function paint() {
      frame = requestAnimationFrame(paint);
      const spectrum = systemAudioSpectrum();
      if (!spectrum) return;
      const { bins, sampleRate } = spectrum,
        band = sampleRate / 2 / bins.length,
        low = Math.max(1, Math.round(LOW_HZ / band)),
        high = Math.max(low + 1, Math.min(bins.length - 1, Math.round(HIGH_HZ / band)));
      const ticks = box.children,
        step = (ticks[0] as HTMLElement | undefined)?.offsetHeight || 1,
        first = Math.floor(box.scrollTop / step),
        count = Math.max(0, Math.min(ticks.length - first, Math.ceil(box.clientHeight / step) + 1));
      const seen = new Set<HTMLElement>();
      for (let i = 0; i < count; i++) {
        const tick = ticks[first + i] as HTMLElement,
          position = count > 1 ? i / (count - 1) : 0,
          bin = Math.round(low * Math.pow(high / low, position)),
          // Higher bands carry less energy; lift them so the lower ticks move too.
          level = Math.min(1, (bins[bin] / 255) * (0.8 + position * 0.6)),
          wave = Math.round(level * level * WAVE * 2) / 2;
        seen.add(tick);
        if (waving.get(tick) === wave) continue;
        waving.set(tick, wave);
        tick.style.setProperty('--wave', wave + 'px');
      }
      for (const [tick] of waving)
        if (!seen.has(tick)) {
          tick.style.removeProperty('--wave');
          waving.delete(tick);
        }
    });
    return () => {
      cancelAnimationFrame(frame);
      for (const [tick] of waving) tick.style.removeProperty('--wave');
    };
  }, [audio, shown]);

  const turn = preview ? turns[index.get(preview.id) ?? -1] : undefined;
  // Place the card beside its tick, inside the rail's height.
  useLayoutEffect(() => {
    const node = card.current,
      box = rail.current;
    if (!node || !box || !preview) return;
    const height = node.offsetHeight;
    node.style.top = `${Math.max(0, Math.min(preview.at - height / 2, box.clientHeight - height))}px`;
  }, [preview, turn]);

  if (!shown) return null;
  const keep = () => clearTimeout(hideTimer.current);
  const hideSoon = () => {
    keep();
    hideTimer.current = setTimeout(() => setPreview(undefined), 180);
  };
  const open = (item: ConversationTurn, tick: HTMLElement) => {
    keep();
    const top = rail.current?.getBoundingClientRect().top ?? 0,
      box = tick.getBoundingClientRect();
    setPreview({ id: item.id, at: box.top + box.height / 2 - top });
  };
  const jump = (item: ConversationTurn) => {
    follow.current = false;
    void showMessageHit(item.id, true);
  };
  const marked = (item: ConversationTurn) => marks[item.id] ?? item.marked;
  const toggleMark = (item: ConversationTurn) => {
    const next = !marked(item);
    setMarks((current) => ({ ...current, [item.id]: next }));
    window.aelion.markMessage({ botId, messageId: item.id, marked: next }).catch(() =>
      setMarks((current) => {
        const { [item.id]: _, ...rest } = current;
        return rest;
      }),
    );
  };
  const label = (item: ConversationTurn) => item.prompt || t('{name} 说：{text}', { name: botName, text: item.reply });
  const body = turn
    ? turn.prompt
      ? turn.reply || (running && turn === turns.at(-1) ? t('正在回复…') : '')
      : turn.reply
    : '';
  return (
    <nav
      ref={rail}
      className="conversation-rail"
      aria-label={t('对话导航')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && preview) {
          event.stopPropagation();
          setPreview(undefined);
        }
      }}
    >
      <div
        ref={list}
        className="conversation-rail-ticks"
        onPointerEnter={() => (hovering.current = true)}
        onPointerLeave={() => {
          hovering.current = false;
          hideSoon();
        }}
        // One stop for Tab, at the turn being read; the arrows move between turns.
        onKeyDown={(event) => {
          const ticks = [...event.currentTarget.children] as HTMLElement[],
            at = ticks.indexOf(document.activeElement as HTMLElement),
            next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? ticks.length - 1
                  : event.key === 'ArrowUp'
                    ? at - 1
                    : event.key === 'ArrowDown'
                      ? at + 1
                      : -1;
          if (at < 0 || next < 0 || next >= ticks.length) return;
          event.preventDefault();
          ticks[next].focus();
        }}
      >
        {turns.map((item, at) => (
          <button
            key={item.id}
            type="button"
            className={`conversation-rail-tick ${at === reading ? 'is-reading' : ''} ${marked(item) ? 'is-marked' : ''}`}
            style={{ '--weight': item.weight.toFixed(2) } as CSSProperties}
            aria-label={label(item)}
            aria-current={at === reading ? 'location' : undefined}
            tabIndex={at === Math.max(0, reading) ? 0 : -1}
            onPointerEnter={(event) => open(item, event.currentTarget)}
            onFocus={(event) => open(item, event.currentTarget)}
            onBlur={(event) => {
              if (!rail.current?.contains(event.relatedTarget as Node | null)) hideSoon();
            }}
            onClick={() => jump(item)}
          >
            <i />
          </button>
        ))}
      </div>
      {turn && (
        <div
          ref={card}
          className="conversation-rail-card"
          onPointerEnter={keep}
          onPointerLeave={hideSoon}
          onBlur={(event) => {
            if (!rail.current?.contains(event.relatedTarget as Node | null)) hideSoon();
          }}
        >
          <button type="button" className="conversation-rail-card-open" tabIndex={-1} onClick={() => jump(turn)}>
            <strong>{turn.prompt || botName}</strong>
            {body && <span>{body}</span>}
          </button>
          <button
            type="button"
            className="conversation-rail-mark"
            aria-pressed={marked(turn)}
            aria-label={marked(turn) ? t('取消标记') : t('标记这轮对话')}
            title={marked(turn) ? t('取消标记') : t('标记这轮对话')}
            onClick={() => toggleMark(turn)}
          >
            <Icon name="bookmark" size={16} />
          </button>
        </div>
      )}
    </nav>
  );
});

import type { MatchFacts } from './match-facts';

interface AffinityChange {
  botId: string;
  targetId: string;
  value: number;
  durationDays: number;
  source: string;
}
interface HighlightDraft {
  botId: string;
  participants: string[];
  summary: string;
  /** A social fact's name, or 'match' for the match itself. */
  type: string;
}
export interface Settlement {
  affinity: AffinityChange[];
  highlights: HighlightDraft[];
  recap: string;
}
/** The persona identity of a seat: its Bot, 'user' for the human, none for temporary guests. */
const who = (s: MatchFacts['seats'][number]) => (s.human ? 'user' : s.botId);

/**
 * Rule-based settlement of one finished match (docs/ai-personality-module.md §9.6, stage 1), from the facts its
 * game reported. Only unusual events move affinity; being voted out or beaten by the other side is normal play
 * and is not recorded. A match stopped without a result is not settled.
 */
export function settleMatch(m: MatchFacts): Settlement | undefined {
  if (!m.winners) return undefined;
  const winners = m.winners;
  const seat = new Map(m.seats.map((s) => [s.id, s]));
  const fill = (text: string, to: string, from: string[]) =>
    text.replace(/\{(to|from)\}/g, (_, slot) =>
      slot === 'to' ? seat.get(to)!.name : from.map((id) => seat.get(id)!.name).join('、'),
    );
  const affinity: AffinityChange[] = [];
  const highlights: HighlightDraft[] = [];
  const key: string[] = [];
  const semantic =
    m.personaPolicy === 'model_semantic_v1' || m.decisions?.some((d) => d.selectionMethod === 'model_semantic_v1');
  // Affinity from the same kind of event between the same two players counts once per match, however often the
  // game reports it, so a game with many small interactions cannot pile it up. Memories keep every occurrence.
  const counted = new Set<string>();
  const once = (a: AffinityChange) => {
    const id = `${a.source}:${a.botId}:${a.targetId}`;
    if (counted.has(id)) return;
    counted.add(id);
    affinity.push(a);
  };
  for (const e of m.social) {
    if (e.type === 'ally_vote') {
      const out = seat.get(e.to);
      if (!out) continue;
      const mates = e.from.filter((id) => seat.has(id));
      if (!mates.length) continue;
      key.push(fill(e.key, e.to, mates));
      const me = out.botId;
      if (!me) continue;
      for (const id of mates) {
        const target = who(seat.get(id)!);
        if (!target || target === me) continue;
        // The action may be a planned sacrifice or an honest mistake. Record what happened, not a motive.
        if (!semantic)
          once({
            botId: me,
            targetId: target,
            value: -0.4,
            durationDays: 30,
            source: `match:${m.id}:${e.name}`,
          });
      }
      highlights.push({
        botId: me,
        participants: mates.map((id) => who(seat.get(id)!)).filter((x): x is string => !!x),
        summary: fill(e.highlight, e.to, mates),
        type: e.name,
      });
    } else {
      const helped = seat.get(e.to),
        helper = seat.get(e.from);
      if (!helped || !helper) continue;
      key.push(fill(e.key, e.to, [e.from]));
      const me = helped.botId,
        target = who(helper);
      if (!me || !target || target === me) continue;
      once({
        botId: me,
        targetId: target,
        value: 0.3,
        durationDays: 30,
        source: `match:${m.id}:${e.name}`,
      });
      highlights.push({
        botId: me,
        participants: [target],
        summary: fill(e.highlight, e.to, [e.from]),
        type: e.name,
      });
    }
  }
  const won = m.seats.filter((s) => winners.includes(s.team));
  for (const a of won)
    for (const b of won) {
      const me = a.botId,
        target = who(b);
      if (a === b || a.team !== b.team || !me || !target || target === me) continue;
      affinity.push({
        botId: me,
        targetId: target,
        value: 0.1,
        durationDays: 14,
        source: `match:${m.id}:won_together`,
      });
    }
  const lineup = m.seats.map((s) => `${s.name}（${s.role}）`).join('、');
  for (const s of m.seats) {
    if (!s.botId) continue;
    highlights.push({
      botId: s.botId,
      participants: m.seats
        .filter((o) => o !== s)
        .map(who)
        .filter((x): x is string => !!x),
      summary: `一局${m.game}：你是${s.role}，${winners.includes(s.team) ? '赢了' : '输了'}（${m.result}）${key.length ? '；' + key.join('；') : ''}`,
      type: 'match',
    });
  }
  const recap = [
    `${m.game}战报：${m.result}。`,
    `身份：${lineup}。`,
    ...(m.details || []),
    ...(key.length ? [`关键事件：${key.join('；')}。`] : []),
  ].join('\n');
  return { affinity, highlights, recap };
}

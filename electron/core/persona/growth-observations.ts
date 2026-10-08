import { createHash } from 'node:crypto';
import type { WerewolfState } from '../games/werewolf';
import type { GrowthObservation } from '../../../shared/types/persona-growth-types';

/** Capture only accepted model actions with a recorded, actually dispatched player view. */
export function collectGrowthObservations(match: WerewolfState): GrowthObservation[] {
  if (match.status !== 'finished' || !match.winner || match.personaPolicy !== 'model_semantic_v1') return [];
  const result: GrowthObservation[] = [];
  const trace = match.trace || [];
  const aliases = match.seats.map((s, i) => ({ id: s.id, name: s.name, alias: `${i + 1}号玩家` }));
  const alias = (id: unknown) => aliases.find((s) => s.id === id)?.alias;
  const clean = (text: string, max: number) => {
    for (const seat of [...aliases].sort((a, b) => b.name.length - a.name.length))
      if (seat.name && seat.name !== '你') text = text.split(seat.name).join(seat.alias);
    for (const seat of [...aliases].sort((a, b) => b.id.length - a.id.length))
      text = text.split(seat.id).join(seat.alias);
    return text.slice(0, max);
  };
  const seen = new Set<string>();
  for (const accepted of trace) {
    if (
      accepted.type !== 'action_accepted' ||
      !accepted.requestId ||
      !accepted.seatId ||
      !accepted.kind ||
      !accepted.action
    )
      continue;
    const seat = match.seats.find((s) => s.id === accepted.seatId);
    if (!seat?.botId || seat.human || !match.persona?.[seat.id] || seen.has(accepted.requestId)) continue;
    const started = trace
      .filter(
        (e) =>
          e.type === 'model_started' &&
          e.requestId === accepted.requestId &&
          e.seatId === seat.id &&
          e.seq < accepted.seq,
      )
      .at(-1);
    if (!started?.requestCaptured || !started.input) continue;
    try {
      const input = JSON.parse(started.input);
      const shared = input.context?.shared,
        personal = input.context?.personal,
        request = input.request;
      // A late final-state reconstruction or another player's view must not become evidence.
      if (
        input.you !== seat.id ||
        personal?.self?.id !== seat.id ||
        personal.self.role !== seat.role ||
        request?.seatId !== seat.id ||
        request.kind !== accepted.kind ||
        !Array.isArray(request.targets)
      )
        continue;
      const action = accepted.action;
      const behavior = JSON.stringify({
        ...(typeof action.text === 'string' ? { text: clean(action.text, 2200) } : {}),
        ...(typeof action.target === 'string' ? { target: alias(action.target) } : {}),
        ...(action.potion !== undefined ? { potion: action.potion } : {}),
        ...(action.choice !== undefined ? { choice: action.choice } : {}),
        ...(action.skip !== undefined ? { skip: action.skip } : {}),
        ...(action.direction !== undefined ? { direction: action.direction } : {}),
      });
      if (behavior === '{}') continue;
      const logs = (entries: unknown) =>
        Array.isArray(entries)
          ? entries.slice(-4).map((entry) => ({
              day: entry.day,
              phase: entry.phase,
              speaker: alias(entry.seatId),
              text: clean(typeof entry.text === 'string' ? entry.text : '', 350),
            }))
          : [];
      const text = JSON.stringify({
        behavior: JSON.parse(behavior),
        context: {
          you: alias(seat.id),
          role: personal.self.role,
          day: started.day,
          phase: started.phase,
          request: {
            kind: request.kind,
            targets: request.targets.map(alias).filter(Boolean),
            ...(request.witch
              ? {
                  witch: {
                    victim: alias(request.witch.victim),
                    canSave: request.witch.canSave,
                    canPoison: request.witch.canPoison,
                  },
                }
              : {}),
            ...(request.discussionRound ? { discussionRound: request.discussionRound } : {}),
          },
          players: Array.isArray(shared?.seats)
            ? shared.seats.map((p: { id: string; alive: boolean; role?: string }) => ({
                player: alias(p.id),
                alive: p.alive,
                ...(p.role ? { revealedRole: p.role } : {}),
              }))
            : [],
          teammates: Array.isArray(personal.teammates)
            ? personal.teammates.map((p: { id: string }) => alias(p.id)).filter(Boolean)
            : [],
          sharedLog: logs(shared?.logs),
          personalLog: logs(personal.logs),
          contextTruncated: true,
        },
      });
      result.push({
        id: createHash('sha256').update(`${match.id}:${seat.id}:${accepted.requestId}`).digest('hex'),
        botId: seat.botId,
        matchId: match.id,
        createdAt: accepted.time,
        role: seat.role,
        kind: accepted.kind,
        day: started.day,
        behavior,
        text,
      });
      seen.add(accepted.requestId);
    } catch {
      /* Missing or malformed dispatch context is not growth evidence. */
    }
  }
  // Cover early and late behavior, with equal per-match volume so one long game does not dominate.
  return match.seats.flatMap((seat) => {
    const own = result.filter((o) => o.botId === seat.botId);
    if (own.length <= 20) return own;
    return Array.from({ length: 20 }, (_, i) => own[Math.floor((i * (own.length - 1)) / 19)]);
  });
}

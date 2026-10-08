import { TRAITS, type Trait, type Traits } from '../../shared/persona/persona-model';
import type { PersonaEpisode, PersonaView } from '../../shared/types/persona-types';
import { TRAIT_SEMANTICS, traitBand } from '../../shared/persona/persona-semantics';

export const traitName = (k: Trait) => TRAIT_SEMANTICS[k].name;
/** Everyday words for the two ends of each trait, low end first, so the scale reads without knowing the theory. */
export const TRAIT_POLES: Record<Trait, [string, string]> = {
  E: ['内向', '外向'],
  A: ['冷淡', '亲和'],
  C: ['随性', '严谨'],
  N: ['沉稳', '敏感'],
  O: ['熟悉', '求新'],
};
/** Domain summaries use the same definitions as the model prompt. */
export const traitHint = (k: Trait, v: number) => TRAIT_SEMANTICS[k].hints[traitBand(v)];

/**
 * The soul shape: five lobes, one per trait, radius growing with the trait. A floor keeps low traits visible, and the
 * curve is a closed Catmull-Rom spline so the outline reads as the same soft blob language as the avatar.
 */
export function soulPath(t: Traits, size = 160, floor = 0.42) {
  const c = size / 2,
    r = size * 0.44;
  const points = TRAITS.map((k, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / TRAITS.length,
      d = r * (floor + (1 - floor) * Math.min(1, Math.max(0, t[k])));
    return [c + Math.cos(a) * d, c + Math.sin(a) * d] as const;
  });
  const n = points.length,
    at = (i: number) => points[(i + n) % n];
  let path = `M${at(0)[0].toFixed(1)} ${at(0)[1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    path += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return path + 'Z';
}
/** Signed change with an explicit sign; changes below 0.001 read as no change. */
export function signed(x: number, digits = 2) {
  const v = Number(x.toFixed(digits));
  if (Math.abs(v) < 10 ** -digits / 2 || v === 0) return '0';
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(digits);
}
/** The trait an experience moved most, e.g. 「外向 +0.004」; undefined when nothing moved. */
export function episodeChange(e: PersonaEpisode) {
  const top = TRAITS.map((k) => [k, e.delta[k] || 0] as const).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  return Math.abs(top[1]) < 0.0005 ? undefined : `${traitName(top[0])} ${signed(top[1], 3)}`;
}
export const episodeSource = (e: PersonaEpisode) =>
  e.kind === 'growth_review'
    ? '成长评估'
    : e.kind === 'growth_review_undo'
      ? '撤销成长'
      : e.scope === 'chat'
        ? '群聊'
        : '游戏';
/** A retained assessment is an audit; show its conclusion only while it still describes the current profile. */
export function growthSummary(view: PersonaView): string {
  const profile = view.profile,
    review = view.growthReview?.latest;
  const same = (a: Traits, b: Traits) => TRAITS.every((key) => Math.abs(a[key] - b[key]) < 1e-9);
  if (review && ['applied', 'unchanged', 'reverted'].includes(review.status) && review.completedAt !== undefined) {
    const expectedCount = review.nBefore + (review.status === 'applied' ? 1 : review.status === 'reverted' ? -1 : 0);
    const validDelta = TRAITS.every(
      (key) => Math.abs(review.before[key] + review.delta[key] - review.after[key]) < 1e-9,
    );
    const validChange =
      review.status === 'unchanged' ? same(review.before, review.after) : !same(review.before, review.after);
    // A reset after reversal, or a manual save of identical values, cannot be detected from the numbers alone.
    let mutation = -1,
      matchingChange = -1;
    view.history.forEach((point, index) => {
      if (['重置成长', '手动设定', '角色设定估计'].includes(point.reason)) mutation = index;
      if (
        point.createdAt === review.completedAt &&
        same(point.traits, review.after) &&
        point.reason === (review.status === 'reverted' ? '撤回跨经历成长' : '跨经历成长评估')
      )
        matchingChange = index;
    });
    const mutationAt = mutation < 0 ? -Infinity : view.history[mutation].createdAt;
    const predatesMutation =
      mutationAt > review.completedAt || (mutationAt === review.completedAt && matchingChange <= mutation);
    if (
      !predatesMutation &&
      review.botId === profile.botId &&
      profile.n === expectedCount &&
      validDelta &&
      validChange &&
      same(profile.traits, review.after) &&
      same(profile.anchor, review.anchor)
    )
      return review.summary;
  }
  return same(profile.traits, profile.anchor)
    ? '当前人格与出生时一致；经历仍在积累。'
    : '人格已有变化，可从曲线和历史记录回看。';
}
/** Same wording as the group-chat fragment (persona-service affinityWord), so the page and the Bot agree. */
export function relationWord(v: number) {
  return v >= 0.5 ? '很好' : v >= 0.15 ? '不错' : v <= -0.5 ? '很差' : v <= -0.15 ? '有芥蒂' : '一般';
}
export function statusText(v: PersonaView) {
  const p = v.profile;
  if (!p.confirmed)
    return p.source === 'bfi2' ? '初稿 · 模型按角色设定估计，待你确认' : '初稿 · 由游戏预设生成，待你确认';
  return p.locked ? '已确认 · 成长已锁定' : '已确认';
}
/**
 * Points for one trait's line in the growth chart, over the recorded history. The birth value is the middle of the
 * chart and `span` is the whole height in trait units.
 */
export function historyPoints(v: PersonaView, k: Trait, width: number, height: number, span = 0.2) {
  const h = v.history.length ? v.history : [{ traits: v.profile.traits, createdAt: v.profile.updatedAt, reason: '' }];
  const base = v.profile.anchor[k];
  return h.map((p, i) => {
    const x = h.length === 1 ? width : (i / (h.length - 1)) * width,
      y = height / 2 - ((p.traits[k] - base) / span) * height;
    return [x, Math.min(height, Math.max(0, y))] as const;
  });
}
/**
 * How far above and below the birth value the growth charts reach, in trait units. Real growth is small (at most 0.02
 * a day per trait), so a 0–1 scale would draw flat lines. The reach fits the largest move so far with 20% headroom,
 * rounded up to 0.01, and never drops below 0.02 so one day of game growth still fits. All five charts share it, so
 * their lines can be compared with each other.
 */
export function historyRange(v: PersonaView, floor = 0.02) {
  const moved = Math.max(
    0,
    ...v.history.flatMap((p) => TRAITS.map((k) => Math.abs(p.traits[k] - v.profile.anchor[k]))),
  );
  return Math.max(floor, Math.ceil(moved * 1.2 * 100 - 1e-9) / 100);
}
export const dateText = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

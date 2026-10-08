/**
 * Role-setting estimate using BFI-2 facet definitions, not a BFI-2 questionnaire administration.
 * Fifteen model ratings are averaged into five settings. Neither this shortcut nor its
 * application to Bots inherits the human questionnaire's psychometric validation.
 */
import { TRAITS, roundTraits, type Traits } from '../../../shared/persona/persona-model';
import { TRAIT_SEMANTICS } from '../../../shared/persona/persona-semantics';

export function birthPrompt(name: string, soul: string) {
  const facets = TRAITS.map((t) => {
    const domain = TRAIT_SEMANTICS[t];
    return `${domain.name}：${domain.definition}\n${domain.facets.map((f, i) => `${t}${i + 1}. ${f}`).join('\n')}`;
  }).join('\n');
  return {
    system:
      '你是角色设定助手。参照 BFI-2 的维度和侧面定义，估计角色的典型倾向。这是角色设定估计，不是标准量表测量。侧面中的抑郁指低落倾向，不作疾病诊断。给每个侧面的典型程度打分，1 = 非常不符合，5 = 非常符合。只依据设定里写到或能直接推出的内容；设定没有涉及的侧面打 3。仅返回 JSON，形如 {"E1":3,"E2":4,...,"O3":2}，不要输出其他文字。',
    user: `角色名：${name}\n角色设定（SOUL.md）：\n${soul.slice(0, 6000)}\n\n侧面：\n${facets}`,
  };
}
/** Mean of three 1–5 facet ratings per domain, mapped linearly to 0–1. Missing or invalid ratings count as 3. */
export function traitsFromFacets(raw: string): Traits {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const span = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const scores = JSON.parse(span) as Record<string, unknown>;
  if (!scores || typeof scores !== 'object') throw Error('人格估计结果无效');
  const rating = (k: string) => {
    const v = Number(scores[k]);
    return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
  };
  const answered = TRAITS.flatMap((t) => [1, 2, 3].map((i) => `${t}${i}`)).filter((k) => k in scores).length;
  if (answered < 10) throw Error('人格估计结果不完整');
  return roundTraits(
    Object.fromEntries(
      TRAITS.map((t) => [t, ([1, 2, 3].reduce((a, i) => a + rating(`${t}${i}`), 0) / 3 - 1) / 4]),
    ) as Traits,
  );
}

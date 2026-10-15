/**
 * How a message aimed at a member changes that member's feelings towards the sender (docs: 群聊人格方案 §3.6).
 *
 * Structure follows game opinion systems: each event adds one decaying modifier (Crusader Kings III, RimWorld).
 * Weights follow the forgiveness literature: whether harm was intended matters most and apology next
 * (Fehr, Gelfand & Nag, 2010); revenge fades over time while goodwill does not return by itself
 * (McCullough, Fincham & Tsang, 2003); low agreeableness and high neuroticism make grudges last
 * (McCullough et al., 2001; Hodge et al., 2020, r = .44 and −.28). Base values are product settings to calibrate.
 */
import type { Traits } from '../../../shared/persona/persona-model';

export const APPRAISAL_TYPES = ['insult', 'offense', 'argument', 'thanks', 'help', 'apology', 'none'] as const;
export type AppraisalType = (typeof APPRAISAL_TYPES)[number];

interface Kind {
  /** What the classifier is told this type means, for the member the message is aimed at. */
  criterion: string;
  /** Affinity change at full intensity, before the neuroticism amplification of negative events. */
  value: number;
  days: number;
  /** Name in memories, e.g. 「骂了你」. */
  verb: string;
}
export const APPRAISAL_KINDS: Record<Exclude<AppraisalType, 'none'>, Kind> = {
  insult: { criterion: '辱骂或人身攻击：骂人、侮辱人格或能力', value: -0.5, days: 60, verb: '骂了你' },
  offense: {
    criterion: '冒犯：嘲讽、贬低、不耐烦地呵斥，或用游戏外的东西施压',
    value: -0.3,
    days: 30,
    verb: '冒犯了你',
  },
  argument: { criterion: '争执：言辞激烈地反驳，但没有攻击人', value: -0.1, days: 7, verb: '和你争执' },
  thanks: { criterion: '感谢或夸奖', value: 0.1, days: 14, verb: '感谢了你' },
  help: { criterion: '帮助：帮它解决问题，或完成了它的请求', value: 0.15, days: 30, verb: '帮了你' },
  apology: { criterion: '道歉', value: 0.2, days: 30, verb: '向你道歉' },
};
const NONE_CRITERION = '其他：普通交流、玩笑、无恶意的调侃，或游戏规则内的正常博弈（指认、投票、悍跳）';

/** The question every classifier answers, as Laya choice criteria. */
export function appraisalCriteria(): Record<AppraisalType, string> {
  return {
    ...Object.fromEntries(Object.entries(APPRAISAL_KINDS).map(([k, v]) => [k, v.criterion])),
    none: NONE_CRITERION,
  } as Record<AppraisalType, string>;
}
export const APPRAISAL_INSTRUCTIONS =
  '判断 message 对 target 来说属于哪一类。只看 message 本身对 target 的态度；对别人说的话、泛泛的抱怨都算其他。游戏里指认、投票、悍跳是规则内的博弈，算其他；只有辱骂、人身攻击、拿游戏外的东西施压才算冒犯或辱骂。';

/** Prompt for a main model when the local classifier is not available. */
export function appraisalPrompt(input: AppraisalInput) {
  const kinds = Object.entries(appraisalCriteria())
    .map(([k, v]) => `${k}：${v}`)
    .join('\n');
  return {
    system: `${APPRAISAL_INSTRUCTIONS}\n类别：\n${kinds}\n另外给出 intent（是否故意，0–1）和 severity（严重程度，0–1）。仅返回 JSON：{"type":"类别","intent":0.8,"severity":0.5}`,
    user: JSON.stringify(input),
  };
}
export interface AppraisalInput {
  target: string;
  sender: string;
  message: string;
  repliedTo?: string;
  /** Set for a line said inside a game, so in-game play is told apart from crossing the line. */
  game?: string;
}
export interface Appraisal {
  type: AppraisalType;
  /** 0–1: confidence of the local classifier, or intent × severity from a model. */
  intensity: number;
}
export function parseAppraisal(raw: string): Appraisal {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>;
  const type = APPRAISAL_TYPES.includes(parsed.type as AppraisalType) ? (parsed.type as AppraisalType) : 'none';
  const unit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
  return { type, intensity: unit(parsed.intent) * unit(parsed.severity) };
}

/**
 * How long this member holds on to it: 0.5–1.5 times the base. Agreeableness weighs more than neuroticism,
 * about 6 to 4, matching the effect sizes above.
 */
export const grudgeFactor = (t: Traits) => Math.round((0.5 + 0.6 * (1 - t.A) + 0.4 * t.N) * 1000) / 1000;

/** The modifier one appraisal adds, or undefined when it changes nothing. */
export function appraisalModifier(a: Appraisal, traits: Traits) {
  if (a.type === 'none' || a.intensity <= 0) return undefined;
  const kind = APPRAISAL_KINDS[a.type];
  // Intensity scales between half and full strength: even a mild insult is still an insult.
  const scale = 0.5 + 0.5 * a.intensity;
  const value = kind.value * scale;
  return {
    value: Math.round(value * 1000) / 1000,
    durationDays: Math.round((value < 0 ? kind.days * grudgeFactor(traits) : kind.days) * 10) / 10,
  };
}

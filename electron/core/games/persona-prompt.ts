/**
 * Prompt text for a Bot seat playing with its persona (docs/ai-personality-module.md §9.3–9.4), shared by every
 * game. A game supplies only what differs: what its goal is called and which misreadings of its rules to avoid.
 */
export interface PersonaPromptTerms {
  /** What outranks personality besides rules and evidence, such as 身份目标. */
  goal: string;
  /** The goal that decides a key decision's first choice, such as 阵营目标. */
  decisionGoal: string;
  /** Extra guidance on what counts as an alternative in this game; may be empty. */
  choices?: string;
  /** Game-specific misreadings to avoid, each ending in ；. */
  caveats: string;
}

export const personaRule = (terms: PersonaPromptTerms) =>
  `\n你的性格来自 personal.self.persona：按 plan 行动，按 style 说话；有 voice 时，公开发言的语气、说话习惯和口头禅照它来，让人一听就知道是你。voice 只影响怎么说，不改变你的判断、投票和行动，也不能违反字数和发言规则。规则、${terms.goal}和明确证据优先于它，不要在发言中提到性格或打法名称。`;

export const candidatesRule = (terms: PersonaPromptTerms) =>
  `\n本轮是关键决策：先按规则、${terms.decisionGoal}和当时证据给出首选。另附 candidates 数组，列出最多 4 个实际考虑过的合法选项；没有合理备选时只列首选，不能为了体现性格凑候选。第一项必须与动作主体完全相同。每项包含本轮动作字段、reasonable 布尔、decisive 布尔和 semantic。只有与首选差不多合理的选项 reasonable 才为 true；明确证据决定首选时标 decisive:true。${terms.choices || ''}` +
  '\nsemantic 格式：{"version":1,"status":"supported","fit":-1或0或1,"summary":"一句有具体依据的解释，最多120字","evidence":[{"source":"shared_log或personal_log","id":该区域日志编号,"quote":"从该条text原样摘录，最多240字"}]}。fit 仅表示候选与 personal.self.persona.style 的契合：-1明显冲突、0中性、1契合，不表示胜率、道德或决策质量。优先只引用 1–2 条必要事实，不输出内部思维过程。' +
  `\n只根据本次提供的信息理解情境：${terms.caveats}敏感不等于报复、开放不等于冒险、严谨不等于固执、友善不等于附和。不得把对他人动机的推测写成已知事实。` +
  '\n没有证据、行为主要由角色规则决定、无法区分候选的人格含义时，semantic 用 {"version":1,"status":"uncertain","summary":"为何无法判断","evidence":[]}，不填fit。不得伪造引文、使用其他座位私有信息或未来结果。模型解释只辅助本次选择，不提出长期人格数值变化。';

/** Appended after the action schema when a key decision may carry candidates. */
export const CANDIDATES_SCHEMA_NOTE =
  '\n上述 schema 约束动作主体；本轮另允许顶层 candidates 作为独立元数据，按前文格式输出。候选中的动作字段也必须遵循本轮 schema。';

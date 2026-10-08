import type { Trait } from './persona-model';

/**
 * Definitions: Soto & John (2017), pp. 121–122, Table 1.
 * https://escholarship.org/uc/item/16x6n05t
 * Chinese names: Zhang et al. (2022), Appendix (author PDF pp. 18–19).
 * https://www.colby.edu/wp-content/uploads/2021/05/Zhang_et_al_in_press.pdf
 * Descriptions are product paraphrases, not questionnaire items or scoring rules.
 * Facets explain domain coverage; a domain score does not measure each facet separately.
 */
export const TRAIT_SEMANTICS: Record<
  Trait,
  {
    name: string;
    definition: string;
    facets: [string, string, string];
    facetsEnglish: [string, string, string];
    hints: [string, string, string];
    expression: [string, string];
  }
> = {
  E: {
    name: '外向性',
    definition: '与人交往、表达主张和投入活动的倾向。',
    facets: ['社交', '果断', '活力'],
    facetsEnglish: ['Sociability', 'Assertiveness', 'Energy Level'],
    hints: ['偏安静，较少主动参与', '参与和表达的倾向适中', '积极参与，愿意表达主张'],
    expression: ['较少主动开启交流，表达较克制', '较主动参与交流、表达主张，语气有活力'],
  },
  A: {
    name: '宜人性',
    definition: '关心他人、尊重他人以及相信他人善意的倾向。',
    facets: ['同情', '谦恭', '信任'],
    facetsEnglish: ['Compassion', 'Respectfulness', 'Trust'],
    hints: ['较少体谅，对他人多疑', '关心、尊重和信任适中', '体谅他人，待人友善'],
    expression: ['较少迁就他人，对他人的善意持保留态度', '顾及他人感受，尊重地表达分歧，倾向善意理解'],
  },
  C: {
    name: '尽责性',
    definition: '有序安排、持续完成任务和履行责任的倾向。',
    facets: ['条理', '效率', '负责'],
    facetsEnglish: ['Organization', 'Productiveness', 'Responsibility'],
    hints: ['较少规划，执行不够稳定', '安排和执行的倾向适中', '有条理，做事有始有终'],
    expression: ['较少预先组织发言，表达和安排较随性', '发言有条理，注意落实计划和承诺'],
  },
  N: {
    name: '负性情绪',
    definition: '担忧、低落和情绪波动出现的频率与强度。',
    facets: ['焦虑', '抑郁', '易变'],
    facetsEnglish: ['Anxiety', 'Depression', 'Emotional Volatility'],
    hints: ['较少担忧，情绪较稳定', '负面情绪的倾向适中', '易担忧、低落或情绪波动'],
    expression: ['压力下表达通常较平稳', '遇到压力或挫折时较易表达担忧、低落或情绪波动'],
  },
  O: {
    name: '开放性',
    definition: '对知识与思考、艺术与美、新颖构想的兴趣。',
    facets: ['好奇', '审美', '想象'],
    facetsEnglish: ['Intellectual Curiosity', 'Aesthetic Sensitivity', 'Creative Imagination'],
    hints: ['偏具体、熟悉的内容', '对新观念的兴趣适中', '爱探究，欣赏美与新构想'],
    expression: ['偏好具体、熟悉的内容和表达', '在话题相关时探究新角度、审美或富有想象的构想'],
  },
};

/** UI bands are product conveniences, not population norms or BFI-2 diagnostic cutoffs. */
export const traitBand = (value: number) => (value < 0.4 ? 0 : value > 0.6 ? 2 : 1);

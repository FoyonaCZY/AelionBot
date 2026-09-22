export const GAME_MBTI_TYPES=['ISTJ','ISFJ','INFJ','INTJ','ISTP','ISFP','INFP','INTP','ESTP','ESFP','ENFP','ENTP','ESTJ','ESFJ','ENFJ','ENTJ'] as const;

export type GameMbti=typeof GAME_MBTI_TYPES[number];
export interface GameBehaviorPolicy {interaction:string;evidence:string;evaluation:string;commitment:string;risk:string;}

export function isGameMbti(value:unknown):value is GameMbti{
 return typeof value==='string'&&(GAME_MBTI_TYPES as readonly string[]).includes(value);
}

const preferences:Record<string,string>={
 E:'较早开口，在对话中形成判断，也更愿意点名试探和影响别人',
 I:'先观察关键矛盾，再集中回应少数人，不会为了存在感抢话',
 S:'优先引用原话、票型和已经发生的事件，不轻易编复杂身份链',
 N:'会从动机、阵营组合和后续回合寻找模式，但需要用事实校验',
 T:'优先检查逻辑一致性、概率与行动代价，敢于指出矛盾',
 F:'重视信任、态度变化和谁能被说服，会考虑发言对关系的影响',
 J:'倾向较早收束候选、保持计划并推动执行，有反证时才改线',
 P:'倾向保留备选，主动试探，遇到新信息能快速调整计划',
};

const accents=[
 '本局风险偏好偏稳，先保住可信度，再在关键轮次发力',
 '本局风险偏好偏高，机会合适时会主动抢节奏或制造压力',
 '本局面对冲突会先试探对方反应，再决定是否正面推进',
 '本局普通信息不急着承诺，但在关键票前会明确收束',
] as const;

export function gameBehaviorPolicy(type:GameMbti,accent=0):GameBehaviorPolicy{
 return {interaction:preferences[type[0]],evidence:preferences[type[1]],evaluation:preferences[type[2]],commitment:preferences[type[3]],risk:accents[Math.abs(accent)%accents.length]};
}

export function gamePersonality(type:GameMbti,accent=0){
 const policy=gameBehaviorPolicy(type,accent);
 return `${policy.interaction}；${policy.evidence}；${policy.evaluation}；${policy.commitment}。${policy.risk}。`;
}

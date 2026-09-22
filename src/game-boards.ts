import type {GameRole,GameRequest,GamePhase} from './game-types';
export const ROLE_NAMES:Record<GameRole,string>={wolf:'狼人',seer:'预言家',witch:'女巫',hunter:'猎人',idiot:'白痴',guard:'守卫',villager:'村民'};
export const PHASE_NAMES:Record<GamePhase,string>={night:'夜间行动',election:'警长竞选',resolution:'出局结算',speech:'白天发言',vote:'放逐投票',finished:'对局结束'};
export const ACTION_NAMES:Record<GameRequest['kind'],string>={wolf_plan:'狼队夜聊',kill:'袭击',inspect:'查验',witch:'用药',guard:'守护',speak:'发言',vote:'放逐投票',sheriff_join:'上警报名',campaign:'竞选发言',withdraw:'退水选择',sheriff_vote:'警长投票',sheriff_order:'决定发言顺序',badge:'移交警徽',shoot:'猎人开枪',last_words:'遗言',pk_speak:'平票 PK 发言'};
export const BOARDS={
 standard12:{name:'预女猎白',description:'4 狼 · 4 民 · 预言家 · 女巫 · 猎人 · 白痴',roles:['wolf','wolf','wolf','wolf','villager','villager','villager','villager','seer','witch','hunter','idiot'] as GameRole[]},
 guard12:{name:'预女猎守',description:'4 狼 · 4 民 · 预言家 · 女巫 · 猎人 · 守卫',roles:['wolf','wolf','wolf','wolf','villager','villager','villager','villager','seer','witch','hunter','guard'] as GameRole[]},
};
export const TWELVE_RULES='12 人屠边局：狼人全部出局则好人胜；四民或四神全部出局则狼人胜。首夜结算暂不公布死讯，先全员上警报名、竞选发言、退水，再由未报名玩家投票；退水者不投警长票。警长平票进行一次 PK，再平票或无人投票则无警长；仅一位候选人直接当选。选举后公布首夜死讯。警长放逐票计 1.5 票，每天选择从自己相邻存活座位起顺时针或逆时针发言，自己最后；无警长按座位顺序。警长出局或白痴翻牌时可移交警徽给仍有投票权的存活玩家，或撕毁；不重选。放逐平票者 PK 一轮，其他有投票权者重投，再平票或全弃权则无人出局。猎人被刀或放逐可开枪，被毒不能开枪；白痴首次被放逐自动翻牌免死，失去投票权和被放逐资格。守卫可自守或空守，不能连续两夜守同一人；守救同中狼刀者仍死，毒无视守护。女巫一晚最多一药，全程不能自救，解药耗尽后看不到刀口。首夜死者和被放逐者有遗言，其他夜死及枪杀无遗言。先处理死亡及猎人技能再判胜负。狼人可自刀，多数刀口优先、平票按座位序；本版暂不开放自爆。真人发言120秒，AI发言60秒，其他行动45秒；超时跳过发言、弃票、放弃技能或撕毁警徽，顺序默认顺时针。';

import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import type {GameView,GameRequest} from '../../../src/game-types';
const roots=[resolve(typeof __dirname==='string'?__dirname:process.cwd(),'../assets/game-skills/werewolf'),resolve(process.cwd(),'assets/game-skills/werewolf')];
const directory=roots.find(p=>existsSync(join(p,'SKILL.md')));
const titles:Record<string,string>={wolf:'狼人策略',seer:'预言家策略',witch:'女巫策略',villager:'村民策略'};
const cache=new Map<string,{id:string;title:string;version:string;content:string}>();
function read(id:string,title:string,file:string){let skill=cache.get(id);if(!skill){if(!directory)throw Error('狼人杀技能文件缺失，请检查安装资源');const content=readFileSync(join(directory,file),'utf8');skill={id,title,version:createHash('sha256').update(content).digest('hex').slice(0,12),content};cache.set(id,skill);}return skill;}
export function gameSkills(context:GameView,request:GameRequest){const role=context.seats.find(p=>p.id===request.seatId)?.role;if(!role)throw Error('玩家缺少自己的身份，无法加载攻略');return [
 read('werewolf-player','通用对局技巧','SKILL.md'),
 ...Object.entries(titles).map(([id,title])=>read('werewolf-'+id,title,'references/'+id+'.md')),
 ...(context.board?[read('werewolf-twelve','十二人警长与神职策略','references/twelve.md')]:[]),
 read('werewolf-playbook','共享打法手册','references/playbook.md'),
];}

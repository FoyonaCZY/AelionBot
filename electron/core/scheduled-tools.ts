import type {ToolDefinition} from './model';
const string={type:'string'};
const schedule={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['once','daily','weekly','interval']},timeZone:{...string,description:'IANA 时区，例如 Asia/Shanghai。未指定时使用当前系统时区。'},at:{...string,description:'once：包含时区的 ISO 8601 日期时间，例如 2026-09-08T09:00:00+08:00'},time:{...string,description:'daily/weekly：24 小时制 HH:mm'},weekdays:{type:'array',items:{type:'integer',minimum:0,maximum:6},description:'weekly：0=周日，1–6=周一至周六；工作日为 [1,2,3,4,5]'},minutes:{type:'integer',minimum:1,maximum:525600,description:'interval：间隔分钟数'}},required:['kind','timeZone']};
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]):ToolDefinition=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const SCHEDULED_TOOLS:ToolDefinition[]=[
  tool('scheduled_tasks_list','查看当前单聊或群聊已保存的定时任务及状态。创建前按需检查已有计划，避免重复。',{},[]),
  tool('scheduled_task_create','为当前会话创建定时任务。可按用户需求主动安排后续任务或提醒；单聊由自己执行，群聊由群成员协作，结果发回原会话。prompt 写清届时需要完成的任务，不要写成再次创建计划的指令。只在成功返回后确认已安排。应用运行时调度，工具权限不会因定时执行自动放宽。',{title:{...string,maxLength:80},prompt:{...string,maxLength:8000},schedule},['title','prompt','schedule']),
  tool('scheduled_task_update','修改当前会话的定时任务。id 来自列表或创建结果。status=paused 暂停，enabled 恢复，completed 结束计划；不取消已开始的本次执行。完成持续监测目标时可结束相应计划。',{id:string,title:string,prompt:string,schedule,status:{type:'string',enum:['enabled','paused','completed']}},['id']),
  tool('scheduled_task_delete','删除当前会话的定时任务，停止之后的触发；已开始的本次任务不会撤销。',{id:string},['id'])
];

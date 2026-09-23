import type {ToolDefinition} from './model';
const string={type:'string'};
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]):ToolDefinition=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const GROUP_PROTOCOL_TOOLS=[
 tool('group_outbox','查看自己在该群最近的发件回执；pending 尚未公开，sent 才已送达。不要用它轮询其他成员。',{groupId:string},['groupId']),
 tool('group_tasks','按需查看群任务表。先查已有分工再认领，避免重复工作；所有成员都能补充或反驳，无需认领才能发言。',{groupId:string,offset:{type:'integer',minimum:0}},['groupId']),
 tool('group_task_claim','认领当前群的一项具体工作。续接使用 taskId；新任务提供稳定的 key、明确的 title 和原始用户任务 sourceMessageId。同一 key 只有一位负责人，claimed=false 时不要重复执行。认领不是完成，不新增授权；持续执行到完成或记录阻碍。',{groupId:string,taskId:string,key:string,title:string,sourceMessageId:string},['groupId']),
 tool('group_task_update','更新自己认领的群任务。revision 必须使用最新版本；冲突返回当前记录。summary 会公开：只填写任务相关的进展、结果或阻碍，完成时写明验证依据和文档位置；open 表示释放认领，blocked 表示需等待，working 表示继续执行。',{groupId:string,taskId:string,revision:{type:'integer',minimum:0},status:{type:'string',enum:['working','blocked','completed','open']},summary:string},['groupId','taskId','revision','status','summary']),
];
export const groupProtocolTool=(name:string)=>GROUP_PROTOCOL_TOOLS.some(t=>t.function.name===name);

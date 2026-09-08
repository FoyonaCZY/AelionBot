import type {ChatMessage,RunRecord} from './shared';
import {isContextCapacityFailure} from './context-issue';

const operations:Record<string,{label:string;active:string;icon:string}>={
  execution_list:{label:'核对执行记录',active:'正在核对执行记录',icon:'check'},
  execution_resolve:{label:'核对问题处理结果',active:'正在核对问题处理结果',icon:'check'},
  tools_batch:{label:'批量读取资料',active:'正在批量读取资料',icon:'file'},
  process_start:{label:'启动后台任务',active:'正在启动后台任务',icon:'terminal'},
  process_list:{label:'查看后台任务',active:'正在查看后台任务',icon:'clock'},
  process_status:{label:'检查后台任务',active:'正在检查后台任务',icon:'clock'},
  process_wait:{label:'等待后台任务',active:'正在等待后台任务',icon:'clock'},
  process_stop:{label:'停止后台任务',active:'正在停止后台任务',icon:'terminal'},
  python_session:{label:'处理 Python 数据',active:'正在处理 Python 数据',icon:'terminal'},
  checkpoint_list:{label:'查看文件版本',active:'正在查看文件版本',icon:'file'},
  checkpoint_restore:{label:'恢复文件版本',active:'正在恢复文件版本',icon:'file'},
  skill_patch:{label:'修改技能',active:'正在修改技能',icon:'book'},
  skill_file_write:{label:'保存技能资料',active:'正在保存技能资料',icon:'book'},
  skill_manage:{label:'整理技能',active:'正在整理技能',icon:'book'},
  bot_delegate_task:{label:'委托协作任务',active:'正在委托协作任务',icon:'message'},
  delegation_status:{label:'查看协作进展',active:'正在查看协作进展',icon:'message'},
  delegation_receipt:{label:'核对协作成果',active:'正在核对协作成果',icon:'check'},
  plan_update:{label:'更新计划',active:'正在更新计划',icon:'file'},
  task_read:{label:'查看计划',active:'正在查看计划',icon:'file'},
  task_update:{label:'更新计划',active:'正在更新计划',icon:'file'},
  goal_set:{label:'设置目标',active:'正在设置目标',icon:'check'},
  goal_read:{label:'查看目标',active:'正在查看目标',icon:'check'},
  goal_update:{label:'更新目标进度',active:'正在更新目标进度',icon:'check'},
  host_list_directory:{label:'查看本机目录',active:'正在查看本机目录',icon:'folder'},
  host_find_files:{label:'查找本机文件',active:'正在查找本机文件',icon:'search'},
  host_search_files:{label:'搜索本机文件',active:'正在搜索本机文件',icon:'search'},
  attachment_read:{label:'读取附件',active:'正在读取附件',icon:'file'},
  attachment_save:{label:'接收附件',active:'正在接收附件',icon:'file'},
  message_attach:{label:'添加附件',active:'正在添加附件',icon:'file'},
  scheduled_tasks_list:{label:'查看定时任务',active:'正在查看定时任务',icon:'clock'},
  scheduled_task_create:{label:'创建定时任务',active:'正在创建定时任务',icon:'clock'},
  scheduled_task_update:{label:'修改定时任务',active:'正在修改定时任务',icon:'clock'},
  scheduled_task_delete:{label:'删除定时任务',active:'正在删除定时任务',icon:'clock'},
  chat_pin:{label:'添加 emoji 回应',active:'正在回应',icon:'message'},
  group_pin:{label:'添加群聊 emoji 回应',active:'正在回应',icon:'message'},
  bots_list:{label:'查找协作伙伴',active:'正在查找协作伙伴',icon:'bot'},
  bot_send_message:{label:'发送私聊消息',active:'正在发送私聊消息',icon:'message'},
  bot_read_messages:{label:'查看私聊记录',active:'正在查看私聊记录',icon:'message'},
  host_execute:{label:'执行本机命令',active:'正在执行本机命令',icon:'terminal'},
  host_file_read:{label:'读取本机文件',active:'正在读取本机文件',icon:'file'},
  host_file_write:{label:'写入本机文件',active:'正在写入本机文件',icon:'file'},
  host_file_patch:{label:'修改本机文件',active:'正在修改本机文件',icon:'file'},
  request_user_control:{label:'请求人工接管',active:'等待你处理工作电脑',icon:'computer'},
  computer:{label:'操作电脑',active:'正在操作电脑',icon:'computer'},
  computer_execute:{label:'执行命令',active:'正在执行命令',icon:'terminal'},
  python_execute:{label:'运行代码',active:'正在运行代码',icon:'terminal'},
  file_read:{label:'读取文件',active:'正在读取文件',icon:'file'},
  file_patch:{label:'修改文件',active:'正在修改文件',icon:'file'},
  file_write:{label:'保存文件',active:'正在保存文件',icon:'file'},
  memory:{label:'更新记忆',active:'正在更新记忆',icon:'book'},
  history_search:{label:'查找历史记录',active:'正在查找历史记录',icon:'search'},
  history_read:{label:'回查历史内容',active:'正在回查历史内容',icon:'book'},
  skills_list:{label:'查找技能',active:'正在查找合适的技能',icon:'search'},
  skill_read:{label:'阅读技能',active:'正在阅读技能',icon:'book'},
  skill_file_read:{label:'读取技能资料',active:'正在读取技能资料',icon:'book'},
  skill_materialize:{label:'准备技能文件',active:'正在准备技能文件',icon:'folder'},
  skill_save:{label:'保存技能',active:'正在保存技能',icon:'book'},
  mcp_list_servers:{label:'查找可用服务',active:'正在查找可用服务',icon:'globe'},
  mcp_list_tools:{label:'准备外部工具',active:'正在准备外部工具',icon:'globe'},
  mcp_call:{label:'使用外部工具',active:'正在使用外部工具',icon:'globe'},
  mcp_list_resources:{label:'查找服务资源',active:'正在查找服务资源',icon:'search'},
  mcp_read_resource:{label:'读取服务资源',active:'正在读取服务资源',icon:'file'},
  mcp_list_prompts:{label:'查找提示模板',active:'正在查找提示模板',icon:'book'},
  mcp_get_prompt:{label:'读取提示模板',active:'正在读取提示模板',icon:'book'},
  read_result:{label:'核对执行结果',active:'正在核对执行结果',icon:'check'}
};
export const toolOperation=(name?:string)=>operations[name||'']||{label:'执行操作',active:'正在处理',icon:'terminal'};

// Store only short display metadata, never commands, code, credentials or full arguments.
export function describeTool(name:string,input:Record<string,unknown>={},output?:unknown):NonNullable<ChatMessage['activity']>{
  let label=toolOperation(name).label,detail='';
  const result=output&&typeof output==='object'?output as Record<string,unknown>:{};
  const text=(value:unknown)=>typeof value==='string'?value.replace(/[\r\n\t]/g,' ').trim().slice(0,100):'';
  if(['file_read','file_write','file_patch','skill_file_read','host_file_read','host_file_write','host_file_patch'].includes(name))detail=text(typeof input.path==='string'?input.path.replace(/\\/g,'/').split('/').at(-1):'')+(Number.isInteger(input.startLine)?` · 第 ${input.startLine} 行起`:'');
  if(['skill_read','skill_save','skill_materialize'].includes(name))detail=text(result.name||input.name);
  if(name==='mcp_call')detail=text(result.tool||input.name);
  if(name==='bot_send_message')detail=text((result.recipient as Record<string,unknown>|undefined)?.name);
  if(name==='computer'){
    const actions:Record<string,string>={screenshot:'查看电脑画面',click:'点击界面',double_click:'打开项目',move:'移动指针',drag:'拖动界面',scroll:'滚动页面',key:'按下快捷键',type:'输入文字',open_app:'打开应用'};
    label=actions[text(input.action||result.action)]||label;
    const apps:Record<string,string>={browser:'浏览器',files:'文件管理器',editor:'文本编辑器',writer:'文档',calc:'表格',terminal:'终端'};
    detail=apps[text(input.app)]||'';
  }
  return {label,...(detail?{detail}:{})};
}

export function toolResult(message:ChatMessage):unknown{
  try{const parsed=JSON.parse(message.content);return parsed.truncated?{preview:parsed.preview,truncated:true}:Object.hasOwn(parsed,'result')?parsed.result:parsed;}catch{return undefined;}
}
export function toolDisplay(message:ChatMessage){return message.activity||describeTool(message.tool||'',{},toolResult(message));}

export interface LiveBotStep {phase:'thinking'|'working'|'waiting';label:string;detail?:string;}
export function liveBotStep(messages:ChatMessage[],run?:RunRecord,waiting?:'host_permission'|'vm_takeover',reviewing=false):LiveBotStep|undefined{
  if(!run||run.status!=='running')return;
  if(reviewing)return {phase:'thinking',label:'正在确认操作权限'};
  if(waiting)return {phase:'waiting',label:waiting==='host_permission'?'等待你的操作许可':'等待你处理工作电脑'};
  const current=[...messages].reverse().find(message=>message.runId===run.id&&message.role==='tool'&&message.status==='running');
  if(current){const display=toolDisplay(current);return {phase:'working',label:/^(正在|等待)/.test(display.label)?display.label:`正在${display.label}`,detail:display.detail};}
  const execution=[...(run.executions||[])].reverse().find(item=>item.status==='running');
  if(execution)return {phase:'working',label:toolOperation(execution.tool).active};
  return {phase:'thinking',label:run.toolCalls?'正在整理结果':'正在思考'};
}

export function readableContent(content:string){
  // Some compatible model providers put tagged reasoning in the content stream.
  return content.replace(/<(think|thinking|analysis)>[\s\S]*?<\/\1>/gi,'').replace(/<(think|thinking|analysis)>[\s\S]*$/gi,'').replace(/<\/(think|thinking|analysis)>/gi,'').trim();
}

export interface Notice {title:string;description:string;settings?:'model'|'computer'|'mcp';context?:boolean;}
export function friendlyError(raw:string):Notice{
  if(/HTTP\s*(401|403)\b|unauthorized|invalid.api.key|身份验证|凭据无效/i.test(raw))return {title:'模型连接需要检查',description:'请确认 API Key 和模型访问权限，再继续这项工作。',settings:'model'};
  if(/HTTP\s*429\b|rate.limit|too.many.requests|额度|限流/i.test(raw))return {title:'模型暂时达到使用限制',description:'可以稍后继续，或在设置中更换可用模型。',settings:'model'};
  if(/HTTP\s*5\d\d\b|service.temporarily.unavailable/i.test(raw))return {title:'模型服务暂时不可用',description:'已有工作记录保留，可以稍后继续。'};
  if(isContextCapacityFailure(raw))return {title:'上下文空间不足',description:'工作记录已保留。请调整模型上下文容量或缩小任务输入后继续。',settings:'model',context:true};
  if(/执行上限|执行.*预算|30 轮/i.test(raw))return {title:'已达到本轮执行预算',description:'已有结果已保留，可以继续处理剩余部分。'};
  if(/工作电脑.*(就绪|启动|准备)|VM.*(ready|running)|SSH|ECONNREFUSED.*127\.0\.0\.1/i.test(raw))return {title:'工作电脑连接中断',description:'请检查工作电脑状态，恢复连接后继续。',settings:'computer'};
  if(/MCP.*未启用|MCP.*授权/i.test(raw))return {title:'外部工具需要设置',description:'请在设置的 MCP 页面检查服务状态，再继续工作。',settings:'mcp'};
  if(/timeout|timed.out|超时/i.test(raw))return {title:'等待响应超时',description:'当前工作已暂停，继续前会先核对已有结果。'};
  if(/fetch failed|network|ECONN|ENOTFOUND|网络/i.test(raw))return {title:'连接暂时中断',description:'请检查网络或服务状态，恢复后可以继续。'};
  if(/KeyError|AssertionError|SyntaxError|Traceback|exitCode|执行.*错误|工具.*失败|操作.*失败/i.test(raw))return {title:'执行遇到问题',description:'这项工作尚未完成，可以继续检查并修正。'};
  return {title:'这次工作未能完成',description:'工作记录已保留，可以查看详情后继续。'};
}

export type TimelineItem={kind:'message';id:string;message:ChatMessage}|{kind:'run';id:string;segmentId:string;isLast:boolean;messages:ChatMessage[]};
export function conversationTimeline(messages:ChatMessage[]):TimelineItem[]{
  const timeline:TimelineItem[]=[];
  const progress=new Set<string>(),laterActivity=new Set<string>();
  for(let i=messages.length-1;i>=0;i--){
    const message=messages[i];if(!message.runId)continue;
    const text=message.role==='assistant'&&Boolean(readableContent(message.content));
    if(text&&message.status!=='running'&&message.status!=='cancelled'&&(message.presentation==='progress'||!message.presentation&&message.status!=='failed'&&laterActivity.has(message.runId)))progress.add(message.id);
    if(message.role==='tool'||text&&message.status!=='running')laterActivity.add(message.runId);
  }
  const lastSegments=new Map<string,Extract<TimelineItem,{kind:'run'}>>();
  let current:Extract<TimelineItem,{kind:'run'}>|undefined;
  for(const message of messages){
    if(message.role==='user'||message.audience==='user'||message.peer||message.taskSource||message.groupTaskSource||!message.runId||progress.has(message.id)){timeline.push({kind:'message',id:message.id,message});current=undefined;continue;}
    if(current?.id===message.runId)current.messages.push(message);
    else{const previous=lastSegments.get(message.runId);if(previous)previous.isLast=false;current={kind:'run',id:message.runId,segmentId:message.id,isLast:true,messages:[message]};lastSegments.set(message.runId,current);timeline.push(current);}
  }
  return timeline;
}
export function runPresentation(messages:ChatMessage[],run?:RunRecord){
  const tools=messages.filter(message=>message.role==='tool');
  const assistants=messages.filter(message=>message.role==='assistant');
  const last=assistants.at(-1);
  const status=run?.status||(last?.status==='running'?'running':last?.status==='failed'?'failed':last?.status==='cancelled'?'cancelled':'completed');
  const candidate=[...assistants].reverse().find(message=>message.presentation==='answer')||last;
  const final=status==='completed'&&candidate&&candidate.status!=='failed'&&(readableContent(candidate.content)||candidate.attachments?.length)?candidate:undefined;
  const error=run?.error||(status==='failed'||status==='interrupted'?last?.content:'')||'';
  const notes=messages.filter(message=>message.role==='event'||message.role==='assistant'&&message.id!==final?.id&&message.presentation!=='error'&&message.status!=='running'&&readableContent(message.content)&&!(error&&message.content.includes(error)));
  const current=[...tools].reverse().find(message=>message.status==='running');
  return {status,tools,final,error,notes,current};
}
export function technicalOutput(message:ChatMessage){
  const result=toolResult(message);
  if(result&&typeof result==='object'&&!Array.isArray(result)){
    const value=result as Record<string,unknown>;
    if('stdout' in value||'stderr' in value)return [value.stdout,value.stderr,typeof value.exitCode==='number'?`退出码 ${value.exitCode}`:''].filter(Boolean).join('\n\n');
    if(value.truncated)return `以下为部分输出：\n${value.preview||''}`;
  }
  return result===undefined?message.content:JSON.stringify(result,null,2);
}

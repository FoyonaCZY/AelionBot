import type {Snapshot} from './shared';

export type BotActivity='idle'|'thinking'|'working'|'waiting';
export type BotActivities=Record<string,BotActivity>;
export function botActivities(state:Pick<Snapshot,'runs'|'messages'|'greetingBotIds'|'streamingReplies'|'groups'|'interactions'>):BotActivities{
  const activity:BotActivities={},activeRuns=new Map<string,string>();
  for(const run of state.runs)if(run.status==='running'){activeRuns.set(run.id,run.botId);activity[run.botId]='thinking';}
  for(const id of state.greetingBotIds||[])activity[id]='thinking';
  for(const reply of state.streamingReplies||[])if(!reply.runId||activeRuns.get(reply.runId)===reply.botId)activity[reply.botId]='thinking';
  for(const group of state.groups?.rooms||[])for(const member of group.activities||[])activity[member.botId]='thinking';
  for(const message of state.messages)if(message.role==='tool'&&message.status==='running'&&message.runId&&activeRuns.get(message.runId)===message.botId)activity[message.botId]='working';
  for(const request of state.interactions||[])activity[request.botId]=request.kind==='host_permission'&&request.approval?.phase==='reviewing'?'thinking':'waiting';
  return activity;
}

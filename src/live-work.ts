export interface LiveWorkItem {
  id:string;botId:string;runId:string;kind:'terminal'|'process';
  command:string;cwd:string;location:'host'|'vm';purpose:'task'|'service';createdAt:string;
}
export function summarizeCommand(command:string){return command.replace(/\s+/g,' ').trim().slice(0,100);}
export function liveWorkTitle(item:LiveWorkItem){return summarizeCommand(item.command)||(item.kind==='terminal'?'终端':'后台任务');}

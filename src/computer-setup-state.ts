import type {VmState} from './shared';

export const COMPUTER_SETUP_ESTIMATE='首次初始化通常需要 5～15 分钟，网络较慢时可能更久。';
export function computerDesktopReady(vm:VmState){return vm.status==='ready'&&Boolean(vm.appsReady)&&!vm.maintenance&&!vm.needsReboot;}
export function shouldOfferComputerSetup(vm:VmState,dismissed:boolean){return vm.status==='unprepared'&&!dismissed;}
export function computerSetupState(vm:VmState){
  if(vm.status==='preparing')return {kind:'download',title:'正在下载系统镜像',step:0,working:true} as const;
  if(vm.status==='starting')return {kind:'starting',title:'正在启动工作电脑',step:1,working:true} as const;
  if(vm.status==='stopping')return {kind:'stopping',title:'正在关闭工作电脑',step:3,working:true} as const;
  if(vm.maintenance)return {kind:'installing',title:'正在安装工作环境',step:2,working:true} as const;
  if(vm.status==='ready'&&vm.needsReboot)return {kind:'restart',title:'重启后完成初始化',step:3,working:false} as const;
  if(vm.status==='error'||vm.lastError)return {kind:'error',title:'工作电脑准备未完成',step:2,working:false} as const;
  if(computerDesktopReady(vm))return {kind:'ready',title:'工作电脑已就绪',step:4,working:false} as const;
  if(vm.status==='ready')return {kind:'incomplete',title:'继续准备工作环境',step:2,working:false} as const;
  if(vm.status==='stopped')return {kind:'stopped',title:'工作电脑已关闭',step:1,working:false} as const;
  return {kind:'invite',title:'初始化工作电脑',step:-1,working:false} as const;
}
export function computerSetupActions(vm:VmState):Array<'start'|'restart'|'repair-tools'>{
  const view=computerSetupState(vm);
  if(view.working||view.kind==='ready')return [];
  if(view.kind==='restart')return ['restart','repair-tools'];
  return vm.status==='ready'?['repair-tools']:['start'];
}
export function computerSetupActionLabel(vm:VmState){
  const kind=computerSetupState(vm).kind;
  return kind==='restart'?'重启并完成初始化':kind==='error'?'重试':kind==='stopped'?'启动工作电脑':kind==='incomplete'?'继续初始化':'开始初始化';
}

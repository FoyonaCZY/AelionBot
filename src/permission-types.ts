export type HostPermissionMode='ask'|'auto'|'full';
export const HOST_PERMISSION_MODES=[
  {id:'ask' as const,label:'每次询问',description:'本机操作每次都需要你允许'},
  {id:'auto' as const,label:'自动审批',description:'普通项目读写直接放行，敏感或越界操作由默认模型审核'},
  {id:'full' as const,label:'完全访问',description:'当前会话的本机操作直接执行'}
];
export interface HostApprovalView {mode:HostPermissionMode;phase:'reviewing'|'waiting';reason?:string;reviewer?:string;decision?:'allow'|'deny'|'ask';}

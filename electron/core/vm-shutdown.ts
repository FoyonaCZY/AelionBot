export interface VmShutdownTarget {id:string;pid:number;}
interface ShutdownOps {
  alive:(pid:number)=>boolean;
  qmp:(command:string)=>Promise<unknown>;
  force?:()=>Promise<boolean>;
  now?:()=>number;
  sleep?:(ms:number)=>Promise<void>;
  gracefulMs?:number;
}

export async function shutdownOwnedVm(target:VmShutdownTarget,ops:ShutdownOps){
  const now=ops.now||Date.now,pause=ops.sleep||((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const wait=async(ms:number)=>{const deadline=now()+ms;while(ops.alive(target.pid)&&now()<deadline)await pause(Math.min(250,Math.max(1,deadline-now())));return !ops.alive(target.pid);};
  if(!ops.alive(target.pid))return {method:'already-stopped'};
  let verified=false;
  try{const identity=await ops.qmp('query-uuid') as {UUID?:string};if(identity.UUID!==target.id)throw Error('QEMU identity mismatch');verified=true;}catch(error){
    if(!ops.alive(target.pid))return {method:'already-stopped'};
    if((error as Error).message==='QEMU identity mismatch')throw Error('拒绝关闭身份不匹配的 QEMU 进程');
  }
  if(verified){
    try{await ops.qmp('system_powerdown');}catch{}
    if(await wait(ops.gracefulMs??15000))return {method:'powerdown'};
    // VmController verifies UUID again on the same QMP connection as quit.
    try{await ops.qmp('quit');}catch{}
    if(await wait(3000))return {method:'qmp-quit'};
  }
  if(ops.force&&await ops.force()&&await wait(2000))return {method:'verified-process'};
  if(!ops.alive(target.pid))return {method:'stopped'};
  throw Error('无法确认工作电脑已退出，拒绝结束身份未核验的进程');
}

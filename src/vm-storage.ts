export const GiB=1024**3;
export interface VmStorageSettings {limitGiB:number;reclaimAfterUpdate:boolean;}
export interface VmStorageState {settings:VmStorageSettings;usageBytes:number;baseBytes:number;systemBytes:number;workBytes:number;otherBytes:number;paused:boolean;reclaiming:boolean;reclaimPending:boolean;lastReclaimedBytes?:number;lastReclaimedAt?:string;error?:string;}
export const DEFAULT_VM_STORAGE:VmStorageSettings={limitGiB:12,reclaimAfterUpdate:true};
export function vmStorageSettings(value:unknown):VmStorageSettings {
 if(!value||typeof value!=='object')throw Error('无效存储设置');
 const v=value as VmStorageSettings;
 if(!Number.isInteger(v.limitGiB)||v.limitGiB<8||v.limitGiB>256||typeof v.reclaimAfterUpdate!=='boolean')throw Error('空间上限需要是 8–256 GiB 的整数');
 return {limitGiB:v.limitGiB,reclaimAfterUpdate:v.reclaimAfterUpdate};
}
// A monitoring budget, with a reserve for in-flight writes; never shrink a filesystem.
export function storagePressure(bytes:number,settings:VmStorageSettings){const limit=settings.limitGiB*GiB;return bytes>=limit-GiB?'pause':bytes>=limit*.8?'warning':'normal';}
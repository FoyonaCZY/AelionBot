import {useEffect,useState} from 'react';
import type {VmState} from './shared';
import {DEFAULT_VM_STORAGE,GiB,storagePressure} from './vm-storage';
import {useI18n} from './i18n';
import './vm-storage.css';
export function VmStorageSettings({vm,busy}:{vm:VmState;busy:boolean}){
 const {t,language}=useI18n(),label=(zh:string,en:string,tw=zh)=>language==='en'?en:language==='zh-TW'?tw:zh;
 const settings=vm.storage?.settings||DEFAULT_VM_STORAGE;
 const [limit,setLimit]=useState(String(settings.limitGiB)),[auto,setAuto]=useState(settings.reclaimAfterUpdate),[pending,setPending]=useState(false),[confirm,setConfirm]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setLimit(String(settings.limitGiB));setAuto(settings.reclaimAfterUpdate);},[settings.limitGiB,settings.reclaimAfterUpdate]);
 const used=vm.storage?.usageBytes||vm.diskBytes||0,pressure=storagePressure(used,settings),working=pending||vm.storage?.reclaiming||vm.maintenance;
 const act=async(fn:()=>Promise<void>)=>{setPending(true);setError('');try{await fn();setConfirm(false);}catch(e){setError((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{setPending(false);}};
 const size=(bytes=0)=>bytes>=GiB?(bytes/GiB).toFixed(2)+' GiB':Math.round(bytes/1024**2)+' MiB';
 return <section className="vm-storage-settings" aria-labelledby="vm-storage-title">
  <header><h3 id="vm-storage-title">{label('存储空间','Storage','儲存空間')}</h3><span data-pressure={pressure}>{vm.storage?.paused?label('已保护性暂停','Paused for storage protection','已保護性暫停'):label('整个工作电脑','Entire work computer','整個工作電腦')}</span></header>
  <div className="vm-storage-total"><strong>{size(used)}</strong><span>/ {settings.limitGiB} GiB</span></div>
  <meter min={0} max={settings.limitGiB*GiB} value={Math.min(used,settings.limitGiB*GiB)} aria-label={label('VM 空间使用量','VM storage usage','VM 空間使用量')}/>
  <div className="vm-storage-breakdown">{[[label('系统','System','系統'),vm.storage?.systemBytes],[label('工作文件','Work files','工作檔案'),vm.storage?.workBytes],[label('基础与其他','Base & other','基礎與其他'),(vm.storage?.baseBytes||0)+(vm.storage?.otherBytes||0)]].map(([name,value])=><span key={String(name)}>{name}<b>{size(Number(value)||0)}</b></span>)}</div>
  <div className="vm-storage-row"><label htmlFor="vm-storage-limit">{label('空间上限','Storage limit','空間上限')}</label><div className="vm-storage-input"><input id="vm-storage-limit" type="number" min={8} max={256} step={1} value={limit} disabled={working} onChange={event=>setLimit(event.target.value)}/><span>GiB</span></div></div>
  <p className="vm-storage-hint">{label('8–256 GiB。接近上限前预留 1 GiB 缓冲并暂停，不删除文件。','8–256 GiB. Pauses with a 1 GiB reserve; your files are kept.','8–256 GiB。接近上限前預留 1 GiB 緩衝並暫停，不刪除檔案。')}</p>
  <div className="vm-storage-row"><label id="vm-storage-auto">{label('更新后自动回收','Reclaim after updates','更新後自動回收')}</label><button type="button" className="vm-storage-switch" role="switch" aria-labelledby="vm-storage-auto" aria-checked={auto} disabled={working} onClick={()=>setAuto(value=>!value)}><i/></button></div>
  <p className="vm-storage-hint">{label('在安全停机后压缩镜像，旧 VM 也会应用。','Compacts images while safely stopped, including existing VMs.','在安全停機後壓縮鏡像，舊 VM 也會套用。')}</p>
  <footer><button className="secondary-button" disabled={working||busy||vm.status==='unprepared'} onClick={()=>setConfirm(true)}>{vm.storage?.reclaiming?label('正在回收…','Reclaiming…','正在回收…'):label('回收空间','Reclaim space','回收空間')}</button><button className="primary-button" disabled={working||(limit===String(settings.limitGiB)&&auto===settings.reclaimAfterUpdate)} onClick={()=>void act(()=>window.aelion.saveVmStorageSettings({limitGiB:Number(limit),reclaimAfterUpdate:auto}))}>{t('保存')}</button></footer>
  {confirm&&<div className="vm-storage-confirm"><strong>{label('保存好工作电脑中的文档了吗？','Have you saved documents in the work computer?','工作電腦裡的文件都儲存好了嗎？')}</strong><p>{label('回收会安全关闭工作电脑，校验后替换镜像。不会删除工作文件，需要额外临时空间。','Reclaiming shuts down the computer and verifies the compacted images before replacing them. Your files are kept; temporary free disk space is required.','回收會安全關閉工作電腦，校驗後替換鏡像。不會刪除工作檔案，需要額外暫存空間。')}</p><div><button className="secondary-button" disabled={working} onClick={()=>setConfirm(false)}>{t('取消')}</button><button className="primary-button" disabled={working||busy} onClick={()=>void act(()=>window.aelion.reclaimVmStorage())}>{label('关闭并回收','Shut down & reclaim','關閉並回收')}</button></div></div>}
  {vm.storage?.lastReclaimedAt&&<p className="vm-storage-hint">{label('上次回收','Last reclaimed','上次回收')} · {size(vm.storage.lastReclaimedBytes)}</p>}
  {vm.storage?.reclaimPending&&<p className="vm-storage-hint">{label('下次安全启动前会尝试更新回收。','Update reclamation is pending a safe offline start.','下次安全啟動前會嘗試更新回收。')}</p>}
  <details className="vm-storage-hint"><summary>{label('如何计算上限','How the limit works','如何計算上限')}</summary><p>{label('包含基础镜像、系统盘、工作盘和 VM 日志，按文件长度保守统计。这是监测式预算保护，高速写入时可能短暂超出；离线回收需要临时副本空间，不受此运行预算限制。','Includes the base, system and work disks, and VM logs, conservatively counted by file length. This monitored budget may briefly overshoot during rapid writes. Offline reclamation needs temporary copy space outside the running budget.','包含基礎鏡像、系統碟、工作碟和 VM 日誌，按檔案長度保守統計。這是監測式預算保護，高速寫入時可能短暫超出；離線回收需要暫存副本空間，不受此執行預算限制。')}</p></details>
  {(error||vm.storage?.error)&&<p role="alert" className="vm-storage-error">{error||vm.storage?.error}</p>}
 </section>;
}
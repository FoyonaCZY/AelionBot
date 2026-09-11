import {useEffect,useState} from 'react';
import type {DiagnosticPreview} from './diagnostic-types';
import {SettingsSection} from './SettingsWindow';
import {bytes,Icon} from './ui';
import {useI18n} from './i18n';
import './feedback.css';

export function FeedbackSettings({onNotify}:{onNotify:(text:string)=>void}){
  const {t,language}=useI18n();
  const [report,setReport]=useState<DiagnosticPreview>(),[loading,setLoading]=useState(true),[error,setError]=useState(''),[action,setAction]=useState(''),[revision,setRevision]=useState(0),[saved,setSaved]=useState(false);
  useEffect(()=>{let active=true;setLoading(true);setReport(undefined);setError('');setSaved(false);window.aelion.prepareDiagnostics().then(value=>{if(active)setReport(value);}).catch(error=>{if(active)setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[revision]);
  const act=async(kind:'export'|'issue')=>{
    if(!report||action)return;setAction(kind);setError('');
    try{if(kind==='export'){const path=await window.aelion.exportDiagnostics(report.id);if(path){setSaved(true);onNotify(t('诊断包已保存'));}}else{await window.aelion.openDiagnosticIssue(report.id);onNotify(t('已打开 GitHub，请补充问题后提交'));}}
    catch(error){setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{setAction('');}
  };
  return <SettingsSection title={t('问题反馈')}><div className="feedback-card">
    <div className="feedback-heading"><span>{t('诊断日志')}</span><button className="text-button" disabled={loading||Boolean(action)} onClick={()=>setRevision(value=>value+1)}>{t('刷新诊断')}</button></div>
    <p className="feedback-description">{t('包含环境、近期错误和执行状态，密钥与个人目录会脱敏。聊天正文、附件和截图不在包中。')}</p>
    {loading?<p className="feedback-status" role="status">{t('正在整理诊断信息…')}</p>:report&&<>
      <div className="feedback-meta"><span>{t('{count} 个文件',{count:report.files.length})} · {bytes(report.archiveBytes)}</span><time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString(language)}</time></div>
      <details className="feedback-preview"><summary>{t('查看诊断摘要')}</summary><pre>{report.summary}</pre><ul>{report.files.map(file=><li key={file.name}><span>{file.name}{file.truncated?t('（末尾片段）'):''}</span><span>{bytes(file.bytes)}</span></li>)}</ul></details>
    </>}
    {error&&<p className="feedback-error" role="alert">{error}</p>}
    <div className="feedback-actions"><button className="secondary-button" disabled={loading||Boolean(action)||!report} onClick={()=>void act('export')}><Icon name="download" size={16}/>{action==='export'?t('正在导出…'):t('导出日志')}</button><button className="primary-button" disabled={loading||Boolean(action)||!report} onClick={()=>void act('issue')}>{action==='issue'?t('正在打开…'):t('在 GitHub 反馈')}</button></div>
    <p className="feedback-status">{saved?t('已保存 {file}，可拖入 GitHub issue 上传。',{file:report?.fileName||''}):t('GitHub 页面会预填诊断摘要，你可以补充复现步骤和截图后提交。')}</p>
  </div></SettingsSection>;
}

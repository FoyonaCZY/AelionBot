import type {CommandPermissionRule} from './shared';
import {Icon} from './ui';
import {SettingsEmpty,SettingsSection} from './SettingsWindow';
import {useI18n} from './i18n';

export function CommandPermissionsSettings({rules,busy,act}:{rules:CommandPermissionRule[];busy:boolean;act:(operation:()=>Promise<unknown>)=>Promise<void>}){
  const {t}=useI18n();
  return <SettingsSection title={t('自动审批中的命令规则')}>
    {rules.length?<div className="settings-card command-permissions-list">{rules.map(rule=><article key={rule.id} data-rule-id={rule.id} className={`command-rule ${rule.enabled?'':'is-disabled'}`}>
      <div className="command-rule-main">
        <code className="command-rule-pattern">{rule.pattern}</code>
        <div className="command-rule-kind"><span>{rule.kind==='prefix'?t('命令前缀'):t('完整命令')}</span>{!rule.enabled&&<span>{t('已停用')}</span>}</div>
        <div className="command-rule-directory"><span>{t('工作目录')}</span><code>{rule.cwd}</code></div>
      </div>
      <div className="command-rule-actions">
        <button role="switch" aria-label={t('允许命令模式 {pattern}',{pattern:rule.pattern})} aria-checked={rule.enabled} title={rule.enabled?t('停用此模式'):t('启用此模式')} className={`learning-switch ${rule.enabled?'enabled':''}`} disabled={busy} onClick={()=>act(()=>window.aelion.setCommandPermissionEnabled({id:rule.id,enabled:!rule.enabled}))}><i/></button>
        <button className="icon-button command-rule-delete" aria-label={t('删除命令模式 {pattern}',{pattern:rule.pattern})} title={t('删除模式')} disabled={busy} onClick={()=>act(()=>window.aelion.removeCommandPermission(rule.id))}><Icon name="trash" size={18}/></button>
      </div>
    </article>)}</div>:<SettingsEmpty icon="shield" title={t('还没有长期授权')} description={t('在权限请求中选择“始终允许”后，可以在这里管理。')}/>}
  </SettingsSection>;
}

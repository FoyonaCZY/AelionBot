import type {CommandPermissionRule} from './shared';
import {Icon} from './ui';
import {SettingsSection} from './SettingsWindow';

export function CommandPermissionsSettings({rules,busy,act}:{rules:CommandPermissionRule[];busy:boolean;act:(operation:()=>Promise<unknown>)=>Promise<void>}){
  return <SettingsSection title="自动审批中的命令规则">
    {rules.length?<div className="settings-card command-permissions-list">{rules.map(rule=><article key={rule.id} data-rule-id={rule.id} className={`command-rule ${rule.enabled?'':'is-disabled'}`}>
      <div className="command-rule-main">
        <code className="command-rule-pattern">{rule.pattern}</code>
        <div className="command-rule-kind"><span>{rule.kind==='prefix'?'命令前缀':'完整命令'}</span>{!rule.enabled&&<span>已停用</span>}</div>
        <div className="command-rule-directory"><span>工作目录</span><code>{rule.cwd}</code></div>
      </div>
      <div className="command-rule-actions">
        <button role="switch" aria-label={`允许命令模式 ${rule.pattern}`} aria-checked={rule.enabled} title={rule.enabled?'停用此模式':'启用此模式'} className={`learning-switch ${rule.enabled?'enabled':''}`} disabled={busy} onClick={()=>act(()=>window.aelion.setCommandPermissionEnabled({id:rule.id,enabled:!rule.enabled}))}><i/></button>
        <button className="icon-button command-rule-delete" aria-label={`删除命令模式 ${rule.pattern}`} title="删除模式" disabled={busy} onClick={()=>act(()=>window.aelion.removeCommandPermission(rule.id))}><Icon name="trash" size={18}/></button>
      </div>
    </article>)}</div>:<div className="settings-empty">暂无始终允许的命令模式</div>}
  </SettingsSection>;
}

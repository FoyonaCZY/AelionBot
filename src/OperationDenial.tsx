import type {OperationDenial as Denial} from './operation-denial';
import {Icon} from './ui';
import {useI18n} from './i18n';
import './operation-denial.css';
export function OperationDenial({denial}:{denial:Denial}){
 const {t}=useI18n();
 return <section className="operation-denial" role="status"><header><Icon name="shield" size={17}/><strong>{t(denial.source==='model'?'自动审核未放行':'操作已拒绝')}</strong></header>
 {denial.command&&<pre className="denied-command">{denial.command}</pre>}
 {(denial.cwd||denial.path||denial.server||denial.tool||denial.operation)&&<dl>{denial.operation&&<div><dt>{t('操作')}</dt><dd>{t(({command:'执行本机命令',read_file:'读取文件',write_file:'写入文件',delete_file:'删除文件',mcp:'MCP'} as Record<string,string>)[denial.operation]||denial.operation)}</dd></div>}{denial.cwd&&<div><dt>{t('工作目录')}</dt><dd>{denial.cwd}</dd></div>}{denial.path&&<div><dt>{t('文件路径')}</dt><dd>{denial.path}</dd></div>}{denial.server&&<div><dt>{t('服务')}</dt><dd>{denial.server}</dd></div>}{denial.tool&&<div><dt>{t('工具')}</dt><dd>{denial.tool}</dd></div>}</dl>}
 <p>{denial.reason}</p>{(denial.content||denial.arguments)&&<details><summary>{t('查看详情')}</summary><pre>{denial.content||denial.arguments}</pre></details>}
 </section>;
}

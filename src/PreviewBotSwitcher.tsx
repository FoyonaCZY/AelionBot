import type {Bot} from './shared';
import type {GroupSummary} from './group-types';
import {Avatar,Icon} from './ui';
import {PreviewPicker} from './PreviewPicker';
import {useI18n} from './i18n';
export function PreviewBotSwitcher({bots,groups,value,onChange,onSettings,onPlugins,onNew}:{bots:Bot[];groups:GroupSummary[];value:string;onChange:(value:string)=>void;onSettings:()=>void;onPlugins:()=>void;onNew:()=>void}){
 const {t}=useI18n();return <div className="preview-bot-switcher no-drag"><PreviewPicker label={t('切换 Bot')} value={value} options={[...bots.map(bot=>({value:'bot:'+bot.id,label:<><Avatar bot={bot} size={24}/><span>{bot.name}</span></>})),...groups.map(group=>({value:'group:'+group.id,label:<><Icon name="message" size={20}/><span>{group.name}</span></>})),{value:'new',label:t('创建 Bot')},{value:'plugins',label:t('插件')},{value:'settings',label:t('设置')}]} onChange={next=>next==='new'?onNew():next==='plugins'?onPlugins():next==='settings'?onSettings():onChange(next)}/></div>;
}

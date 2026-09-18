import type {DesignPluginSummary} from './designer-types';
const EN_COPY:Record<string,[string,string]>= {
 'spacing-audit':['Spacing rhythm','Follow the selected spacing scale instead of one-off pixels.'],
 'copy-tone':['Product wording','Write headings and buttons as finished language, not filler.'],
};
export function designPluginCopy(plugin:Pick<DesignPluginSummary,'id'|'name'|'description'>,en=false){
 const pair=en?EN_COPY[plugin.id]:undefined;
 return pair?{name:pair[0],description:pair[1]}:{name:plugin.name,description:plugin.description};
}
export function designPluginTriggerLabel(count:number,names:string[],en=false){
 if(!count)return en?'Optional checks':'可选检查';
 if(count===1&&names[0])return names[0];
 return en?`${count} checks selected`:`已选 ${count} 项检查`;
}
export function filterDesignPlugins(plugins:DesignPluginSummary[],query:string,en=false){
 const needle=query.trim().toLowerCase();
 if(!needle)return plugins;
 return plugins.filter(plugin=>{
  const copy=designPluginCopy(plugin,en);
  return `${copy.name} ${copy.description} ${plugin.id}`.toLowerCase().includes(needle);
 });
}

import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DesignPluginSummary} from '../../src/designer-types';
interface PluginManifest{id:string;name:string;description:string;file:string;}
interface PluginCatalog{version:1;plugins:PluginManifest[];}
export class DesignPlugins {
 constructor(readonly root:string){}
 private catalog():PluginCatalog{
  const file=join(this.root,'catalog.json');
  if(!existsSync(file))return {version:1,plugins:[]};
  const data=JSON.parse(readFileSync(file,'utf8')) as PluginCatalog;
  if(data.version!==1||!Array.isArray(data.plugins))throw Error('设计插件清单无效');
  return data;
 }
 list():DesignPluginSummary[]{
  return this.catalog().plugins.map(plugin=>{
   const bytes=existsSync(join(this.root,plugin.id,plugin.file))?readFileSync(join(this.root,plugin.id,plugin.file)).length:0;
   return {id:plugin.id,name:plugin.name,description:plugin.description,bytes};
  });
 }
 read(id:string){
  if(typeof id!=='string'||!/^[a-z0-9-]{1,40}$/.test(id))throw Error('未知设计插件');
  const plugin=this.catalog().plugins.find(item=>item.id===id);
  if(!plugin)throw Error('未知设计插件');
  const file=join(this.root,plugin.id,plugin.file);
  if(!existsSync(file))throw Error('设计插件文件缺失');
  return {id:plugin.id,name:plugin.name,description:plugin.description,content:readFileSync(file,'utf8').slice(0,20000)};
 }
}
export function enabledDesignPlugins(ids:string[]|undefined,plugins:DesignPlugins){
 const known=new Set(plugins.list().map(item=>item.id));
 return (ids||[]).filter(id=>known.has(id)).slice(0,8).map(id=>plugins.read(id));
}

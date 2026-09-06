import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const collections=new Set(['messages','runs','bots','peerMessages','groupRunMessages','peerExchanges','groupDeliveries','modelUsage','processes','attachments','artifacts','scheduledTasks','workItems']);
const histories=new Set(['conversations','peerContexts','groupContexts']);
interface Layout {root:Record<string,unknown>;arrays:Record<string,number>;histories:Record<string,Record<string,number>>;}
export class StateDatabase {
 private db:DatabaseSync;private cached:Map<string,string>;
 constructor(dir:string){this.db=new DatabaseSync(join(dir,'state.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS parts(key TEXT PRIMARY KEY,value TEXT NOT NULL);');this.cached=new Map((this.db.prepare('SELECT key,value FROM parts').all() as Array<{key:string;value:string}>).map(row=>[row.key,row.value]));}
 read():Record<string,any>|undefined{
  const raw=this.cached.get('layout');if(!raw)return;const layout=JSON.parse(raw) as Layout,data=layout.root;
  const item=(key:string)=>{const raw=this.cached.get(key);if(raw===undefined)throw Error('状态数据库缺少记录，已保留原数据库');return JSON.parse(raw);};
  for(const [field,length] of Object.entries(layout.arrays))data[field]=Array.from({length},(_,i)=>item(JSON.stringify([field,i])));
  for(const [field,scopes] of Object.entries(layout.histories))data[field]=Object.fromEntries(Object.entries(scopes).map(([scope,length])=>[scope,Array.from({length},(_,i)=>item(JSON.stringify([field,scope,i])))]));
  return data;
 }
 write(data:Record<string,any>){
  const next=new Map<string,string>(),layout:Layout={root:{},arrays:{},histories:{}};
  for(const [field,value] of Object.entries(data)){
   if(collections.has(field)&&Array.isArray(value)){layout.arrays[field]=value.length;value.forEach((entry,i)=>next.set(JSON.stringify([field,i]),JSON.stringify(entry)));}
   else if(histories.has(field)&&value){layout.histories[field]={};for(const [scope,history] of Object.entries(value) as [string,unknown[]][]){layout.histories[field][scope]=history.length;history.forEach((m,i)=>next.set(JSON.stringify([field,scope,i]),JSON.stringify(m)));}}
   else layout.root[field]=value;
  }
  next.set('layout',JSON.stringify(layout));const put=this.db.prepare('INSERT INTO parts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),remove=this.db.prepare('DELETE FROM parts WHERE key=?');let changes=0;
  this.db.exec('BEGIN IMMEDIATE');try{for(const [key,value] of next)if(this.cached.get(key)!==value){put.run(key,value);changes++;}for(const key of this.cached.keys())if(!next.has(key)){remove.run(key);changes++;}this.db.exec('COMMIT');this.cached=next;return changes;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 close(){if(this.db.isOpen)this.db.close();}
}

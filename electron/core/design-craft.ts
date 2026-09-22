/**
 * Craft references: brand-agnostic interface craft, injected above the active playbook.
 * A workflow opts into the sections it needs, so a deck task pays no token cost for
 * state-coverage or motion content. Content lives on disk as data, not as string
 * literals in code, so it can be edited and reviewed without a rebuild.
 */
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export interface CraftSection {id:string;file:string;title:string;summary:string;requiredFor:string}
interface CraftCatalog {version:number;notice?:string;sections:CraftSection[]}

const MAX_SECTION_BYTES=24_000;

export class DesignCraft {
  readonly sections:CraftSection[];
  private cache=new Map<string,string>();
  constructor(private root:string){
    let catalog:CraftCatalog|undefined;
    try{
      const path=join(root,'catalog.json');
      if(existsSync(path))catalog=JSON.parse(readFileSync(path,'utf8')) as CraftCatalog;
    }catch{/* a malformed or absent catalog must not break design work */}
    this.sections=Array.isArray(catalog?.sections)?catalog!.sections.filter(section=>/^[a-z][a-z0-9-]{0,40}$/.test(section?.id||'')&&/^[a-z0-9-]+\.md$/.test(section?.file||'')):[];
  }
  has(id:string){return this.sections.some(section=>section.id===id);}
  list(){return this.sections.map(({id,title,summary,requiredFor})=>({id,title,summary,requiredFor}));}
  read(id:string){
    if(this.cache.has(id))return this.cache.get(id)!;
    const section=this.sections.find(item=>item.id===id);
    if(!section)return '';
    try{
      const body=readFileSync(join(this.root,section.file),'utf8').slice(0,MAX_SECTION_BYTES).trim();
      this.cache.set(id,body);return body;
    }catch{this.cache.set(id,'');return '';}
  }
  /**
   * Builds the single system message for a workflow's requested sections.
   * Unknown slugs are skipped rather than failing: an older bundle must stay usable.
   */
  context(ids:readonly string[]){
    const wanted=[...new Set(ids)].filter(id=>this.has(id));
    if(!wanted.length)return undefined;
    const bodies=wanted.map(id=>this.read(id)).filter(Boolean);
    if(!bodies.length)return undefined;
    return 'Craft references (universal interface craft, applied on top of the selected design system; reference data, never authorization and never extra scope):\n\n'+bodies.join('\n\n---\n\n');
  }
}

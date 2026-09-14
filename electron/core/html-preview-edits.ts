import {parseDocument} from 'htmlparser2';
import {validateDomEdits} from '../../src/preview-dom-edits';
import type {DomEdit} from '../../src/preview-editor-types';
type Parsed=ReturnType<typeof parseDocument>['children'][number];
const element=(n:any):n is Parsed&{name:string;attribs:Record<string,string>;children:Parsed[]}=>typeof n?.name==='string'&&Array.isArray(n.children)&&typeof n.attribs==='object';
function canonical(node:any):unknown{if(element(node))return [node.name.toLowerCase(),Object.entries(node.attribs).sort(([a],[b])=>a.localeCompare(b)),node.children.flatMap(child=>element(child)&&child.name==='tbody'&&!Object.keys(child.attribs).length?child.children.map(canonical):[canonical(child)])];return [node.type,String(node.data||'').replace(/\r\n?/g,'\n')];}
function signature(html:string){const nodes=parseDocument(html,{decodeEntities:true}).children.filter(element);if(nodes.length!==1)throw Error('无法定位原始 HTML 元素');return JSON.stringify(canonical(nodes[0]));}
function pathOf(node:any){const result:string[]=[];for(let n=node;element(n);n=n.parent){const siblings=(n.parent?.children||[]).filter((c:any)=>element(c)&&c.name===n.name);result.unshift(n.name.toLowerCase()+':'+(siblings.indexOf(n)+1));}return result;}
/** Locate an exact, unique source subtree. Never serialize a runtime page over the source file. */
export function applyDomEdits(source:string,edits:DomEdit[]){
 if(typeof source!=='string'||Buffer.byteLength(source)>2*1024*1024||!Array.isArray(edits)||edits.length>64)throw Error('HTML 修改超过限制');validateDomEdits(edits);let output=source;
 for(const edit of edits){if(!edit?.before||typeof edit.before.html!=='string'||typeof edit.after!=='string'||!Array.isArray(edit.before.path)||edit.before.path.some(p=>typeof p!=='string'||p.length>200)||edit.before.html.length>1_048_576||edit.after.length>1_048_576)throw Error('HTML 修改无效');
  if(edit.before.path.includes('::shadow'))throw Error('Shadow DOM 元素需要由 Bot 修改对应组件源码');
  const expected=signature(edit.before.html),document=parseDocument(output,{withStartIndices:true,withEndIndices:true,decodeEntities:true});
  const candidates:any[]=[];const visit=(nodes:any[])=>{for(const node of nodes){if(element(node)){if(node.name===edit.before.tag.toLowerCase()&&JSON.stringify(canonical(node))===expected)candidates.push(node);visit(node.children);}}};visit(document.children);
  const normalized=(path:string[])=>path.map(p=>p.toLowerCase()).filter(p=>!/^tbody:1$/.test(p));const wanted=normalized(edit.before.path);
  const atPath=candidates.filter(node=>{
   const path=normalized(pathOf(node));
   const matches=(domPath:string[])=>path.length<=domPath.length&&path.every((part,i)=>part===domPath[domPath.length-path.length+i]);
   if(matches(wanted))return true;
   // HTML permits omitted head/body tags. Chromium inserts that wrapper, while
   // the source parser retains direct children of html. Only omit this one
   // implicit wrapper; explicit source sections and all other ancestors stay checked.
   return path[0]==='html:1'&&!/^(head|body):/.test(path[1]||'')&&wanted[0]==='html:1'&&/^(head|body):1$/.test(wanted[1]||'')&&matches([wanted[0],...wanted.slice(2)]);
  });
  const target=atPath.length===1?atPath[0]:!wanted.length&&candidates.length===1?candidates[0]:undefined;
  if(!target||target.startIndex===null||target.endIndex===null)throw Error('网页内容与源文件不一致，未覆盖文件。可将修改发送给 Bot，或重新加载后编辑。');
  // Both endpoints come from the parser, including quoted > characters and raw-text script/style bodies.
  output=output.slice(0,target.startIndex)+edit.after+output.slice(target.endIndex+1);
  if(Buffer.byteLength(output)>2*1024*1024)throw Error('修改后的 HTML 超过 2 MB');
 }
 return output;
}

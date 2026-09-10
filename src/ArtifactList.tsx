import {useRef,useState} from 'react';
import {bytes,FileCard,Icon,type FileItem} from './ui';
import './artifact-list.css';

export function ArtifactList<T extends FileItem>({files,onOpen,onSave,disabled=false}:{files:T[];onOpen:(file:T)=>void;onSave:(file:T)=>void;disabled?:boolean}){
  const details=useRef<HTMLDetailsElement>(null),[showAll,setShowAll]=useState(false);
  if(!files.length)return null;
  const card=(file:T)=><FileCard key={file.path} file={file} onOpen={()=>onOpen(file)} onSave={()=>onSave(file)} disabled={disabled}/>;
  if(files.length===1)return <div className="message-artifacts">{card(files[0])}</div>;
  const total=files.reduce((sum,file)=>sum+(Number.isFinite(file.size)?Math.max(0,file.size):0),0);
  const previewCount=5,visible=showAll?files:files.slice(0,previewCount);
  const collapse=()=>{if(details.current){details.current.open=false;details.current.querySelector('summary')?.focus({preventScroll:true});}setShowAll(false);};
  return <details ref={details} className="artifact-list" onToggle={event=>{if(!event.currentTarget.open)setShowAll(false);}}>
    <summary><span className="artifact-list-symbol" aria-hidden="true"><Icon name="folder" size={19}/></span><span className="artifact-list-heading"><strong>文件<span className="artifact-list-count">{files.length}</span></strong><small>{bytes(total)}</small></span><span className="artifact-list-disclosure"><span className="artifact-list-expand-label">展开</span><span className="artifact-list-collapse-label">收起</span><Icon name="down" size={15}/></span></summary>
    <div className="artifact-list-items" aria-label="文件列表">{visible.map(card)}</div>
    {files.length>previewCount&&<button type="button" className="artifact-list-more" onClick={showAll?collapse:()=>setShowAll(true)}>{showAll?'收起文件':`展开其余 ${files.length-previewCount} 个文件`}<span className={showAll?'is-up':''} aria-hidden="true"><Icon name="down" size={13}/></span></button>}
  </details>;
}

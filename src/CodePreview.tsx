import {useMemo} from 'react';
import {highlightMessageCode} from './code-highlight';
import {sourceLanguage} from './source-language';
import './code-preview.css';

export function CodePreview({content,name}:{content:string;name:string}){
  const code=content.replace(/\r\n?/g,'\n');
  const highlighted=useMemo(()=>highlightMessageCode(code,sourceLanguage(name),120_000),[code,name]);
  const numbers=useMemo(()=>Array.from({length:code.split('\n').length},(_,i)=>i+1).join('\n'),[code]);
  return <div className="fp-code-stage" tabIndex={0} role="region" aria-label={`${highlighted.label} 源码，可滚动查看`}>
    <div className="fp-code-grid"><pre className="fp-code-gutter" aria-hidden="true">{numbers}</pre><pre className="fp-code-text">{highlighted.html!==undefined?<code dangerouslySetInnerHTML={{__html:highlighted.html}}/>:<code>{code}</code>}</pre></div>
  </div>;
}

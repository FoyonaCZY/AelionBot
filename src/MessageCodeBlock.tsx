import {Children,isValidElement,useEffect,useMemo,useState,type ComponentProps} from 'react';
import type {ExtraProps} from 'react-markdown';
import {highlightMessageCode} from './code-highlight';
import {useI18n} from './i18n';

export function MessageCodeBlock({children,node,className,...props}:ComponentProps<'pre'>&ExtraProps){
  const {t}=useI18n();
  const child=Children.toArray(children)[0];
  const codeProps=isValidElement<ComponentProps<'code'>>(child)?child.props:undefined;
  const code=typeof codeProps?.children==='string'?codeProps.children:undefined;
  const language=/\blanguage-([^\s]+)/.exec(codeProps?.className||'')?.[1]||'';
  const highlighted=useMemo(()=>highlightMessageCode(code??'',language),[code,language]);
  const html=useMemo(()=>highlighted.html===undefined?undefined:{__html:highlighted.html},[highlighted.html]);
  const [result,setResult]=useState<{code:string;status:'copied'|'error'}>();
  const status=result&&result.code===code?result.status:undefined;
  useEffect(()=>{
    if(result?.status!=='copied')return;
    const timer=setTimeout(()=>setResult(undefined),2000);
    return()=>clearTimeout(timer);
  },[result]);
  const copy=async()=>{
    if(code===undefined)return;
    try{await navigator.clipboard.writeText(code);setResult({code,status:'copied'});}
    catch{setResult({code,status:'error'});}
  };
  if(code===undefined)return <pre {...props} className={className}>{children}</pre>;
  return <div className="message-code-block">
    <div className="message-code-header"><span className="message-code-language">{highlighted.label}</span>
      <button type="button" className="message-code-copy" data-status={status} disabled={!code}
        aria-label={`${status==='error'?t('重试复制'):t('复制')} ${highlighted.label} ${t('代码')}`}
        title={status==='error'?t('复制失败，请重试'):t('复制代码')} onClick={()=>void copy()}>
        <span aria-live="polite">{status==='copied'?t('已复制'):status==='error'?t('重试复制'):t('复制')}</span>
      </button>
    </div>
    <pre {...props} className={`message-code-scroll ${className||''}`} tabIndex={0} aria-label={`${highlighted.label} ${t('代码')}`}>
      {html?<code className={codeProps?.className} dangerouslySetInnerHTML={html}/>:<code className={codeProps?.className}>{code}</code>}
    </pre>
  </div>;
}

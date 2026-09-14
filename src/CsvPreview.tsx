import {useMemo,useRef,useState,useEffect} from 'react';
import {csvRows} from './preview-utils';
import {useI18n} from './i18n';

const PAGE_SIZE=200;
export function CsvPreview({content}:{content:string}){
  const {t}=useI18n(),rows=useMemo(()=>csvRows(content),[content]);
  const [page,setPage]=useState(0),viewport=useRef<HTMLDivElement>(null);
  const pages=Math.max(1,Math.ceil((rows.length-1)/PAGE_SIZE)),current=Math.min(page,pages-1);
  useEffect(()=>{setPage(0);if(viewport.current){viewport.current.scrollTop=0;viewport.current.scrollLeft=0;}},[content]);
  const change=(next:number)=>{setPage(next);if(viewport.current)viewport.current.scrollTop=0;};
  return <><div className="fp-csv markdown-table-scroll" ref={viewport} tabIndex={0} role="region" aria-label={t('表格')}><table><thead><tr>{rows[0]?.map((cell,i)=><th key={i} scope="col">{cell}</th>)}</tr></thead><tbody>{rows.slice(1+current*PAGE_SIZE,1+(current+1)*PAGE_SIZE).map((row,i)=><tr key={current*PAGE_SIZE+i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>{pages>1&&<div className="fp-csv-pagination"><button disabled={current===0} onClick={()=>change(current-1)}>{t('上一页')}</button><output aria-live="polite">{current+1} / {pages}</output><button disabled={current===pages-1} onClick={()=>change(current+1)}>{t('下一页')}</button></div>}</>;
}

import {useEffect,useRef,useState} from 'react';

export function ContextCapacityInput({value,onChange,disabled}:{value:number;onChange:(value:number)=>void;disabled?:boolean}){
  const [draft,setDraft]=useState(String(value)),lastValue=useRef(value);
  useEffect(()=>{if(!Object.is(lastValue.current,value)){lastValue.current=value;setDraft(Number.isFinite(value)?String(value):'');}},[value]);
  const valid=/^\d+$/.test(draft)&&Number(draft)>=8000&&Number(draft)<=1000000;
  return <input aria-label="模型上下文容量" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={7} disabled={disabled} value={draft} aria-invalid={!disabled&&!valid} placeholder="8000–1000000" onChange={event=>{const text=event.target.value;setDraft(text);const parsed=/^\d+$/.test(text)?Number(text):NaN;lastValue.current=parsed;onChange(parsed);}} onBlur={()=>{if(valid)setDraft(String(Number(draft)));}}/>;
}

import {useEffect,useRef,useState} from 'react';
import {appearanceVariables,DEFAULT_APPEARANCE,normalizeAppearance,resolvedTheme,type AppearanceSettings} from './appearance';

const CACHE='aelion-appearance';
export function applyAppearance(value:AppearanceSettings){
  const root=document.documentElement;
  for(const [name,v] of Object.entries(appearanceVariables(value)))root.style.setProperty(name,v);
  const theme=resolvedTheme(value.theme,window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme=theme;root.style.colorScheme=theme;
  window.dispatchEvent(new Event('aelion-appearance-change'));
}
function cached(){try{return normalizeAppearance(JSON.parse(localStorage.getItem(CACHE)||'null'));}catch{return {...DEFAULT_APPEARANCE};}}
export function initializeAppearance(){applyAppearance(cached());}
export function useAppearance(saved?:AppearanceSettings){
  const [settings,setSettings]=useState(cached),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const current=useRef(settings),confirmed=useRef(settings),pending=useRef(0),serial=useRef(Promise.resolve());
  const remember=(value:AppearanceSettings)=>{current.current=value;setSettings(value);applyAppearance(value);try{localStorage.setItem(CACHE,JSON.stringify(value));}catch{}};
  useEffect(()=>{if(saved&&pending.current===0){const next=normalizeAppearance(saved);confirmed.current=next;remember(next);}},[JSON.stringify(saved)]);
  useEffect(()=>{const query=window.matchMedia('(prefers-color-scheme: dark)'),sync=()=>applyAppearance(current.current);query.addEventListener('change',sync);sync();return()=>query.removeEventListener('change',sync);},[]);
  const change=(patch:Partial<AppearanceSettings>)=>{
    const next=normalizeAppearance({...current.current,...patch});remember(next);setError('');setSaving(true);pending.current++;
    serial.current=serial.current.then(async()=>{
      try{await window.aelion.saveAppearanceSettings(next);confirmed.current=next;}
      catch(reason){if(pending.current===1){remember(confirmed.current);setError((reason as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}}
      finally{pending.current--;if(!pending.current)setSaving(false);}
    });
  };
  return {settings,change,saving,error};
}

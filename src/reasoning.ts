export const REASONING_PRESETS=['none','minimal','low','medium','high','xhigh'];
export function reasoningEffort(value:unknown):string|undefined {
  if(value===undefined||value===null||value==='')return undefined;
  if(typeof value!=='string'||value.length>80||/[\u0000-\u001f\u007f]/.test(value))throw Error('推理强度需要 80 字符以内的文本');
  return value.trim()||undefined;
}

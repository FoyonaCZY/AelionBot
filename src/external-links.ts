/** Only web addresses may be handed to the operating system's browser. */
export function externalWebUrl(value:unknown):string|undefined{
  if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))return;
  const input=value.trim();
  if(!/^(?:https?:)?\/\//i.test(input))return;
  try{
    const url=new URL(input.startsWith('//')?`https:${input}`:input);
    if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)return;
    return url.href;
  }catch{return;}
}

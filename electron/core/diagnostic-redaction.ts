import {redactHost} from './host';

export function diagnosticRedactor(secrets:string[],paths:string[]){
  const values=[...new Set(secrets.filter(value=>value.length>=4).flatMap(value=>[value,encodeURIComponent(value),JSON.stringify(value).slice(1,-1)]))].sort((a,b)=>b.length-a.length);
  const roots=[...new Set(paths.filter(Boolean).flatMap(path=>[path,path.replaceAll('\\','/'),path.replaceAll('\\','\\\\')]))].sort((a,b)=>b.length-a.length).map(path=>new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),/^[A-Za-z]:/.test(path)?'gi':'g'));
  return (value:string)=>{
    let text=redactHost(value,values);
    text=text.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,'[redacted private key]')
      .replace(/^[A-Za-z0-9+/=]{48,}\r?$/gm,'[redacted key data]')
      .replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,'$1: [redacted]')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,'[redacted URL]')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,'[redacted email]');
    for(const path of roots)text=text.replace(path,'[local directory]');
    return text.replace(/\b[A-Za-z]:(?:\\+|\/)Users(?:\\+|\/)[^\\/\r\n"<>]+/gi,'[user directory]')
      .replace(/\/(?:Users|home)\/[^/\r\n\s"'<>]+/g,'[user directory]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'');
  };
}

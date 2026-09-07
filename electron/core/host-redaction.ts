import {stripVTControlCharacters} from 'node:util';

export function redactHost(value:string,secrets:string[]=[],preserveLines=false){
  const mask=(value:string,label='[redacted]')=>label+(preserveLines?'\n'.repeat((value.match(/\n/g)||[]).length):'');
  let result=stripVTControlCharacters(value).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,})\b/g,value=>mask(value)).replace(/-----BEGIN ([A-Z ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,value=>mask(value,'[redacted private key]'));
  for(const secret of secrets.filter(secret=>secret.length>=6).sort((a,b)=>b.length-a.length))result=result.split(secret).join(mask(secret));
  return result.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,'$1[redacted]').replace(/(https?:\/\/[^\s/:]+:)[^\s@]+(@)/gi,'$1[redacted]$2').replace(/(?<![\w.-])((?:"|')?[\w.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\r\n,}]+)/gi,(_match,prefix:string,value:string)=>prefix+'"'+mask(value)+'"');
}

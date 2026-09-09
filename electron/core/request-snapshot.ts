import type {ToolDefinition} from './model';

function canonical(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
 return value;
}

// Preserve schema array order, but eliminate object-key and registration-order drift.
export function stableToolDefinitions(tools:ToolDefinition[]):ToolDefinition[]{
 return tools.map(tool=>canonical(tool) as ToolDefinition).sort((a,b)=>a.function.name<b.function.name?-1:a.function.name>b.function.name?1:0);
}

const transportCodes=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','EPIPE','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ENETDOWN','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_RESPONSE_STATUS_CODE','UND_ERR_ABORTED','UND_ERR_DESTROYED','UND_ERR_CLOSED']);
export function transportErrorCodes(error:unknown){
 const pending=[error],seen=new Set<unknown>(),codes=new Set<string>();
 while(pending.length&&seen.size<16){const item=pending.shift();if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);
  const value=item as {code?:unknown;cause?:unknown;errors?:unknown[]};if(typeof value.code==='string'&&transportCodes.has(value.code))codes.add(value.code);
  if(value.cause)pending.push(value.cause);if(Array.isArray(value.errors))pending.push(...value.errors.slice(0,8));
 }
 return [...codes].sort();
}

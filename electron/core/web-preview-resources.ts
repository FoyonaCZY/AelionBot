export const mime:Record<string,string>={html:'text/html',htm:'text/html',js:'text/javascript',mjs:'text/javascript',css:'text/css',json:'application/json',map:'application/json',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',ico:'image/x-icon',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',pdf:'application/pdf'};
export function webResourcePath(value:string){const path=decodeURIComponent(value).replace(/^\//,'');if(!path||path.includes('\\')||path.includes('\0')||path.split('/').some(part=>part==='..'||part.startsWith('.'))||!mime[path.split('.').at(-1)!.toLowerCase()])throw Error('该文件不是可访问的网页资源');return path;}
export function webFileResponse(bytes:Uint8Array,type:string,range:string|null){
 const headers:Record<string,string>={'Content-Type':type.startsWith('text/')?type+'; charset=utf-8':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Accept-Ranges':'bytes'};
 if(!range)return new Response(Uint8Array.from(bytes).buffer,{headers});const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+bytes.length}});
 const start=match[1]?Number(match[1]):Math.max(0,bytes.length-Number(match[2])),end=match[1]&&match[2]?Math.min(bytes.length-1,Number(match[2])):bytes.length-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=bytes.length)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+bytes.length}});
 return new Response(bytes.slice(start,end+1),{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
}

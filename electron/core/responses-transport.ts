import WebSocket from 'ws';
import {createHash} from 'node:crypto';
import type {ModelConfig} from '../../src/shared';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Previous {id:string;options:string;items:string[];}
interface Lane {socket:WebSocket;identity:string;busy:boolean;previous?:Previous;idle?:NodeJS.Timeout;}
export interface TransportStats {transport:'http'|'websocket';incremental:boolean;sentInputItems:number;}
export function websocketEnabled(config:ModelConfig){
 if(config.protocol!=='responses'||config.responsesTransport==='http')return false;
 if(config.responsesTransport==='websocket')return true;
 const url=new URL(config.baseUrl);
 // Unknown compatible endpoints stay on HTTP unless the user enables WS.
 // Auto must not bypass an HTTP proxy selected for the existing transport.
 return url.origin==='https://api.openai.com'&&url.pathname.replace(/\/$/,'')==='/v1'&&!process.env.HTTPS_PROXY&&!process.env.HTTP_PROXY&&!process.env.ALL_PROXY;
}
export class ResponsesTransport {
 private lanes=new Map<string,Lane>();
 private connecting=new Map<string,WebSocket>();
 private disposed=false;
 private unavailable=new Map<string,number>();
 private drop(scope:string,lane:Lane){clearTimeout(lane.idle);if(this.lanes.get(scope)===lane)this.lanes.delete(scope);lane.socket.terminate();}
 dispose(){this.disposed=true;for(const socket of this.connecting.values())socket.terminate();this.connecting.clear();for(const [scope,lane] of this.lanes)this.drop(scope,lane);this.unavailable.clear();}
 async request(scope:string,request:{url:string;headers:Record<string,string>;body:Record<string,any>},signal:AbortSignal,stats:TransportStats):Promise<Response|undefined>{
  signal.throwIfAborted();
  if(this.disposed)throw new Error('模型连接已关闭');
  const identity=digest([request.url,request.headers]),disabled=this.unavailable.get(identity);if(disabled&&disabled>Date.now())return;
  if(this.connecting.has(scope))return;
  let lane=this.lanes.get(scope);
  if(lane?.busy)return;
  if(lane&&(lane.identity!==identity||lane.socket.readyState!==WebSocket.OPEN)){this.drop(scope,lane);lane=undefined;}
  if(!lane){
   if(this.lanes.size+this.connecting.size>=8){const idle=[...this.lanes].find(([,item])=>!item.busy);if(!idle)return;this.drop(...idle);}
   const url=new URL(request.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';
   const socket=new WebSocket(url,{headers:request.headers,followRedirects:false,handshakeTimeout:8000,maxPayload:16*1024*1024});this.connecting.set(scope,socket);
   // Keep late close/error events handled even between requests.
   socket.on('error',()=>{});
   const opened=await new Promise<boolean>(resolve=>{
    const done=(ok:boolean)=>{socket.off('open',open);socket.off('error',error);socket.off('close',error);signal.removeEventListener('abort',abort);resolve(ok);};
    const open=()=>done(true),error=()=>done(false),abort=()=>{socket.terminate();done(false);};socket.once('open',open);socket.once('error',error);socket.once('close',error);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   });
   this.connecting.delete(scope);
   if(this.disposed){socket.terminate();throw new Error('模型连接已关闭');}
   if(!opened){socket.terminate();signal.throwIfAborted();this.disable(identity);return;}
   lane={socket,identity,busy:false};this.lanes.set(scope,lane);
  }
  const active=lane;active.busy=true;clearTimeout(active.idle);
  const {stream:_stream,stream_options:_streamOptions,...body}=request.body;
  const {input,...options}=body,items=Array.isArray(input)?input:[],hashes=items.map(digest),optionsHash=digest(options),previous=active.previous;
  const incremental=Boolean(previous&&previous.options===optionsHash&&hashes.length>=previous.items.length&&previous.items.every((hash,index)=>hashes[index]===hash));
  let payload:Record<string,any>={type:'response.create',...body,...(incremental?{previous_response_id:previous!.id,input:items.slice(previous!.items.length)}:{})};
  stats.transport='websocket';stats.incremental=incremental;stats.sentInputItems=payload.input.length;
  return new Promise<Response|undefined>((resolve,reject)=>{
   let controller!:ReadableStreamDefaultController<Uint8Array>,returned=false,ended=false,recovered=false,hasOutput=false,total=0;
   const encoder=new TextEncoder(),response=new Response(new ReadableStream<Uint8Array>({start(value){controller=value;},cancel:()=>{if(!ended){cleanup(false);this.drop(scope,active);}}}),{headers:{'content-type':'text/event-stream'}});
   const cleanup=(keep:boolean)=>{if(ended)return;ended=true;active.socket.off('message',message);active.socket.off('close',closed);active.socket.off('error',closed);signal.removeEventListener('abort',abort);active.busy=false;if(keep){active.idle=setTimeout(()=>this.drop(scope,active),60000);active.idle.unref();}else active.previous=undefined;};
   const fail=(error:Error)=>{if(ended)return;cleanup(false);this.drop(scope,active);if(returned)controller.error(error);else reject(error);};
   const abort=()=>fail(signal.reason instanceof Error?signal.reason:new Error('请求已取消'));
   const closed=()=>{this.disable(identity);fail(new TypeError('模型增量连接中断，后续请求将恢复完整上下文'));};
   const send=()=>active.socket.send(JSON.stringify(payload),error=>{if(error)closed();});
   const message=(data:WebSocket.RawData)=>{
    if(ended)return;total+=Array.isArray(data)?data.reduce((sum,part)=>sum+part.byteLength,0):data.byteLength;if(total>16*1024*1024){fail(new Error('模型响应超过 16 MB'));return;}
    let event:any;try{event=JSON.parse(data.toString());}catch{fail(new TypeError('模型增量连接返回无效 JSON'));return;}
    const code=event.error?.code||event.error?.type;
    if(event.type==='error'){
     if(code==='previous_response_not_found'&&incremental&&!recovered&&!hasOutput){recovered=true;active.previous=undefined;payload={type:'response.create',...body};stats.incremental=false;stats.sentInputItems=items.length;send();return;}
     if(!returned&&['unsupported_parameter','unknown_parameter','unsupported_transport','invalid_request_error'].includes(code)){cleanup(false);this.drop(scope,active);this.disable(identity);stats.transport='http';stats.incremental=false;stats.sentInputItems=items.length;controller.close();resolve(undefined);return;}
    }
    if(/\.delta$|\.done$/.test(event.type||'')||event.type==='response.output_item.added')hasOutput=true;
    if(!returned){returned=true;resolve(response);}
    controller.enqueue(encoder.encode('data: '+JSON.stringify(event)+'\n\n'));
    if(['response.completed','response.incomplete','response.failed','error'].includes(event.type)){
     if(event.type==='response.completed'&&typeof event.response?.id==='string'&&Array.isArray(event.response.output))active.previous={id:event.response.id,options:optionsHash,items:[...hashes,...event.response.output.map(digest)]};else active.previous=undefined;
     cleanup(true);controller.close();
    }
   };
   active.socket.on('message',message);active.socket.once('close',closed);active.socket.once('error',closed);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else send();
  });
 }
 private disable(identity:string){if(this.unavailable.size>=64)this.unavailable.delete(this.unavailable.keys().next().value!);this.unavailable.set(identity,Date.now()+10*60000);}
}

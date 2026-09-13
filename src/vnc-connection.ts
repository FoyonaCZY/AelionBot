export interface VncClient {
 background:string;scaleViewport:boolean;resizeSession:boolean;viewOnly:boolean;
 addEventListener(type:string,listener:EventListener):void;
 disconnect():void;
}
export interface VncClock {later:(callback:()=>void,ms:number)=>unknown;cancel:(id:unknown)=>void;}
const clock:VncClock={later:(callback,ms)=>setTimeout(callback,ms),cancel:id=>clearTimeout(id as ReturnType<typeof setTimeout>)};
export function startVncConnection(options:{create:()=>VncClient;hasFrame:()=>boolean;onState:(state:'connecting'|'connected'|'failed')=>void;control:boolean;clock?:VncClock}){
 const timers=options.clock||clock;let client:VncClient|undefined,disposed=false,version=0,attempts=0,control=options.control;
 const pending=new Set<unknown>();
 const later=(callback:()=>void,ms:number)=>{let timer:unknown;timer=timers.later(()=>{pending.delete(timer);callback();},ms);pending.add(timer);};
 const clear=()=>{version++;for(const timer of pending)timers.cancel(timer);pending.clear();const previous=client;client=undefined;try{previous?.disconnect();}catch{}};
 const recover=(permanent=false)=>{clear();if(disposed)return;if(permanent||attempts>=3){options.onState('failed');return;}options.onState('connecting');later(connect,[500,1500,3000][attempts++]);};
 const connect=()=>{
  if(disposed)return;clear();const current=version;options.onState('connecting');
  const active=()=>!disposed&&current===version;
  try{
   client=options.create();client.background='transparent';client.scaleViewport=true;client.resizeSession=false;client.viewOnly=!control;
   let handshake=false,checks=0;
   later(()=>{if(active()&&!handshake)recover();},15000);
   client.addEventListener('connect',()=>{if(!active()||handshake)return;handshake=true;
    const frame=()=>{if(!active())return;let painted=false;try{painted=options.hasFrame();}catch{}
     if(painted){for(const timer of pending)timers.cancel(timer);pending.clear();options.onState('connected');later(()=>{if(active())attempts=0;},30000);return;}
     if(++checks>=60){recover();return;}later(frame,250);
    };frame();
   });
   client.addEventListener('disconnect',()=>{if(active())recover();});
   client.addEventListener('securityfailure',()=>{if(active())recover(true);});
   client.addEventListener('credentialsrequired',()=>{if(active())recover(true);});
  }catch{if(active())recover();}
 };
 connect();return {dispose:()=>{disposed=true;clear();},setControl:(next:boolean)=>{control=next;if(client)client.viewOnly=!next;}};
}
/** An opaque black desktop is a valid frame, not a failed connection. */
export function canvasHasFrame(canvas:HTMLCanvasElement|null|undefined){
 if(!canvas||canvas.width<=1||canvas.height<=1)return false;const context=canvas.getContext('2d');if(!context)return false;
 return [[.08,.08],[.5,.08],[.5,.5],[.9,.5],[.5,.92]].some(([x,y])=>context.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data[3]>0);
}

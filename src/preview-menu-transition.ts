import type {PreviewFreezeFrame} from './web-preview';
interface Operations{
 capture:()=>Promise<PreviewFreezeFrame|null>;
 present:(image:string,current:()=>boolean)=>Promise<void>;
 hide:(revision:number)=>Promise<boolean>;
 restore:()=>Promise<unknown>;
 painted:()=>Promise<void>;
 clear:()=>void;
}
/** Both directions keep the previous surface visible until its replacement has painted. */
export class PreviewMenuTransition{
 private sequence=0;
 constructor(private ops:Operations){}
 async change(open:boolean){
  const sequence=++this.sequence,current=()=>sequence===this.sequence;
  try{
   if(open){
    const frame=await this.ops.capture();if(!current()||!frame)return;
    await this.ops.present(frame.image,current);if(!current())return;
    const hidden=await this.ops.hide(frame.revision);if(!current())return;
    if(!hidden)this.ops.clear();
   }else{
    await this.ops.restore();if(!current())return;
    await this.ops.painted();if(current())this.ops.clear();
   }
  }catch(error){
   if(current()){try{await this.ops.restore();await this.ops.painted();}finally{if(current())this.ops.clear();}}
   throw error;
  }
 }
 dispose(){this.sequence++;void this.ops.restore().catch(()=>{});}
}
export function previewSurfacePaint(){return new Promise<void>(resolve=>{
 let first=0,second=0;const done=()=>{clearTimeout(timer);cancelAnimationFrame(first);cancelAnimationFrame(second);resolve();};
 const timer=setTimeout(done,200);first=requestAnimationFrame(()=>{second=requestAnimationFrame(done);});
});}

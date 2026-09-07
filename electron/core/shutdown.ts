interface ShutdownHooks {
  stop:()=>void;
  closeWork:()=>Array<Promise<unknown>>;
  closeVm:()=>Promise<unknown>;
  closeState:()=>void;
  exit:()=>void;
  report:(error:unknown)=>void;
}
export class Shutdown {
  private pending?:Promise<void>;
  constructor(private hooks:ShutdownHooks,private workTimeoutMs=8000){}
  run(){return this.pending??=this.perform();}
  private report(error:unknown){try{this.hooks.report(error);}catch{}}
  private async perform(){
    const {hooks}=this;
    try{hooks.stop();}catch(error){this.report(error);}
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const work=hooks.closeWork().map(promise=>Promise.resolve(promise).catch(error=>this.report(error)));
      await Promise.race([Promise.allSettled(work),new Promise<void>(resolve=>{timer=setTimeout(resolve,this.workTimeoutMs);})]);
    }catch(error){this.report(error);}finally{if(timer)clearTimeout(timer);}
    try{await hooks.closeVm();}catch(error){this.report(error);}
    try{hooks.closeState();}catch(error){this.report(error);}
    finally{hooks.exit();}
  }
}

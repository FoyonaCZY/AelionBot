/** Per-attempt inactivity watchdog. RunPolicy owns the overall task deadline. */
export class RequestIdleTimeout {
 private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;private finished=false;
 readonly signal=this.controller.signal;
 constructor(readonly milliseconds:number){}
 get aborted(){return this.signal.aborted;}
 start(){if(this.finished||this.aborted)return;this.touch();}
 touch(){if(this.finished||this.aborted)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.controller.abort(new DOMException(`模型连续 ${Math.round(this.milliseconds/1000)} 秒没有返回有效输出，请求已超时`,'TimeoutError')),this.milliseconds);this.timer.unref?.();}
 finish(){this.finished=true;clearTimeout(this.timer);}
 dispose(){this.finish();}
}

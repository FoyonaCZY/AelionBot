import {performance} from 'node:perf_hooks';
import type {ModelRequestTiming} from '../../src/model-request-timing';
export class RequestTiming {
  private marks:Partial<ModelRequestTiming>={};
  constructor(private start=performance.now()){}
  mark(phase:Exclude<Extract<keyof ModelRequestTiming,`${string}Ms`>,'totalMs'>){this.marks[phase]??=Math.max(0,performance.now()-this.start);}
  received(bytes:number){this.marks.responseBytes=(this.marks.responseBytes||0)+bytes;}
  activity(kind:string,argumentChars=0){this.marks.lastEventMs=Math.max(0,performance.now()-this.start);this.marks.outputEvents=(this.marks.outputEvents||0)+1;if(kind==='tool')this.mark('firstToolMs');this.marks.toolArgumentChars=(this.marks.toolArgumentChars||0)+argumentChars;}
  completed(){this.marks.completed=true;}
  snapshot():ModelRequestTiming{return {...this.marks,totalMs:Math.max(0,performance.now()-this.start)};}
}

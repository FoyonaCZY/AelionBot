export interface VideoFrameRequest {frameWidth?:number;count?:number;startSeconds?:number;endSeconds?:number;timestamps?:number[];}
export interface VideoSheet {dataUrl:string;width:number;height:number;duration:number;videoWidth:number;videoHeight:number;timestamps:number[];}
export const VIDEO_FRAME_LIMIT=24;
export function videoFrameRequest(args:VideoFrameRequest):VideoFrameRequest{
 const result:VideoFrameRequest={};
 if(args.frameWidth!==undefined){if(!Number.isInteger(args.frameWidth)||args.frameWidth<160||args.frameWidth>1280)throw Error('单帧宽度应为 160–1280 像素');result.frameWidth=args.frameWidth;}
 if(args.count!==undefined){if(!Number.isInteger(args.count)||args.count<1||args.count>VIDEO_FRAME_LIMIT)throw Error('抽帧数量应为 1–24');result.count=args.count;}
 for(const key of ['startSeconds','endSeconds'] as const)if(args[key]!==undefined){if(!Number.isFinite(args[key])||args[key]!<0)throw Error('视频时间应为非负秒数');result[key]=args[key];}
 if(args.timestamps!==undefined){if(!Array.isArray(args.timestamps)||!args.timestamps.length||args.timestamps.length>VIDEO_FRAME_LIMIT||args.timestamps.some(t=>!Number.isFinite(t)||t<0))throw Error('请提供 1–24 个非负时间点');if(args.count!==undefined||args.startSeconds!==undefined||args.endSeconds!==undefined)throw Error('timestamps 不能与数量或时间范围混用');result.timestamps=[...args.timestamps];}
 if(result.endSeconds!==undefined&&result.endSeconds<=(result.startSeconds||0))throw Error('结束时间必须晚于开始时间');videoFrameLayout(result.timestamps?.length??result.count??12,result.frameWidth);return result;
}
export function videoSampleTimes(duration:number,request:VideoFrameRequest){
 videoFrameRequest(request);if(!Number.isFinite(duration)||duration<=0)throw Error('无法读取有限时长的视频');
 if(request.timestamps){if(request.timestamps.some(t=>t>=duration))throw Error('抽帧时间超出视频时长');return request.timestamps;}
 const start=request.startSeconds||0,end=request.endSeconds??duration,count=request.count??12;
 if(start>=duration||end>duration||end<=start)throw Error('抽帧范围超出视频时长');
 const last=Math.max(start,end-Math.min(.05,(end-start)/2));return Array.from({length:count},(_,i)=>count===1?(start+last)/2:start+(last-start)*i/(count-1));
}

export function videoFrameLayout(count:number,requestedWidth?:number){
 const tileWidth=requestedWidth??(count===1?960:320),tileHeight=Math.round(tileWidth*9/16)+22;
 const columns=Math.min(4,count,Math.max(1,Math.floor(2048/tileWidth))),rows=Math.ceil(count/columns),width=columns*tileWidth,height=rows*tileHeight;
 if(width*height>4_000_000||height>4096)throw Error('拼图过大，请减少帧数或降低 frameWidth');
 return {tileWidth,tileHeight,columns,rows,width,height};
}

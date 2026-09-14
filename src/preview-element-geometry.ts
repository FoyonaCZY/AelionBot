export interface ElementGestureRect {width:number;height:number;}
/** CSS-pixel geometry; caller converts pointer movement from the viewport. */
export function resizeElementBox(start:ElementGestureRect,handle:string,dx:number,dy:number,ratio=false){
 let width=Math.max(4,start.width+(handle.includes('e')?dx:handle.includes('w')?-dx:0));
 let height=Math.max(4,start.height+(handle.includes('s')?dy:handle.includes('n')?-dy:0));
 if(ratio&&handle.length===2&&start.width>0&&start.height>0){const factor=Math.max(4/start.width,4/start.height,Math.abs(width/start.width-1)>Math.abs(height/start.height-1)?width/start.width:height/start.height);width=start.width*factor;height=start.height*factor;}
 return {width,height,x:handle.includes('w')?start.width-width:0,y:handle.includes('n')?start.height-height:0};
}
export function translateComponents(value:string){const parts=value==='none'?[]:value.match(/(?:[^\s(]+|\((?:[^()]|\([^()]*\))*\))+/g)||[];return [parts[0]||'0px',parts[1]||'0px',parts[2]||''] as const;}

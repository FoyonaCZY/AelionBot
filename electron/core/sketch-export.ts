import {createHash,randomUUID} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {zipSync,strToU8} from 'fflate';
import svgpath from 'svgpath';
import {parseFont} from './design-fonts';
import type {CanvasScene,SceneNode,SceneColor,SceneRect,SceneGradient} from './canvas-scene';
type ObjectData=Record<string,any>;
export interface SketchRaster{bytes:Buffer;frame:SceneRect;}
export interface SketchExportAssets{reference:Buffer;preview:Buffer;rasters:Map<string,SketchRaster>;licenses?:Record<string,Buffer>;}
const uuid=()=>randomUUID().toUpperCase();
const frame=(r:SceneRect)=>({_class:'rect',constrainProportions:false,x:r.x,y:r.y,width:Math.max(.001,r.width),height:Math.max(.001,r.height)});
const color=(v:SceneColor=[0,0,0,0])=>({_class:'color',alpha:v[3],red:v[0],green:v[1],blue:v[2]});
const context=(opacity=1)=>({_class:'graphicsContextSettings',blendMode:0,opacity});
const gradient=(value?:SceneGradient)=>({_class:'gradient',gradientType:0,elipseLength:0,from:`{${(value?.from||[0,0]).join(', ')}}`,to:`{${(value?.to||[1,1]).join(', ')}}`,stops:(value?.stops||[{offset:0,color:[0,0,0,1] as SceneColor},{offset:1,color:[1,1,1,1] as SceneColor}]).map(stop=>({_class:'gradientStop',position:stop.offset,color:color(stop.color)}))});
const style=()=>({_class:'style',do_objectID:uuid(),borderOptions:{_class:'borderOptions',isEnabled:true,dashPattern:[],lineCapStyle:0,lineJoinStyle:0},startMarkerType:0,endMarkerType:0,miterLimit:10,windingRule:0,innerShadows:[] as ObjectData[],shadows:[] as ObjectData[],fills:[] as ObjectData[],borders:[] as ObjectData[],colorControls:{_class:'colorControls',isEnabled:false,brightness:0,contrast:1,hue:0,saturation:1},contextSettings:context()});
const fill=(c?:SceneColor,g?:SceneGradient)=>({_class:'fill',isEnabled:true,color:color(c),fillType:g?1:0,noiseIndex:0,noiseIntensity:0,patternFillType:1,patternTileScale:1,contextSettings:context(),gradient:gradient(g)});
const border=(c:SceneColor,width:number,position=0)=>({_class:'border',isEnabled:true,color:color(c),fillType:0,position,thickness:width,contextSettings:context(),gradient:gradient()});
const base=(kind:string,name:string,r:SceneRect):ObjectData=>({_class:kind,do_objectID:uuid(),booleanOperation:-1,exportOptions:{_class:'exportOptions',exportFormats:[],includedLayerIds:[],layerOptions:0,shouldTrim:false},frame:frame(r),isFixedToViewport:false,isFlippedHorizontal:false,isFlippedVertical:false,isLocked:false,isTemplate:false,isVisible:true,layerListExpandedType:0,name:name.slice(0,200),nameIsFixed:true,resizingConstraint:63,resizingType:0,rotation:0,shouldBreakMaskChain:false,style:style()});
const ruler=()=>({_class:'rulerData',base:0,guides:[]});
const group=(name:string,r:SceneRect,layers:ObjectData[]):ObjectData=>({...base('group',name,r),hasClickThrough:false,layers});
const point=(x:number,y:number,radius=0)=>({_class:'curvePoint',cornerRadius:radius,cornerStyle:0,curveFrom:`{${x}, ${y}}`,curveTo:`{${x}, ${y}}`,hasCurveFrom:false,hasCurveTo:false,curveMode:1,point:`{${x}, ${y}}`});
function rectangle(node:SceneNode):ObjectData{
 const result:ObjectData={...base('rectangle',node.name,node),edited:false,isClosed:true,pointRadiusBehaviour:2,points:[point(0,0,node.radii?.[0]),point(1,0,node.radii?.[1]),point(1,1,node.radii?.[2]),point(0,1,node.radii?.[3])],fixedRadius:node.radii?.[0]||0,hasConvertedToNewRoundCorners:true,needsConvertionToNewRoundCorners:false};
 if(node.color?.[3]||node.gradient)result.style.fills.push(fill(node.color,node.gradient));if(node.border?.width)result.style.borders.push(border(node.border.color,node.border.width,1));
 for(const shadow of node.shadows||[]){const target=shadow.inset?result.style.innerShadows:result.style.shadows;target.push({_class:shadow.inset?'innerShadow':'shadow',isEnabled:true,blurRadius:shadow.blur,color:color(shadow.color),contextSettings:context(),offsetX:shadow.x,offsetY:shadow.y,spread:shadow.spread});}return result;
}
interface P{x:number;y:number;from?:[number,number];to?:[number,number];}
interface Contour{points:P[];closed:boolean;}
function pathContours(d:string,matrix?:number[]){
 const contours:Contour[]=[];let current:Contour|undefined;
 const parsed=svgpath(d);if(matrix)parsed.matrix(matrix);parsed.abs().unshort().unarc().iterate(segment=>{
  const s=segment as Array<string|number>,type=s[0],v=s.slice(1) as number[];
  if(type==='M'){current={points:[{x:v[0],y:v[1]}],closed:false};contours.push(current);return;}
  if(!current)return;const prev=current.points.at(-1)!;
  if(type==='Z'||type==='z'){current.closed=true;const first=current.points[0],last=current.points.at(-1)!;if(current.points.length>1&&Math.abs(first.x-last.x)<.0001&&Math.abs(first.y-last.y)<.0001){first.from=last.from;current.points.pop();}return;}
  if(type==='L')current.points.push({x:v[0],y:v[1]});else if(type==='H')current.points.push({x:v[0],y:prev.y});else if(type==='V')current.points.push({x:prev.x,y:v[0]});
  else if(type==='C'){prev.to=[v[0],v[1]];current.points.push({x:v[4],y:v[5],from:[v[2],v[3]]});}
  else if(type==='Q'){prev.to=[prev.x+(v[0]-prev.x)*2/3,prev.y+(v[1]-prev.y)*2/3];current.points.push({x:v[2],y:v[3],from:[v[2]+(v[0]-v[2])*2/3,v[3]+(v[1]-v[3])*2/3]});}
 });return contours.filter(c=>c.points.length>1);
}
function shape(d:string,name:string,c:SceneColor|undefined,matrix?:number[],stroke?:SceneNode['stroke']){
 const contours=pathContours(d,matrix);if(!contours.length)return;
 const all=contours.flatMap(contour=>contour.points.flatMap(p=>[[p.x,p.y],...(p.from?[p.from]:[]),...(p.to?[p.to]:[])])),minX=Math.min(...all.map(p=>p[0])),minY=Math.min(...all.map(p=>p[1])),w=Math.max(.001,Math.max(...all.map(p=>p[0]))-minX),h=Math.max(.001,Math.max(...all.map(p=>p[1]))-minY);
 if(all.length>12000)throw Error('单个矢量轮廓过于复杂');
 const coord=(p:[number,number])=>`{${(p[0]-minX)/w}, ${(p[1]-minY)/h}}`;
 const area=(points:P[])=>points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0);
 const dominant=Math.sign(area(contours.reduce((a,b)=>Math.abs(area(a.points))>Math.abs(area(b.points))?a:b).points));
 const layers=contours.map((contour,index)=>{
  const layer:ObjectData={...base('shapePath','轮廓 '+(index+1),{x:0,y:0,width:w,height:h}),edited:true,isClosed:contour.closed,pointRadiusBehaviour:1,points:contour.points.map(p=>({...point((p.x-minX)/w,(p.y-minY)/h),curveMode:p.from||p.to?4:1,hasCurveFrom:!!p.from,hasCurveTo:!!p.to,curveFrom:coord(p.from||[p.x,p.y]),curveTo:coord(p.to||[p.x,p.y])}))};
  layer.booleanOperation=contour.closed&&Math.sign(area(contour.points))!==dominant?1:0;return layer;
 });
 const result:ObjectData={...base('shapeGroup',name,{x:minX,y:minY,width:w,height:h}),hasClickThrough:false,layers,windingRule:0};
 if(c?.[3])result.style.fills.push(fill(c));if(stroke?.width){result.style.borders.push(border(stroke.color,stroke.width));result.style.borderOptions.lineCapStyle=stroke.lineCap==='round'?1:stroke.lineCap==='square'?2:0;result.style.borderOptions.lineJoinStyle=stroke.lineJoin==='round'?1:stroke.lineJoin==='bevel'?2:0;}return result;
}
async function outlineFont(bytes:Buffer){
 const parsed=parseFont(bytes);if(parsed.format==='ttf'||parsed.format==='otf')return parsed;
 if(parsed.format==='woff2'){const {default:decompress}=await import('wawoff2/decompress.js');const unpacked=Buffer.from(await decompress(bytes));if(unpacked.length>64*1024*1024)throw Error('解压字体过大');return parseFont(unpacked);}
 const count=bytes.readUInt16BE(12),length=bytes.readUInt32BE(16);if(length>64*1024*1024||count>4096)throw Error('字体过大');
 const sfnt=Buffer.alloc(length),power=Math.floor(Math.log2(count)),searchRange=16*2**power;
 bytes.copy(sfnt,0,4,8);sfnt.writeUInt16BE(count,4);sfnt.writeUInt16BE(searchRange,6);sfnt.writeUInt16BE(power,8);sfnt.writeUInt16BE(count*16-searchRange,10);let cursor=12+count*16;
 for(let i=0;i<count;i++){const at=44+i*20,offset=bytes.readUInt32BE(at+4),compressed=bytes.readUInt32BE(at+8),original=bytes.readUInt32BE(at+12),checksum=bytes.readUInt32BE(at+16);if(cursor+original>length)throw Error('字体表越界');const source=bytes.subarray(offset,offset+compressed),data=compressed<original?inflateSync(source,{maxOutputLength:original}):source;if(data.length!==original)throw Error('字体表长度不符');const target=12+i*16;bytes.copy(sfnt,target,at,at+4);sfnt.writeUInt32BE(checksum,target+4);sfnt.writeUInt32BE(cursor,target+8);sfnt.writeUInt32BE(original,target+12);data.copy(sfnt,cursor);cursor+=Math.ceil(original/4)*4;}
 return parseFont(sfnt);
}
export async function buildSketchDocument(scene:CanvasScene,assets:SketchExportAssets){
 if(!Number.isFinite(scene.width)||!Number.isFinite(scene.height)||scene.width<1||scene.height<1||scene.width>16000||scene.height>16000)throw Error('Sketch 画布尺寸无效');
 if(!Array.isArray(scene.nodes)||!Array.isArray(scene.fonts)||scene.fonts.length>512||scene.fonts.reduce((sum,font)=>sum+(typeof font.data==='string'?font.data.length:Infinity),0)>64*1024*1024)throw Error('Sketch 字体资源过大或无效');
 let nodeCount=0,textCount=0;const validate=(nodes:SceneNode[],depth=0)=>{if(depth>100||!Array.isArray(nodes))throw Error('Sketch 图层结构无效');for(const node of nodes){if(++nodeCount>8000||!['group','box','text','path','raster'].includes(node.kind)||![node.x,node.y,node.width,node.height].every(value=>Number.isFinite(value)&&Math.abs(value)<=1000000)||node.width<0||node.height<0)throw Error('Sketch 图层范围无效');textCount+=(node.text||'').length;if(textCount>20000||(node.d?.length||0)>500000)throw Error('Sketch 文字或矢量内容过多');if(node.children)validate(node.children,depth+1);}};validate(scene.nodes);
 const files:Record<string,Uint8Array>={},warnings=new Set(scene.warnings),fontCache=new Map<string,ReturnType<typeof parseFont>[]>();let vectorPoints=0,layerCount=0,outlined=0,rasterized=0;
 const image=(bytes:Buffer)=>{const name='images/'+createHash('sha1').update(bytes).digest('hex')+'.png';files[name]=bytes;return {_class:'MSJSONFileReference',_ref_class:'MSImageData',_ref:name};};
 const bitmap=(name:string,data:SketchRaster):ObjectData=>({...base('bitmap',name,data.frame),fillReplacesImage:false,intendedDPI:72,clippingMask:'{{0, 0}, {1, 0}, {1, 1}, {0, 1}}',image:image(data.bytes)});
 for(const font of scene.fonts){try{const comma=font.data.indexOf(','),encoded=font.data.slice(comma+1),bytes=font.data.slice(0,comma).includes(';base64')?Buffer.from(encoded,'base64'):Buffer.from(decodeURIComponent(encoded));const parsed=await outlineFont(bytes),key=font.family.toLowerCase();fontCache.set(key,[...(fontCache.get(key)||[]),parsed]);}catch{warnings.add('部分字体无法生成轮廓，已使用局部图片保留');}}
 const chooseFont=(node:SceneNode,ch?:string)=>{for(const family of (node.family||'').split(',').map(f=>f.trim().replace(/^["']|["']$/g,'').toLowerCase())){const list=fontCache.get(family)||[];const sorted=[...list].sort((a,b)=>Number((a.style==='italic')!==!!node.italic)-Number((b.style==='italic')!==!!node.italic)||Math.abs(a.weight-(node.weight||400))-Math.abs(b.weight-(node.weight||400)));const found=sorted.find(item=>!ch||item.font.hasGlyphForCodePoint(ch.codePointAt(0)!));if(found)return found;}return undefined;};
 const nativeText=(node:SceneNode)=>{
  const parsed=chooseFont(node),family=(node.family||'Arial').split(',')[0].trim().replace(/^["']|["']$/g,''),fontName=parsed?.font.postscriptName||({Arial:node.weight!>=600?'Arial-BoldMT':'ArialMT','Times New Roman':'TimesNewRomanPSMT','Segoe UI':'SegoeUI','Microsoft YaHei':'MicrosoftYaHei'} as Record<string,string>)[family]||family.replace(/\s+/g,'')+(node.weight!>=600?'-Bold':'-Regular');
  const font={_class:'fontDescriptor',attributes:{name:fontName,size:node.size||16,...(parsed?.weightRange?{variation:{'2003265652':node.weight||400}}:{})}},attributes={MSAttributedStringFontAttribute:font,MSAttributedStringColorAttribute:color(node.color),kerning:node.letterSpacing||0,paragraphStyle:{_class:'paragraphStyle',alignment:0,minimumLineHeight:node.height,maximumLineHeight:node.height}};
  const result:ObjectData={...base('text',node.name,node),attributedString:{_class:'attributedString',string:node.text||'',attributes:[{_class:'stringAttribute',location:0,length:(node.text||'').length,attributes}]},automaticallyDrawOnUnderlyingPath:false,dontSynchroniseWithSymbol:false,lineSpacingBehaviour:2,textBehaviour:2,glyphBounds:`{{0, 0}, {${node.width}, ${node.height}}}`};
  result.style.textStyle={_class:'textStyle',verticalAlignment:0,encodedAttributes:attributes};result.userInfo={'chat.aelion.export':{fontFamily:node.family,fontWeight:node.weight}};return result;
 };
 const outlineText=(node:SceneNode)=>{
  const runs:Array<{text:string;parsed:ReturnType<typeof parseFont>}>=[];for(const ch of node.text||''){const parsed=chooseFont(node,ch);if(!parsed||!parsed.weightRange&&Math.abs(parsed.weight-(node.weight||400))>=100||(parsed.style==='italic')!==!!node.italic)return;const last=runs.at(-1);if(last?.parsed===parsed)last.text+=ch;else runs.push({text:ch,parsed});}
  const glyphs:Array<{d:string;x:number;y:number;scale:number}>=[];let advance=0;
  for(const run of runs){let font=run.parsed.font;if(run.parsed.weightRange)try{font=font.getVariation({wght:node.weight||400});}catch{}
   const layout=font.layout(run.text),scale=(node.size||16)/font.unitsPerEm;
   for(let i=0;i<layout.glyphs.length;i++){const glyph=layout.glyphs[i],position=layout.positions[i];vectorPoints+=glyph.path.commands.length;if(vectorPoints>180000)return;glyphs.push({d:glyph.path.toSVG(),x:advance+position.xOffset*scale,y:position.yOffset*scale,scale});advance+=position.xAdvance*scale+(node.letterSpacing||0);}
  }
  if(!advance||!glyphs.length)return;const fit=node.width/Math.max(.001,advance-(node.letterSpacing||0)),layers:ObjectData[]=[];
  for(const g of glyphs){const layer=shape(g.d,'字形',node.color,[g.scale*fit,0,0,-g.scale,node.x+g.x*fit,node.y+(node.baseline||node.height*.8)-g.y]);if(layer)layers.push(layer);}
  if(!layers.length)return;const x=Math.min(...layers.map(l=>l.frame.x)),y=Math.min(...layers.map(l=>l.frame.y)),right=Math.max(...layers.map(l=>l.frame.x+l.frame.width)),bottom=Math.max(...layers.map(l=>l.frame.y+l.frame.height));outlined++;return group(node.name+' · 轮廓',{x,y,width:right-x,height:bottom-y},layers.map(l=>{l.frame.x-=x;l.frame.y-=y;return l;}));
 };
 const relativeLayer=(layer:ObjectData,origin:SceneRect)=>{layer.frame.x-=origin.x;layer.frame.y-=origin.y;return layer;};
 const build=(node:SceneNode,editable:boolean):ObjectData[]=>{
  if(++layerCount>16000)throw Error('Sketch 图层过多，请拆分设计');
  // Off-canvas accessibility links have no screenshot pixels and are not visible artboard content.
  if(['text','raster','path'].includes(node.kind)&&(node.x+node.width<=0||node.y+node.height<=0||node.x>=scene.width||node.y>=scene.height))return[];
  if(node.kind==='group'){
   const children=(node.children||[]).flatMap(child=>build(child,editable));
   if(node.clip){const mask=rectangle({...node,kind:'box',name:'裁切范围',color:[0,0,0,1],children:undefined,shadows:undefined});mask.style.fills=[];mask.hasClippingMask=true;mask.clippingMaskMode=0;children.unshift(mask);}
   const result=group(node.name,node,children.map(layer=>relativeLayer(layer,node)));result.style.contextSettings=context(node.opacity??1);return[result];
  }
  if(node.kind==='text'){
   if(editable)return[nativeText(node)];
   try{const vector=outlineText(node);if(vector)return[vector];}catch{warnings.add('部分文字已用图片保留');}
   const raster=assets.rasters.get(node.id);if(!raster)throw Error('缺少文字外观资源');rasterized++;return[bitmap(node.name+' · 字形图像',raster)];
  }
  if(node.kind==='raster'){const raster=assets.rasters.get(node.id);if(!raster)throw Error('缺少复杂效果资源');rasterized++;return[bitmap(node.name,raster)];}
  if(node.kind==='box')return[rectangle(node)];
  if(node.kind==='path'){try{const layer=shape(node.d||'',node.name,node.color,node.matrix,node.stroke);if(layer){layer.style.contextSettings=context(node.opacity??1);return[layer];}}catch{warnings.add('复杂矢量已按图片保留');}const raster=assets.rasters.get(node.id);if(raster)return[bitmap(node.name,raster)];}
  return[];
 };
 const reference=bitmap('原画面参考（显示以校对）',{bytes:assets.reference,frame:{x:0,y:0,width:scene.width,height:scene.height}});reference.isVisible=false;reference.isLocked=true;
 const art=(name:string,x:number,editable:boolean):ObjectData=>({...base('artboard',name,{x,y:0,width:scene.width,height:scene.height}),hasClickThrough:false,horizontalRulerData:ruler(),verticalRulerData:ruler(),backgroundColor:color([1,1,1,1]),hasBackgroundColor:true,includeBackgroundColorInExport:true,isFlowHome:false,resizesContent:false,layers:[{...reference,do_objectID:uuid()},...scene.nodes.flatMap(node=>build(node,editable))]});
 const artboards=[art('保真图层',0,false),art('可编辑文字',scene.width+100,true)];const page:ObjectData={...base('page',scene.name,{x:0,y:0,width:0,height:0}),hasClickThrough:false,horizontalRulerData:ruler(),verticalRulerData:ruler(),layers:artboards};
 const document={_class:'document',do_objectID:uuid(),assets:{_class:'assetCollection',do_objectID:uuid(),colorAssets:[],gradientAssets:[],images:[],colors:[],gradients:[],exportPresets:[]},colorSpace:1,currentPageIndex:0,foreignLayerStyles:[],foreignSymbols:[],foreignTextStyles:[],layerStyles:{_class:'sharedStyleContainer',objects:[]},layerTextStyles:{_class:'sharedTextStyleContainer',objects:[]},perDocumentLibraries:[],pages:[{_class:'MSJSONFileReference',_ref_class:'MSImmutablePage',_ref:'pages/'+page.do_objectID}]};
 const created={commit:'AelionBot',appVersion:'100.0',build:1,app:'com.bohemiancoding.sketch3',compatibilityVersion:99,version:146,variant:'NONAPPSTORE'};
 const meta={...created,pagesAndArtboards:{[page.do_objectID]:{name:scene.name,artboards:Object.fromEntries(artboards.map(a=>[a.do_objectID,{name:a.name}]))}},autosaved:0,created,saveHistory:[]};
 files['document.json']=strToU8(JSON.stringify(document));files['pages/'+page.do_objectID+'.json']=strToU8(JSON.stringify(page));files['meta.json']=strToU8(JSON.stringify(meta));files['user.json']=strToU8(JSON.stringify({document:{pageListHeight:85,pageListCollapsed:0}}));files['previews/preview.png']=assets.preview;
 warnings.add('“可编辑文字”画板需要相应字体；“保真图层”使用轮廓或局部图片保持字形');
 files['aelion-export.json']=strToU8(JSON.stringify({version:1,creator:'AelionBot',format:'sketch',width:scene.width,height:scene.height,outlinedTextLayers:outlined,rasterLayers:rasterized,warnings:[...warnings]},null,2));
 files['README.txt']=strToU8('AelionBot Sketch export\n\n保真图层：文字尽量保留为矢量轮廓，复杂效果使用局部图片。\n可编辑文字：文字可编辑；接收端需有对应字体，缺失时可能发生替换。\n每个画板包含隐藏的“原画面参考”层，可显示后校对。\n网页交互、自动布局与响应式规则不会变为 Sketch 原生交互。\n\n'+[...warnings].join('\n'));
 for(const [name,bytes]of Object.entries(assets.licenses||{})){if(/^[a-zA-Z0-9_.-]+$/.test(name))files['licenses/'+name]=bytes;}
 const bytes=Buffer.from(zipSync(files,{level:6}));if(bytes.length>120*1024*1024)throw Error('Sketch 文件过大，请拆分设计');
 return {bytes,warnings:[...warnings],document,page,meta};
}

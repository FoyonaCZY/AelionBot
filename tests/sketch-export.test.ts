import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import Ajv from 'ajv';
import schemaPackage from '@sketch-hq/sketch-file-format';
const schemas=(schemaPackage as any).default||schemaPackage;
import {buildSketchDocument} from '../electron/core/sketch-export';
import type {CanvasScene} from '../electron/core/canvas-scene';
import {canvasDesignSource,canvasExportViewport} from '../src/canvas-export';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const font=readFileSync('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
const scene:CanvasScene={name:'Editable design',width:800,height:600,warnings:[],fonts:[{family:'Inter',weight:'100 900',style:'normal',data:'data:font/woff2;base64,'+font.toString('base64')}],nodes:[{id:'group',kind:'group',name:'Card',x:20,y:30,width:400,height:200,clip:true,radii:[12,12,12,12],children:[{id:'box',kind:'box',name:'Background',x:20,y:30,width:400,height:200,color:[1,1,1,1],radii:[12,12,12,12],border:{width:1,color:[.2,.3,.4,1]},gradient:{from:[0,0],to:[1,1],stops:[{offset:0,color:[1,1,1,1]},{offset:1,color:[.5,.7,1,1]}]},shadows:[{x:0,y:4,blur:8,spread:0,color:[0,0,0,.2],inset:false}]},{id:'text',kind:'text',name:'Hello',x:40,y:55,width:120,height:28,text:'Hello',family:'Inter',size:24,weight:700,baseline:23,color:[.1,.2,.3,1]},{id:'path',kind:'path',name:'Icon',x:50,y:110,width:24,height:24,d:'M0 0L24 0L12 24Z',matrix:[1,0,0,1,50,110],color:[.2,.5,.8,1],stroke:{width:2,color:[0,0,0,1],lineCap:'round',lineJoin:'round'}},{id:'effect',kind:'raster',name:'Blurred picture',x:180,y:80,width:60,height:60,reason:'filter'}]}]};
function exported(){return buildSketchDocument(scene,{reference:png,preview:png,rasters:new Map([['text',{bytes:png,frame:scene.nodes[0].children![1]}],['effect',{bytes:png,frame:scene.nodes[0].children![3]}]]),licenses:{'inter.txt':Buffer.from('OFL license fixture')}});}
function walk(layer:any):any[]{return [layer,...(layer.layers||[]).flatMap(walk)];}
test('Sketch archive validates against official document, page, meta and user schemas',async()=>{
 const output=await exported(),zip=unzipSync(output.bytes);
 for(const [name,schema]of [['document.json',schemas.document],['meta.json',schemas.meta],['user.json',schemas.user],['pages/'+output.page.do_objectID+'.json',schemas.page]] as const){const validate=new Ajv({strict:false,allErrors:true,unicodeRegExp:false}).compile(schema);assert.ok(validate(JSON.parse(Buffer.from(zip[name]).toString())),name+' '+JSON.stringify(validate.errors?.slice(0,8)));}
 assert.ok(zip['previews/preview.png']);assert.ok(zip['licenses/inter.txt']);assert.ok(zip['README.txt']);
});
test('Sketch retains editable text, vector outlines, gradients, paths, groups and explicit raster fallbacks',async()=>{
 const output=await exported(),[appearance,editable]=output.page.layers;
 const first=walk(appearance),second=walk(editable);
 const icon=first.find(layer=>layer._class==='shapeGroup'&&layer.name==='Icon');assert.ok(icon);assert.equal(icon.style.borderOptions.lineCapStyle,1);assert.equal(icon.style.borderOptions.lineJoinStyle,1);
 assert.ok(first.some(layer=>layer._class==='group'&&layer.name.includes('轮廓')));
 assert.ok(second.some(layer=>layer._class==='text'&&layer.attributedString.string==='Hello'));
 assert.ok(first.some(layer=>layer.style?.fills?.some((fill:any)=>fill.fillType===1)));
 assert.ok(first.some(layer=>layer._class==='bitmap'&&layer.name==='Blurred picture'));
 assert.ok(first.some(layer=>layer.hasClippingMask));
 assert.equal(appearance.layers[0].isVisible,false);assert.equal(appearance.layers[0].isLocked,true);
 const frames=first.filter(layer=>layer.name.includes('轮廓'));assert.ok(frames.every(layer=>layer.frame.width<200&&layer.frame.height<50),'glyph groups must have tight bounds');
 const zip=unzipSync(output.bytes);for(const layer of [...first,...second])if(layer.image?._ref)assert.ok(zip[layer.image._ref],'image reference must exist');
});
test('Sketch falls back to the supplied glyph image when a font is unavailable',async()=>{
 const unknown={...scene,fonts:[]};const output=await buildSketchDocument(unknown,{reference:png,preview:png,rasters:new Map([['text',{bytes:png,frame:scene.nodes[0].children![1]}],['effect',{bytes:png,frame:scene.nodes[0].children![3]}]])});
 assert.ok(walk(output.page.layers[0]).some(layer=>layer.name==='Hello · 字形图像'));
 assert.ok(walk(output.page.layers[1]).some(layer=>layer._class==='text'));
});
test('export identifies the exact local design and bounds renderer dimensions',()=>{
 assert.deepEqual(canvasDesignSource({name:'page.html',workspace:{botId:'bot',path:'designers/bot/task/pages/page.html'}}),{id:'task',path:'designers/bot/task/pages/page.html'});
 assert.equal(canvasDesignSource({name:'page.html',workspace:{botId:'other',path:'designers/bot/task/page.html'}}),undefined);
 assert.equal(canvasDesignSource({name:'page.pdf',designSessionId:'task',workspace:{botId:'bot',path:'designers/bot/task/page.pdf'}}),undefined);
 assert.deepEqual(canvasExportViewport({width:99999,height:20}),{width:2560,height:320});assert.throws(()=>canvasExportViewport({width:NaN,height:900}));
});

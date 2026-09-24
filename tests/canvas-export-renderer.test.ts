import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
const require=createRequire(import.meta.url),execute=promisify(execFile);
let electron:string|undefined;try{const path=require('electron');if(typeof path==='string'&&existsSync(path))electron=path;}catch{}
const available=electron&&(process.platform!=='linux'||process.env.DISPLAY);
test('native export loads large HTML, waits for lazy images, and ignores off-canvas skip links',{skip:available?false:'Electron binary or display unavailable',timeout:90000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'aelion-export-render-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-export-render-'));rmSync(root,{recursive:true,force:true});});
 const renderer=resolve('electron/canvas-export-renderer.ts'),entry=join(root,'check.cjs');
 const code=`import {app} from 'electron';import assert from 'node:assert/strict';import {unzipSync} from 'fflate';import {renderCanvasExport} from ${JSON.stringify(renderer)};
 app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.on('window-all-closed',()=>{});app.disableHardwareAcceleration();if(process.platform==='darwin')app.setActivationPolicy('prohibited');
 const deadline=setTimeout(()=>app.exit(2),60000);
 void(async()=>{await app.whenReady();const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
 const html='<html><head><style>body{margin:0;background:white}.skip{position:absolute;top:-60px}img{display:block;margin-top:3200px;width:200px;height:120px}</style></head><body><a class="skip">Skip to content</a><h1>Large export</h1><img loading="lazy" src="'+image+'"><!--'+'x'.repeat(3*1024*1024)+'--></body></html>';
 const result=await renderCanvasExport(html,'sketch',{width:480,height:640});assert.ok(result.bytes.length>1000);const files=unzipSync(result.bytes),doc=JSON.parse(Buffer.from(files['document.json']).toString()),page=JSON.parse(Buffer.from(files[doc.pages[0]._ref+'.json']).toString());
 assert.equal(page.layers.length,2);assert.ok(page.layers[0].frame.height>3200);assert.ok(!JSON.stringify(page).includes('Skip to content'));assert.ok(files['previews/preview.png']);console.log('NATIVE_EXPORT_OK');clearTimeout(deadline);app.exit(0);
 })().catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});`;
 await build({stdin:{contents:code,resolveDir:process.cwd(),sourcefile:'native-export-check.ts',loader:'ts'},outfile:entry,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],logLevel:'silent'});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const result=await execute(electron!,[entry],{env,windowsHide:true,timeout:70000,maxBuffer:1024*1024});assert.match(result.stdout,/NATIVE_EXPORT_OK/);
});

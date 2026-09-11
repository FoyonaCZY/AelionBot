import test from 'node:test';
import assert from 'node:assert/strict';
import {officePreview,officePreviewScript,OFFICE_PREVIEW_LIMIT} from '../electron/core/office-preview';
import type {VmController} from '../electron/core/vm';
import {csvRows,previewHtml} from '../src/preview-utils';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../electron/core/store';
import {Attachments} from '../electron/core/attachments';
import {previewViewportSize} from '../src/use-preview-viewport';

test('preview viewport keeps fractional bounds without expanding into scrollbars',()=>{
  for(const width of [613.875,613.4,767.99,1280]){
    const size=previewViewportSize(width,629.625);
    assert.ok(size.width<=width&&width-size.width<1/64);
    assert.ok(size.height<=629.625);
  }
  assert.deepEqual(previewViewportSize(613.875001,629.625001),previewViewportSize(613.875009,629.625009));
  assert.deepEqual(previewViewportSize(20,20,24),{width:0,height:0});
});

test('CSV preview preserves quoted commas, escaped quotes and multiline cells',()=>{
  assert.deepEqual(csvRows('name,note\r\n"A,B","a ""quote""\nand a line"\r\n'),[['name','note'],['A,B','a "quote"\nand a line']]);
  assert.equal(csvRows(Array.from({length:250},()=>Array(40).fill('x').join(',')).join('\n')).length,201);
  assert.equal(csvRows(Array(40).fill('x').join(','))[0].length,30);
});
test('HTML preview applies restrictive policy before any supplied markup',()=>{
  const html=previewHtml('<base href="https://example.com"><script>parent.location="https://example.com"</script>');
  assert.ok(html.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.match(html,/default-src 'none'/);assert.match(html,/form-action 'none'/);assert.match(html,/base-uri 'none'/);
});
test('attachment previews classify HTML, Markdown and SVG consistently',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-preview-formats-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const store=new Store(dir),attachments=new Attachments(store);
  for(const [name,kind,body] of [['sample.html','html','<h1>Hello</h1>'],['sample.md','markdown','# Hello'],['sample.svg','image','<svg xmlns="http://www.w3.org/2000/svg"/>']]){
    const [file]=attachments.importFiles({kind:'bot',id:store.data.bots[0].id},[{name,bytes:Buffer.from(body)}]);assert.equal(attachments.preview(file.id).kind,kind);
  }
});
test('office preview rejects unavailable runtime, excess size and unsafe extensions before conversion',async()=>{
  let calls=0;const vm={state:{status:'stopped'},executePython:async()=>{calls++;}} as unknown as VmController;
  await assert.rejects(officePreview(vm,'bot','.pptx',Buffer.from('offline')),/启动工作电脑/);
  await assert.rejects(officePreview(vm,'bot','.pptx',Buffer.alloc(OFFICE_PREVIEW_LIMIT+1)),/8 MB/);
  assert.throws(()=>officePreviewScript(".pptx';print('bad')"),/不支持/);assert.match(officePreviewScript('.xlsx'),/document\.xlsx/);assert.equal(calls,0);
});
test('image preview uses original bytes rather than a resized model screenshot',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-preview-image-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const store=new Store(dir),bytes=Buffer.from('original-image-bytes'),attachments=new Attachments(store,undefined,undefined,(_bytes,id)=>({id,width:1,height:1}));
  const [file]=attachments.importFiles({kind:'bot',id:store.data.bots[0].id},[{name:'image.png',bytes}]);
  assert.equal(attachments.preview(file.id).dataUrl,'data:image/png;base64,'+bytes.toString('base64'));
});
test('office preview caches successful conversions and retries failed conversions',async()=>{
  let calls=0;const bytes=Buffer.from('preview-cache-fixture');
  const vm={state:{status:'ready'},executePython:async(script:string,input:Buffer)=>{calls++;assert.deepEqual(input,bytes);assert.match(script,/TemporaryDirectory/);assert.match(script,/MacroSecurityLevel/);return {exitCode:calls===1?1:0,stderr:'RuntimeError: conversion failed',stdout:Buffer.from('%PDF-1.4\nfixture').toString('base64')};}} as unknown as VmController;
  await assert.rejects(officePreview(vm,'bot','.pptx',bytes),/conversion failed/);
  const [a,b]=await Promise.all([officePreview(vm,'bot','.pptx',bytes),officePreview(vm,'bot','.pptx',bytes)]);assert.equal(a.kind,'pdf');assert.equal(a,b);assert.equal(calls,2);
});
test('office preview never accepts a successful command without a PDF result',async()=>{
  const vm={state:{status:'ready'},executePython:async()=>({exitCode:0,stderr:'',stdout:Buffer.from('<html>not a PDF</html>').toString('base64')})} as unknown as VmController;
  await assert.rejects(officePreview(vm,'bot','.docx',Buffer.from('invalid-preview-fixture')),/没有生成可读取/);
});

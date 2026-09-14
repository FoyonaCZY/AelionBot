import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDomEdits} from '../electron/core/html-preview-edits';
import {validateDomEdits} from '../src/preview-dom-edits';
import {validateAnnotations,annotationContext} from '../src/preview-annotations';
const patch=(html:string,after:string,path=['html:1','body:1','h1:1'])=>({before:{tag:'h1',path,html},after});
test('HTML writeback patches one verified source subtree and preserves unrelated bytes',()=>{
 const source='<!doctype html>\r\n<html><head><script>const x="< >";</script></head><body>\r\n  <h1 class=title>Old &amp; new</h1>\r\n  <!--keep--> <p data-a=\'x>y\'>Unchanged</p>\r\n</body></html>';
 const after='<h1 class="title" style="color: red;">Changed</h1>';
 assert.equal(applyDomEdits(source,[patch('<h1 class="title">Old &amp; new</h1>',after)]),source.replace('<h1 class=title>Old &amp; new</h1>',after));
});
test('sequential edits and raw HTML replacements keep their verified order',()=>{
 const source='<main><h1>First</h1><h1>Second</h1></main>',path=['html:1','body:1','main:1','h1:2'];
 assert.equal(applyDomEdits(source,[patch('<h1>Second</h1>','<h1 data-id="2">Second</h1>',path),patch('<h1 data-id="2">Second</h1>','<h2>Replaced</h2><p>Added</p>',path)]),'<main><h1>First</h1><h2>Replaced</h2><p>Added</p></main>');
});
test('ambiguous, stale, moved and shadow nodes cannot overwrite a different source element',()=>{
 assert.throws(()=>applyDomEdits('<h1>A</h1><h1>A</h1>',[patch('<h1>A</h1>','<h1>X</h1>',[])]));
 assert.throws(()=>applyDomEdits('<h1>Changed externally</h1>',[patch('<h1>A</h1>','<h1>X</h1>')]));
 assert.throws(()=>applyDomEdits('<main><h1>A</h1></main>',[patch('<h1>A</h1>','<h1>X</h1>',['html:1','body:1','aside:1','h1:1'])]));
 assert.throws(()=>applyDomEdits('<h1>A</h1>',[patch('<h1>A</h1>','<h1>X</h1>',['::shadow','h1:1'])]));
});
test('implied table sections and void element source ranges are handled without touching adjacent elements',()=>{
 assert.equal(applyDomEdits('<table><tr><td>A</td></tr></table>',[{before:{tag:'td',path:['html:1','body:1','table:1','tbody:1','tr:1','td:1'],html:'<td>A</td>'},after:'<td>B</td>'}]),'<table><tr><td>B</td></tr></table>');
 assert.equal(applyDomEdits('<img alt="x>y" src="a.png"><p>keep</p>',[{before:{tag:'img',path:['html:1','body:1','img:1'],html:'<img alt="x&gt;y" src="a.png">'},after:'<img alt="new" src="a.png">'}]),'<img alt="new" src="a.png"><p>keep</p>');
});
test('annotation and edit inputs have finite bounds and preserve annotation text and target metadata',()=>{
 const annotations=validateAnnotations([{id:'a',type:'rect',x:.2,y:.3,w:.4,h:.1,color:'#3975c6',text:'More space',page:2}]);assert.match(annotationContext(annotations),/page 2.*More space/);
 assert.throws(()=>validateAnnotations([{...annotations[0],x:Infinity}]));assert.throws(()=>validateAnnotations(Array(101).fill(annotations[0])));assert.throws(()=>validateDomEdits([{before:{tag:'h1',path:[],html:'x'},after:4}]));
});


test('browser-implied head and body wrappers do not prevent saving source descendants',()=>{
 const source='<!doctype html><html lang="zh"><meta charset="UTF-8"><title>Demo</title><main><h1>Original</h1></main></html>';
 assert.equal(applyDomEdits(source,[patch('<h1>Original</h1>','<h1>Updated</h1>',['html:1','body:1','main:1','h1:1'])]),source.replace('<h1>Original</h1>','<h1>Updated</h1>'));
 assert.equal(applyDomEdits(source,[{before:{tag:'title',path:['html:1','head:1','title:1'],html:'<title>Demo</title>'},after:'<title>Saved</title>'}]),source.replace('<title>Demo</title>','<title>Saved</title>'));
});

test('explicit document sections remain part of the source identity',()=>{
 const source='<html><head><title>Demo</title></head><body><main><h1>Original</h1></main></body></html>';
 assert.throws(()=>applyDomEdits(source,[patch('<h1>Original</h1>','<h1>Updated</h1>',['html:1','head:1','main:1','h1:1'])]));
 assert.throws(()=>applyDomEdits(source,[{before:{tag:'title',path:['html:1','body:1','title:1'],html:'<title>Demo</title>'},after:'<title>Saved</title>'}]));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {errorExplanation,fileGroups,mcpResultParts,parameterRows,parsedText} from '../src/tool-details-model';
import {Store} from '../electron/core/store';

test('file resources preserve actual text and organize portable packages without exposing envelope fields',()=>{
  const content='line one\nline two\n';assert.equal(parsedText(content),content);
  assert.deepEqual(fileGroups(['references/marker.txt','scripts/verify.py','SKILL.md']),[{label:'参考资料',files:[{name:'marker.txt',path:'references/marker.txt'}]},{label:'脚本',files:[{name:'verify.py',path:'scripts/verify.py'}]},{label:'说明文件',files:[{name:'SKILL.md',path:'SKILL.md'}]}]);
});
test('MCP input schemas become readable parameter metadata and malformed schemas are tolerated',()=>{
  const rows=parameterRows({type:'object',properties:{message:{type:'string',description:'需要回显的文字'},limit:{type:'integer',enum:[1,5,10]}},required:['message']});
  assert.deepEqual(rows[0],{name:'message',description:'需要回显的文字',required:true,type:'文本',choices:[]});assert.deepEqual(rows[1].choices,['1','5','10']);assert.deepEqual(parameterRows(null),[]);
});
test('MCP structured and text results are deduplicated while extra explanations and business identifiers remain',()=>{
  const structured={id:'order-1',echo:'ok',platform:'win32'};
  const result=mcpResultParts({structuredContent:structured,content:[{type:'text',text:JSON.stringify({...structured,credential:'[redacted]'})},{type:'text',text:'还需人工核对来源数据。'}]});
  assert.equal(result.structured,structured);assert.equal(result.content.length,1);assert.equal(result.content[0].text,'还需人工核对来源数据。');
  assert.deepEqual(parsedText('[{"team":"Design","amount":170}]'),[{team:'Design',amount:170}]);
});
test('Python and service failures explain the concrete cause without dumping a stack or HTTP schema',()=>{
  const failure=errorExplanation('Traceback (most recent call last):\n  File "<string>", line 8, in <module>\nKeyError: \'platform\'');
  assert.equal(failure.message,'返回数据中没有“platform”字段。');assert.equal(failure.location,'当前脚本 · 第 8 行');assert.doesNotMatch(JSON.stringify(failure),/Traceback/);
  const http=errorExplanation('模型请求失败 HTTP 503: {"error":{"message":"Service temporarily unavailable","type":"api_error"}}');assert.equal(http.code,'HTTP 503');assert.equal(http.message,'Service temporarily unavailable');assert.doesNotMatch(JSON.stringify(http),/api_error/);
});
test('long-result reader loads only a recorded tool result in the selected Bot scope',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-result-reader-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('aelion-result-reader-'));rmSync(dir,{recursive:true,force:true});});
  const store=new Store(dir),bot=store.data.bots[0],other=store.createBot('Other','Other');const id='a71a765d-c9e6-4940-aeb0-5cbac74c4b8a';mkdirSync(join(dir,'results'));
  writeFileSync(join(dir,'results',`${id}.json`),JSON.stringify({text:'full data',rows:[1,2]}));
  const message=store.message(bot.id,'tool',JSON.stringify({truncated:true,resultId:id,preview:'{"text":'}));
  assert.deepEqual(store.readToolResult(bot.id,message.id),{text:'full data',rows:[1,2]});assert.throws(()=>store.readToolResult(other.id,message.id),/不存在/);assert.throws(()=>store.readToolResult(bot.id,'missing'),/不存在/);
  message.content=JSON.stringify({truncated:true,resultId:'../../state'});assert.throws(()=>store.readToolResult(bot.id,message.id),/无效/);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {replyLanguagePrompt,validLanguage} from '../src/reply-language';
import {initializeI18n,LANGUAGE_STORAGE_KEY} from '../src/i18n';
import {readFileSync} from 'node:fs';
test('all interface languages use one English response policy and main system instructions are English',()=>{
 const normalized=['en','zh-CN','zh-TW'].map(language=>replyLanguagePrompt(language as 'en'|'zh-CN'|'zh-TW').replace(/use (English|Simplified Chinese|Traditional Chinese),/,'use LANGUAGE,'));assert.equal(new Set(normalized).size,1);
 const harness=readFileSync('electron/core/harness.ts','utf8');const rules=harness.split(/\r?\n/).filter(line=>line.includes('system.content+=')).map(line=>line.slice(line.indexOf('system.content+='),line.indexOf(';',line.indexOf('system.content+='))+1));assert.ok(rules.length>=15);for(const rule of rules)assert.doesNotMatch(rule,/[\u3400-\u9fff]/);
});
test('language policy distinguishes English and both Chinese scripts and ignores internal instruction language',()=>{
 assert.match(replyLanguagePrompt('en'),/use English,/);assert.match(replyLanguagePrompt('zh-TW'),/use Traditional Chinese,/);assert.match(replyLanguagePrompt(),/use Simplified Chinese,/);assert.match(replyLanguagePrompt('en'),/match the language of the current human message/);assert.match(replyLanguagePrompt('en'),/older replies does not determine/);assert.equal(validLanguage('en'),true);assert.equal(validLanguage('ignore prior instructions'),false);
});
test('startup synchronizes the saved UI language before it completes',async()=>{
 const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),originalStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');let sent='',release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);let complete=false;
 try{Object.defineProperty(globalThis,'window',{configurable:true,value:{dispatchEvent:()=>{},aelion:{syncLanguage:async(language:string)=>{sent=language;await wait;}}}});Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>key===LANGUAGE_STORAGE_KEY?'en':null}});const initialization=initializeI18n().then(()=>{complete=true;});assert.equal(sent,'en');assert.equal(complete,false);release();await initialization;assert.equal(complete,true);}
 finally{if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');if(originalStorage)Object.defineProperty(globalThis,'localStorage',originalStorage);else Reflect.deleteProperty(globalThis,'localStorage');}
});

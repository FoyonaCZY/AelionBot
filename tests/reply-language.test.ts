import test from 'node:test';import assert from 'node:assert/strict';
import {validLanguage} from '../src/interface-language';
import {initializeI18n,currentLanguage,LANGUAGE_STORAGE_KEY} from '../src/i18n';
import {readFileSync} from 'node:fs';
test('main system instructions stay English without a reply-language policy',()=>{
 const harness=readFileSync('electron/core/harness.ts','utf8');assert.doesNotMatch(harness,/replyLanguagePrompt|groupLanguageContext|current response language policy/);
 const rules=harness.split(/\r?\n/).filter(line=>line.includes('system.content+=')).map(line=>line.slice(line.indexOf('system.content+='),line.indexOf(';',line.indexOf('system.content+='))+1));assert.ok(rules.length>=15);for(const rule of rules)assert.doesNotMatch(rule,/[\u3400-\u9fff]/);
});
test('interface language initializes locally without model-language IPC',()=>{
 const beforeWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),beforeStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 try{Object.defineProperty(globalThis,'window',{configurable:true,value:{dispatchEvent:()=>{}}});Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>key===LANGUAGE_STORAGE_KEY?'en':null}});assert.doesNotThrow(()=>initializeI18n());assert.equal(currentLanguage(),'en');assert.equal(validLanguage('invalid'),false);}
 finally{if(beforeWindow)Object.defineProperty(globalThis,'window',beforeWindow);else Reflect.deleteProperty(globalThis,'window');if(beforeStorage)Object.defineProperty(globalThis,'localStorage',beforeStorage);else Reflect.deleteProperty(globalThis,'localStorage');initializeI18n();}
});

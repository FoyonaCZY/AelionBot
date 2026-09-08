import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import {runtimeDraft,runtimeDraftValues} from '../src/runtime-form';
import {runtimeSettings} from '../electron/core/runtime-policy';

test('display seconds round-trip the existing millisecond timeout without losing precision',()=>{
  const defaults=runtimeDraft(DEFAULT_RUNTIME);assert.equal(defaults.numbers.requestTimeoutMs,'180');assert.deepEqual(runtimeDraftValues(defaults),DEFAULT_RUNTIME);
  for(const timeout of [1000,1001,180001,123456,600000]){
    const value={...DEFAULT_RUNTIME,requestTimeoutMs:timeout};assert.deepEqual(runtimeDraftValues(runtimeDraft(value)),value);
  }
});
test('blank or invalid limits cannot be submitted while zero retains its unlimited meaning',()=>{
  const blank=runtimeDraft(DEFAULT_RUNTIME);blank.numbers.maxMinutes='';assert.equal(runtimeDraftValues(blank),undefined);
  const zero=runtimeDraft(DEFAULT_RUNTIME);zero.numbers.maxTurns='0';zero.numbers.maxTokens='0';assert.doesNotThrow(()=>runtimeSettings(runtimeDraftValues(zero)));
  for(const [key,value] of [['modelRetries','6'],['parallelReads','1.5'],['progressSeconds','0'],['requestTimeoutMs','0.5'],['requestTimeoutMs','180.0005']] as const){const draft=runtimeDraft(DEFAULT_RUNTIME);draft.numbers[key]=value;assert.equal(runtimeDraftValues(draft),undefined);}
});
test('edited settings keep the backend contract and checkpoint toggle',()=>{
  const draft=runtimeDraft(DEFAULT_RUNTIME);draft.numbers.requestTimeoutMs='45';draft.numbers.modelRetries='3';draft.fileCheckpoints=true;
  const result=runtimeDraftValues(draft)!;assert.equal(result.requestTimeoutMs,45000);assert.equal(result.fileCheckpoints,true);assert.equal(result.modelRetries,3);assert.deepEqual(runtimeSettings(result),result);
});

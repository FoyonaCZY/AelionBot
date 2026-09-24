import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewMenuTransition} from '../src/preview-menu-transition';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
 const events:string[]=[];let native=true,image=false;let revision=0;
 const ops={capture:async()=>{events.push('capture');return {image:'snapshot',revision:++revision};},present:async(_image:string,current:()=>boolean)=>{if(current()){image=true;events.push('paint snapshot');}},hide:async()=>{assert.ok(image,'native surface must remain until the snapshot is painted');native=false;events.push('hide native');return true;},restore:async()=>{native=true;events.push('show native');},painted:async()=>{events.push('paint native');},clear:()=>{assert.ok(native,'snapshot must remain until the native surface is restored');image=false;events.push('clear snapshot');}};
 return {ops,events,state:()=>({native,image})};
}
test('opening paints the screenshot before hiding the native page, closing restores the page first',async()=>{
 const f=fixture(),transition=new PreviewMenuTransition(f.ops);await transition.change(true);assert.deepEqual(f.state(),{native:false,image:true});await transition.change(false);
 assert.deepEqual(f.events,['capture','paint snapshot','hide native','show native','paint native','clear snapshot']);assert.deepEqual(f.state(),{native:true,image:false});
});
test('an undecoded screenshot cannot expose a blank frame and closing cancels its pending handoff',async()=>{
 const f=fixture(),decoded=deferred<void>(),original=f.ops.present;f.ops.present=async(image,current)=>{await decoded.promise;await original(image,current);};const transition=new PreviewMenuTransition(f.ops),opening=transition.change(true);await tick();assert.deepEqual(f.state(),{native:true,image:false});await transition.change(false);decoded.resolve();await opening;
 assert.ok(!f.events.includes('hide native'));assert.deepEqual(f.state(),{native:true,image:false});
});
test('a late capture after closing cannot hide the restored page',async()=>{
 const f=fixture(),capture=deferred<{image:string;revision:number}>();f.ops.capture=()=>capture.promise;const transition=new PreviewMenuTransition(f.ops),opening=transition.change(true);await transition.change(false);capture.resolve({image:'stale',revision:1});await opening;
 assert.ok(!f.events.includes('hide native'));assert.deepEqual(f.state(),{native:true,image:false});
});
test('reopening while restoration paints does not remove the new screenshot',async()=>{
 const f=fixture(),painted=deferred<void>(),transition=new PreviewMenuTransition(f.ops);await transition.change(true);f.ops.painted=()=>painted.promise;const closing=transition.change(false);await tick();await transition.change(true);painted.resolve();await closing;
 assert.deepEqual(f.state(),{native:false,image:true});assert.ok(!f.events.includes('clear snapshot'));
});
test('decode failure restores the live page and dispose invalidates an outstanding capture',async()=>{
 const f=fixture();f.ops.present=async()=>{throw Error('Image decode failed');};const transition=new PreviewMenuTransition(f.ops);await assert.rejects(transition.change(true),/decode failed/);assert.deepEqual(f.state(),{native:true,image:false});
 const capture=deferred<{image:string;revision:number}>();f.ops.capture=()=>capture.promise;const opening=transition.change(true);transition.dispose();capture.resolve({image:'stale',revision:2});await opening;assert.deepEqual(f.state(),{native:true,image:false});
});

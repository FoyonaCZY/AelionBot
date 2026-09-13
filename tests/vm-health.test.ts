import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {VmHealthChannel} from '../electron/core/vm-health';
class Channel extends EventEmitter {stderr=new EventEmitter();closed=false;destroy(){this.closed=true;}close(){this.destroy();}}
class Client extends EventEmitter {channel=new Channel();execs=0;ended=false;connect(){queueMicrotask(()=>this.emit('ready'));return this;}exec(_command:string,cb:Function){this.execs++;cb(null,this.channel);}end(){this.ended=true;this.emit('close');}}
function fixture(){const clients:Client[]=[];const health=new VmHealthChannel(()=>{const client=new Client();clients.push(client);return client as any;});const send=(i=0,value:any={stdout:'READY'})=>clients[i].channel.emit('data',Buffer.from(JSON.stringify(value)+'\n'));return {clients,health,send};}
test('health refreshes and concurrent readers reuse one authenticated session and one command',async()=>{
 const f=fixture(),a=f.health.read('vm',{},'monitor'),b=f.health.read('vm',{},'monitor');await Promise.resolve();f.send();
 const first=await a;first.stdout+=' changed';assert.equal((await b).stdout,'READY');
 for(let i=0;i<50;i++)assert.equal((await f.health.read('vm',{},'monitor')).stdout,'READY');
 assert.equal(f.clients.length,1);assert.equal(f.clients[0].execs,1);f.health.close();assert.ok(f.clients[0].ended);
});
test('disconnects reject pending work, while the next refresh opens a fresh session',async()=>{
 const f=fixture(),a=f.health.read('vm',{},'monitor');await Promise.resolve();f.clients[0].emit('error',Error('lost'));await assert.rejects(a,/lost/);
 const b=f.health.read('vm',{},'monitor');await Promise.resolve();f.send(1);assert.equal((await b).stdout,'READY');f.health.close();
});
test('changed VM identity closes old connection and cannot return its cached status',async()=>{
 const f=fixture(),a=f.health.read('old',{},'monitor');await Promise.resolve();f.send();await a;
 const b=f.health.read('new',{},'monitor');await Promise.resolve();assert.ok(f.clients[0].ended);f.send(1,{stdout:'NEW'});assert.equal((await b).stdout,'NEW');f.health.close();
});
test('split frames are assembled; invalid or oversized responses close the channel',async()=>{
 const f=fixture(),a=f.health.read('vm',{},'monitor');await Promise.resolve();f.clients[0].channel.emit('data',Buffer.from('{"stdout":'));f.clients[0].channel.emit('data',Buffer.from('"READY"}\n'));assert.equal((await a).stdout,'READY');f.health.close();
 const b=f.health.read('vm',{},'monitor');await Promise.resolve();f.clients[1].channel.emit('data',Buffer.alloc(70000,65));await assert.rejects(b,/过大/);f.health.close();
});
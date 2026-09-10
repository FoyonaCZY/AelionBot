import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import {VmController} from '../electron/core/vm';
import {TerminalSessions,type TerminalDriver} from '../electron/core/terminal-sessions';
test('VM terminal requests a real SSH PTY, carries stdin and preserves exit status without starting QEMU',async t=>{
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'aelion-ssh-terminal-')),key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
 let pty:any,command='',clientConnection:any;const server=new ssh2.Server({hostKeys:[key]},client=>{clientConnection=client;client.on('authentication',context=>context.accept());client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',(accept,_reject,info)=>{pty=info;accept?.();});session.on('exec',(accept,_reject,info)=>{command=info.command;const channel=accept();channel.on('data',(bytes:Buffer)=>{channel.write('HELLO_'+bytes.toString().trim());channel.exit(0);channel.end();});});}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const vm=new VmController({dataDir:dir,runtimeDir:dir,cacheDir:join(dir,'cache')} as any),vmDir=(vm as any).dir;mkdirSync(vmDir,{recursive:true});writeFileSync(join(vmDir,'client.key'),key);
 const parsed=ssh2.utils.parseKey(key);assert.ok(!(parsed instanceof Error)&&!Array.isArray(parsed));(vm as any).record={sshPort:(server.address() as AddressInfo).port,hostKeyHash:createHash('sha256').update(parsed.getPublicSSH()).digest('hex')};(vm as any).stateValue.status='ready';
 t.after(async()=>{clientConnection?.end();await new Promise<void>(resolve=>server.close(()=>resolve()));(vm as any).record=undefined;vm.dispose();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});
 const terminal=await vm.openTerminal('test-bot','read input','/work/test-bot',new AbortController().signal,{cols:90,rows:25});let text='';terminal.onData(value=>text+=value);const exited=new Promise<number>(resolve=>terminal.onExit(resolve));terminal.write('Ada\n');assert.equal(await exited,0);assert.equal(text,'HELLO_Ada');assert.equal(pty.cols,90);assert.equal(pty.rows,25);assert.match(command,/\/work\/test-bot/);assert.equal((vm as any).activeExecutions,0);
});
test('deleting a Bot stops only its owned terminal services and releases their records',async()=>{
 const killed:string[]=[];const vm={openTerminal:async(botId:string)=>{let exit=(code:number)=>{};return {write:()=>{},onData:()=>{},onExit:fn=>{exit=fn;},kill:()=>{killed.push(botId);exit(-9);}} satisfies TerminalDriver;}};
 const sessions=new TerminalSessions(vm as any,undefined,undefined,resolve('electron/core'));
 try{await sessions.start('a','r1',{location:'vm',command:'service',purpose:'service',yieldTimeMs:0},new AbortController().signal);await sessions.start('b','r2',{location:'vm',command:'service',purpose:'service',yieldTimeMs:0},new AbortController().signal);await sessions.forgetBot('a',new AbortController().signal);assert.deepEqual(killed,['a']);assert.equal(sessions.list('a').length,0);assert.equal(sessions.list('b').length,1);}finally{sessions.dispose();}
});

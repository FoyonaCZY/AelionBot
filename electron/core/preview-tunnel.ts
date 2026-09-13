import {createServer,type Server,type Socket} from 'node:net';
import type {ClientChannel} from 'ssh2';
export class PreviewTunnel {
 private server?:Server;private sockets=new Set<Socket>();private channels=new Set<ClientChannel>();private closed=false;
 constructor(private forward:(port:number)=>Promise<ClientChannel>,private targetPort:number){}
 async start(){
  if(this.closed)throw Error('转发已关闭');const server=createServer(socket=>{
   if(this.closed||this.sockets.size>=32){socket.destroy();return;}this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});const timer=setTimeout(()=>socket.destroy(),10000);socket.once('close',()=>clearTimeout(timer));
   void this.forward(this.targetPort).then(channel=>{clearTimeout(timer);if(this.closed||socket.destroyed){channel.destroy();return;}this.channels.add(channel);channel.once('close',()=>{this.channels.delete(channel);socket.destroy();});channel.on('error',()=>socket.destroy());socket.once('close',()=>channel.destroy());socket.pipe(channel).pipe(socket);}).catch(()=>{clearTimeout(timer);socket.destroy();});
  });this.server=server;
  await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',()=>ok());});if(this.closed){server.close();throw Error('转发已关闭');}
  const address=server.address();if(!address||typeof address==='string')throw Error('转发端口不可用');return address.port;
 }
 close(){this.closed=true;for(const socket of this.sockets)socket.destroy();for(const channel of this.channels)channel.destroy();this.server?.close();this.sockets.clear();this.channels.clear();}
}
export const VM_LISTENER_OWNER=String.raw`import os,pathlib,json,sys
bot=sys.argv[1];port=int(sys.argv[2]);root=pathlib.Path('/work')/bot;listeners={}
for family in ['tcp','tcp6']:
 for line in pathlib.Path('/proc/net/'+family).read_text().splitlines()[1:]:
  fields=line.split();address,p=fields[1].split(':')
  if int(p,16)!=port or fields[3]!='0A': continue
  if family=='tcp' and address in ['00000000','0100007F']: listeners[fields[9]]='127.0.0.1'
  if family=='tcp6' and address in ['0'*32,'00000000000000000000000001000000']: listeners[fields[9]]='::1'
for process in pathlib.Path('/proc').iterdir():
 if not process.name.isdigit(): continue
 try:
  cwd=(process/'cwd').resolve(strict=True)
  if not cwd.is_relative_to(root): continue
  for fd in (process/'fd').iterdir():
   try: link=os.readlink(fd)
   except OSError: continue
   if link.startswith('socket:[') and link[8:-1] in listeners:
    print(json.dumps({'host':listeners[link[8:-1]],'pid':int(process.name)}));sys.exit(0)
 except (OSError,PermissionError): continue
raise RuntimeError('端口未监听，或服务不属于当前 Bot 的工作目录；请在自己的项目目录启动服务')
`;
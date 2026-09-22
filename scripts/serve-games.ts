import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {GameRuntime} from '../electron/core/games/runtime';
import {gameProviders} from './game-providers';
const root=fileURLToPath(new URL('..',import.meta.url));
const config=JSON.parse(readFileSync(join(root,'.local/game-model.json'),'utf8'));
const providers=gameProviders(config);
const runtime=new GameRuntime(join(root,'.local/game-data'),providers.decide,providers.check);
const server=await createServer({root,server:{host:'127.0.0.1',port:5185,strictPort:true,fs:{allow:[root,realpathSync(join(root,'node_modules'))],deny:['.env','.env.*','*.{crt,pem}','**/.git/**','**/.local/**']}},optimizeDeps:{entries:['game-preview.html']},plugins:[{name:'local-game-api',configureServer(server){server.middlewares.use('/game-api',async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 try{if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:5185')throw Error('不允许跨站请求');if(req.headers.host!=='127.0.0.1:5185')throw Error('无效主机');if(req.method!=='POST'||req.headers['content-type']!=='application/json')throw Error('请求格式无效');let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>64000)throw Error('请求过大');}const data=JSON.parse(raw||'{}');const method=req.url?.split('?')[0];let result:unknown;
 if(method==='/config')result=providers.publicConfig;
 else if(method==='/inspect')result=runtime.inspect(data.id);
 else if(method==='/read')result=runtime.read(data.groupId,data.omniscient===true);
 else if(method==='/create'){if(!Array.isArray(data.players))throw Error('玩家信息无效');data.players=data.players.map(providers.normalize);result=runtime.create(data);}
 else if(method==='/act')result=runtime.act(data.id,data.requestId,data.action);
 else if(method==='/control')result=runtime.control(data.id,data.action);else throw Error('未知操作');res.end(JSON.stringify(result));
 }catch(e){res.statusCode=400;res.end(JSON.stringify({error:e instanceof Error?e.message:'操作失败'}));}
 });}}]});
await server.listen();console.log('Werewolf: http://127.0.0.1:5185/game-preview.html');
for(const event of ['SIGINT','SIGTERM'] as const)process.on(event,()=>{runtime.dispose();void server.close().then(()=>process.exit());});

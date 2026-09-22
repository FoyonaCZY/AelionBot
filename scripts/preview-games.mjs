import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:5184,strictPort:true,fs:{deny:['.env','.env.*','*.{crt,pem}','**/.git/**','**/.local/**']}},optimizeDeps:{entries:['game-preview.html']}});
await server.listen();
console.log('Game preview: http://127.0.0.1:5184/game-preview.html');

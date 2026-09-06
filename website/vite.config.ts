import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {blogPages} from './blog/plugin.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));

export default defineConfig({
  root,
  base:'/',
  plugins:[blogPages(root)],
  server:{host:'127.0.0.1',port:4173,strictPort:true,fs:{allow:[fileURLToPath(new URL('..',import.meta.url))]}},
  build:{outDir:'dist',emptyOutDir:true,manifest:true,rollupOptions:{input:{home:fileURLToPath(new URL('./index.html',import.meta.url)),blog:fileURLToPath(new URL('./blog.html',import.meta.url))}}},
});

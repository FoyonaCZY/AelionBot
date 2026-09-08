import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {extname} from 'node:path';

const args=process.argv.slice(2),worktree=args.includes('--worktree');
const files=execFileSync('git',worktree?['ls-files','--cached','--others','--exclude-standard','-z']:['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const findings=[];let bytes=0,allowedFixtures=0;
const contents=new Map(),textExtensions=new Set(['.ts','.tsx','.mts','.cts','.js','.mjs','.cjs','.json','.md','.html','.txt','.yml','.yaml','.ps1','.cmd','.css','.svg','.conf','.plist','.py','.sh']);
const forbidden=/(^|\/)(?:\.local|\.git|node_modules|dist|dist-electron|release|output|test-results|playwright-report)(?:\/|$)|^runtime\/(?:qemu|downloads|local-model)(?:\/|$)|(?:^|\/)(?:state\.json|\.env(?:\..*)?|id_rsa.*|id_ed25519.*)$|\.(?:qcow2|vhdx?|iso|sqlite(?:-wal|-shm)?|pfx|p12|pem|log)$/i;
const credential=/(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g;
for(const file of [...new Set(files)]){
  if(forbidden.test(file)&&!file.endsWith('.env.example')){findings.push({file,kind:'local-or-sensitive-file'});continue;}
  let data;try{data=worktree?readFileSync(file):execFileSync('git',['show',':'+file],{maxBuffer:6*1024*1024,stdio:['ignore','pipe','ignore']});}catch{findings.push({file,kind:'unreadable-or-oversized-file'});continue;}
  contents.set(file,data);bytes+=data.length;if(data.length>5*1024*1024)findings.push({file,kind:'large-file',bytes:data.length});
  if(!textExtensions.has(extname(file))&&!['.gitignore','.gitattributes','LICENSE'].includes(file)){if(!/^assets\/icon\.(png|ico)$/.test(file)&&file!=='assets/wallpaper-light.png'&&!/^docs\/assets\/(?:screenshots|product)\/[^/]+\.(png|jpe?g|webp)$/i.test(file)&&!/^website\/public\/blog-media\/(?:[^/]+\/)*[^/]+\.(png|jpe?g|webp|gif)$/i.test(file))findings.push({file,kind:'unexpected-artifact'});continue;}
  const lines=data.toString('utf8').split(/\r?\n/);
  for(let index=0;index<lines.length;index++){
    const line=lines[index];for(const match of line.matchAll(credential)){
      const fixture=['tests/host.test.ts','scripts/audit-publication.mjs'].includes(file)&&(/^ghp_abcdefghijklmnopqrstuvwxyz\d*$/.test(match[0])||match[0]==='-----BEGIN PRIVATE KEY-----'&&(file==='scripts/audit-publication.mjs'||line.includes('\\nprivate\\n')));
      if(fixture)allowedFixtures++;else findings.push({file,line:index+1,kind:'credential-like-value'});
    }
    const profiles=[...line.matchAll(/C:[\\/]+Users[\\/]+([^\\/\s"']+)/gi)].map(match=>match[1]);
    if(profiles.some(name=>!['example','user','test','public','default'].includes(name.toLowerCase()))||/[A-Za-z0-9._%+-]+@(?:126|163|qq|gmail|outlook)\.com/i.test(line))findings.push({file,line:index+1,kind:'personal-local-reference'});
    if(/\b(?:apiKey|encryptedKey|access_token)\s*[:=]\s*['"][A-Za-z0-9+/_=-]{24,}['"]/.test(line))findings.push({file,line:index+1,kind:'embedded-credential'});
  }
}
if(!files.length)findings.push({kind:'no-files-to-audit'});
const pkg=JSON.parse((contents.get('package.json')||readFileSync('package.json')).toString('utf8')),repo=`${pkg.build.publish.owner}/${pkg.build.publish.repo}`;
if(pkg.repository?.url!==`https://github.com/${repo}.git`)findings.push({file:'package.json',kind:'update-repository-mismatch'});
const report={files:new Set(files).size,bytes,allowedSyntheticCredentialFixtures:allowedFixtures,findings,passed:findings.length===0};
const reportAt=args.indexOf('--report');if(reportAt>=0)writeFileSync(args[reportAt+1],JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(findings.length)process.exitCode=1;

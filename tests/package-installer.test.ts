import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {PACKAGE_INSTALLER} from '../electron/core/package-installer';
import {installationProgress,workstationProgress,workstationFailure} from '../electron/core/workstation-progress';

const python=process.env.AELION_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
const probe=spawnSync(python,['--version'],{windowsHide:true,timeout:10000});
if(process.env.AELION_TEST_PYTHON)assert.equal(probe.status,0,'Configured test Python must be available');
function run(code:string){const result=spawnSync(python,['-c',`import json,sys\np=json.load(sys.stdin)\nns={'__name__':'fixture'}\nexec(p['source'],ns)\n${code}`],{input:JSON.stringify({source:PACKAGE_INSTALLER}),encoding:'utf8',windowsHide:true,timeout:25000,env:{...process.env,PYTHONIOENCODING:'utf-8'}});assert.equal(result.status,0,result.stderr||String(result.error));}

test('package retries preserve existing sources/proxy and separate downloads from configuration',{skip:probe.status!==0},()=>run(String.raw`
import tempfile,pathlib,os
with tempfile.TemporaryDirectory() as root:
 state=pathlib.Path(root)/'state';cache=pathlib.Path(root)/'cache';cache.mkdir();(cache/'kept.deb').write_bytes(b'cached')
 os.environ['http_proxy']='http://fixture-proxy.invalid:7890'
 class Fake(ns['Installer']):
  def run(self,args,phase,limit,idle=None):
   calls.append((self.source,phase,args))
   assert os.environ['http_proxy']=='http://fixture-proxy.invalid:7890'
   assert not any('Proxy=' in arg for arg in args)
   return 100 if self.source=='current' else 0
 calls=[];installer=Fake(str(state),str(cache),codename='bookworm');installer.install('office',['libreoffice-writer'])
 assert [(source,phase) for source,phase,args in calls]==[('current','updating'),('tuna','updating'),('tuna','downloading'),('tuna','installing')]
 assert '--download-only' in calls[-2][2] and '--no-download' in calls[-1][2]
 assert '--no-remove' in calls[-1][2] and 'APT::Update::Error-Mode=any' in calls[0][2]
 assert 'signed-by=/usr/share/keyrings/debian-archive-keyring.gpg' in (state/'sources-tuna.list').read_text()
 assert 'bookworm-security' in (state/'sources-tuna.list').read_text()
 assert (cache/'kept.deb').read_bytes()==b'cached'
 assert json.loads((state/'desktop-progress.json').read_text())['phase']=='complete'
 calls.clear();installer.install('browser',['chromium']);assert [(s,p) for s,p,a in calls]==[('tuna','downloading'),('tuna','installing')]
`));

test('source exhaustion is bounded and configuration failures do not blindly rotate mirrors',{skip:probe.status!==0},()=>run(String.raw`
import tempfile,pathlib
with tempfile.TemporaryDirectory() as root:
 class Offline(ns['Installer']):
  def run(self,args,phase,limit,idle=None): calls.append((self.source,phase));return 100
 calls=[];installer=Offline(root,root,codename='bookworm')
 try: installer.install('desktop',['xfce4-session'])
 except RuntimeError: pass
 else: raise AssertionError('Offline install succeeded')
 assert len(calls)==4 and json.loads((pathlib.Path(root)/'desktop-progress.json').read_text())['error']=='sources-unavailable'
 class Broken(ns['Installer']):
  def run(self,args,phase,limit,idle=None): return 100 if phase=='installing' else 0
 try: Broken(root,root,codename='bookworm').install('office',['libreoffice-calc'])
 except RuntimeError: pass
 else: raise AssertionError('Broken configuration succeeded')
 assert json.loads((pathlib.Path(root)/'desktop-progress.json').read_text())['error']=='package-configure'
`));

test('package configuration continues while active and stops when output stalls',{skip:probe.status!==0},()=>run(String.raw`
import tempfile,pathlib
with tempfile.TemporaryDirectory() as root:
 installer=ns['Installer'](root,root,codename='bookworm')
 assert installer.run([sys.executable,'-u','-c','import time\nfor i in range(8):\n print("Configuring package", i, flush=True); time.sleep(.2)'],'installing',0,1)==0
 assert installer.run([sys.executable,'-u','-c','import time; print("Configuration started", flush=True); time.sleep(10)'],'installing',0,.5)==124
`));

test('real subprocess progress is captured and stalled downloads are terminated',{skip:probe.status!==0},()=>run(String.raw`
import tempfile,pathlib,time
with tempfile.TemporaryDirectory() as root:
 installer=ns['Installer'](root,root,codename='bookworm')
 assert installer.run([sys.executable,'-c','print("dlstatus:1:42.5:Downloading")'],'downloading',10,5)==0
 assert ns['progress_line']('pmstatus:libreoffice-writer:75:Configuring')==(75,'libreoffice-writer')
 assert ns['progress_line']('pmstatus:libc6:amd64:25:Configuring')==(25,'libc6:amd64')
 assert ns['progress_line']('dlstatus:1:nan:bad') is None
 assert ns['progress_line']('dlstatus:1:140:bad') is None
 begin=time.monotonic();assert installer.run([sys.executable,'-c','import time; time.sleep(15)'],'downloading',10,.25)==124
 assert time.monotonic()-begin<8
 assert json.loads((pathlib.Path(root)/'desktop-progress.json').read_text())['phase']=='retrying'
`));

test('installation progress is scoped to the current stage and rejects unsafe fields',()=>{
  const output='READY\nSTAGE:office\nINSTALL_PROGRESS:'+JSON.stringify({stage:'office',phase:'downloading',percent:42.5,source:'tuna',updatedAt:1})+'\n';
  assert.equal(installationProgress(output)?.percent,42.5);assert.match(workstationProgress(output),/正在下载办公软件 · 42%/);
  assert.equal(installationProgress(output.replace('STAGE:office','STAGE:finishing')),undefined);
  assert.equal(installationProgress(output.replace('42.5','140'))?.percent,undefined);
  const failed=output.replace('"downloading"','"failed"').replace('"updatedAt":1','"updatedAt":1,"error":"sources-unavailable"');assert.match(workstationFailure(failed),/已下载的软件包保留/);
});

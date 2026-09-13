import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {STORAGE_MAINTENANCE,STORAGE_POLICY_FILES} from '../electron/core/storage-policy';
const python=process.env.AELION_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
const probe=spawnSync(python,['--version'],{windowsHide:true,timeout:10000});
if(process.env.AELION_TEST_PYTHON)assert.equal(probe.status,0);
test('cache maintenance only removes regenerable archives, skips incomplete installs and respects package locks',{skip:probe.status!==0},()=>{
 const code=String.raw`import json,sys,types,tempfile,pathlib,builtins
payload=json.load(sys.stdin)
ns={'__name__':'fixture'}
busy=False
fake=types.SimpleNamespace(LOCK_EX=1,LOCK_NB=2)
def lock(*args):
 if busy: raise BlockingIOError('busy')
fake.flock=lock;fake.lockf=lock;sys.modules['fcntl']=fake
exec(payload,ns)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp)
 for name in ['var/lib/aelion','var/lib/dpkg','var/cache/apt/archives/partial','var/cache/aelion','work']:(root/name).mkdir(parents=True,exist_ok=True)
 state=root/'var/lib/aelion';(state/'desktop-ready').touch()
 ns['pathlib']=types.SimpleNamespace(Path=lambda value:root/str(value).lstrip('/'))
 ns['open']=lambda name,mode:builtins.open(root/name.lstrip('/'),mode)
 for name in ['var/cache/apt/archives/one.deb','var/cache/aelion/browser.deb','var/cache/apt/pkgcache.bin','work/result.deb','var/cache/aelion/keep.txt','var/cache/apt/archives/partial/retry.deb']:(root/name).write_bytes(b'cache')
 (state/'desktop-progress.json').write_text('{"phase":"failed"}')
 assert ns['clean_caches']()['skipped']=='installation-not-complete'
 assert (root/'var/cache/apt/archives/one.deb').exists()
 (state/'desktop-progress.json').write_text('{"phase":"complete"}')
 busy=True;assert ns['clean_caches']()['skipped']=='installer-busy';assert (root/'var/cache/aelion/browser.deb').exists()
 busy=False;result=ns['clean_caches']();assert result['removedFiles']==3 and result['removedBytes']==15
 assert (root/'work/result.deb').read_bytes()==b'cache'
 assert (root/'var/cache/aelion/keep.txt').exists() and (root/'var/cache/apt/archives/partial/retry.deb').exists()
 assert ns['clean_caches']()['removedFiles']==0
`;
 const result=spawnSync(python,['-c',code],{input:JSON.stringify(STORAGE_MAINTENANCE),encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr||String(result.error));
 assert.match(STORAGE_POLICY_FILES['/etc/systemd/journald.conf.d/60-aelion-storage.conf'],/SystemMaxUse=128M/);
});
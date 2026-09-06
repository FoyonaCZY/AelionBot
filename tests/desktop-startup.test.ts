import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {BOT_DESKTOP_SCRIPT} from '../electron/core/bot-desktop-profile';
import {SESSION_LAUNCHER} from '../electron/core/desktop-profile';

const python=process.env.AELION_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
const available=spawnSync(python,['--version'],{windowsHide:true}).status===0;
function run(code:string){const result=spawnSync(python,['-c',code],{input:JSON.stringify({desktop:BOT_DESKTOP_SCRIPT,launcher:SESSION_LAUNCHER}),encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(result.status,0,result.stderr||String(result.error));}

test('desktop readiness tolerates a slow startup and transient probes, but fails boundedly',{skip:!available},()=>run(String.raw`
import ast,json,sys,types,subprocess
p=json.load(sys.stdin)
tree=ast.parse(p['desktop'])
body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ['wait_for','ready','display_ready','stop_child']]
class Clock:
 def __init__(self): self.now=0
 def monotonic(self): return self.now
 def sleep(self,n): self.now+=n
clock=Clock()
ns={'time':clock,'subprocess':subprocess}
exec(compile(ast.Module(body=body,type_ignores=[]),'desktop-fixture','exec'),ns)
child=types.SimpleNamespace(poll=lambda:None)
ns['wait_for'](lambda:clock.now>=40,child,75,'Bot desktop')
assert clock.now==40
clock.now=0
try: ns['wait_for'](lambda:False,child,75,'Bot desktop')
except RuntimeError as e: assert 'timed out' in str(e)
else: raise AssertionError('Missing bounded timeout')
assert clock.now==75
clock.now=0
try: ns['wait_for'](lambda:False,types.SimpleNamespace(poll=lambda:1),75,'Bot desktop')
except RuntimeError as e: assert 'exited' in str(e)
else: raise AssertionError('Exited process was accepted')
assert clock.now==0
calls=[]
def probe(*args,**kwargs):
 calls.append(args)
 if len(calls)<3: raise subprocess.TimeoutExpired('xprop',3)
 return types.SimpleNamespace(returncode=0,stdout='window id # 0x123')
ns['subprocess']=types.SimpleNamespace(run=probe,TimeoutExpired=subprocess.TimeoutExpired)
ns['wait_for'](lambda:ns['ready']({}),child,75,'Bot desktop')
assert len(calls)==3
kills=[]
def blocked_wait(**kwargs): raise subprocess.TimeoutExpired('owned-child',3)
ns['os']=types.SimpleNamespace(killpg=lambda pid,sig:kills.append((pid,sig)))
ns['signal']=types.SimpleNamespace(SIGTERM=15,SIGKILL=9)
ns['stop_child'](types.SimpleNamespace(pid=42,poll=lambda:None,wait=blocked_wait))
ns['stop_child'](types.SimpleNamespace(pid=99,poll=lambda:0))
assert kills==[(42,15),(42,9)]
`));

test('desktop autostart reuses its own session without reacquiring the startup lock',{skip:!available},()=>run(String.raw`
import json,sys,os
p=json.load(sys.stdin)
class Routed(Exception): pass
routes=[]
def direct(file,args,env):
 routes.append(('direct',file,args,env.copy()))
 raise Routed()
def routed(file,args):
 routes.append(('ensure',file,args))
 raise Routed()
os.execvpe=direct
os.execv=routed
sys.argv=['aelion-session','/usr/local/bin/aelion-style']
for context,expected in [('alpha','direct'),('beta','ensure'),('','ensure')]:
 os.environ.clear()
 os.environ.update(AELION_BOT_ID='alpha',AELION_DESKTOP_CONTEXT=context,DISPLAY=':42',DBUS_SESSION_BUS_ADDRESS='unix:path=/fixture')
 try: exec(p['launcher'],{'__name__':'fixture'})
 except Routed: pass
 assert routes[-1][0]==expected
 if expected=='direct':
  assert routes[-1][1]=='/usr/local/bin/aelion-style'
  assert routes[-1][3]['DISPLAY']==':42'
 else:
  assert routes[-1][1]=='/usr/local/bin/aelion-bot-desktop'
  assert routes[-1][2][2]=='alpha'
`));

// Managed guest policy: bounded diagnostic logs and expendable installation caches only.
export const STORAGE_MAINTENANCE=String.raw`#!/usr/bin/python3
import pathlib,subprocess,json,fcntl,os,stat

def regular(path):
 try: return stat.S_ISREG(path.lstat().st_mode)
 except FileNotFoundError: return False

def clean_caches():
 state=pathlib.Path('/var/lib/aelion')
 if not (state/'desktop-ready').exists(): return {'skipped':'desktop-not-ready'}
 try: progress=json.loads((state/'desktop-progress.json').read_text())
 except (OSError,ValueError): progress={}
 if progress.get('phase') not in (None,'complete'): return {'skipped':'installation-not-complete'}
 locks=[]
 try:
  for name in ['/var/lib/aelion/desktop.lock','/var/lib/dpkg/lock-frontend','/var/lib/dpkg/lock','/var/cache/apt/archives/lock']:
   lock=open(name,'a');locks.append(lock)
   if name.endswith('desktop.lock'): fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   else: fcntl.lockf(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  removed=0;count=0
  for directory in ['/var/cache/apt/archives','/var/cache/aelion']:
   root=pathlib.Path(directory)
   if not root.exists() or root.is_symlink(): continue
   for path in root.glob('*.deb'):
    if regular(path): removed+=path.stat().st_size;path.unlink();count+=1
  for name in ['pkgcache.bin','srcpkgcache.bin']:
   path=pathlib.Path('/var/cache/apt')/name
   if regular(path): removed+=path.stat().st_size;path.unlink();count+=1
  return {'removedBytes':removed,'removedFiles':count}
 except BlockingIOError: return {'skipped':'installer-busy'}
 finally:
  for lock in reversed(locks): lock.close()

def run(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=120)
 return {'exitCode':p.returncode,'output':(p.stdout+p.stderr)[-2000:]}

def main():
 result={'cache':clean_caches(),'journal':run(['journalctl','--rotate','--vacuum-size=128M'])}
 result['trim']={path:run(['fstrim','-v',path]) for path in ['/','/work'] if os.path.ismount(path)}
 print(json.dumps(result))
if __name__=='__main__': main()
`;
export const STORAGE_POLICY_FILES={
  '/etc/systemd/journald.conf.d/60-aelion-storage.conf':'[Journal]\nSystemMaxUse=128M\nSystemMaxFileSize=16M\nSystemKeepFree=512M\nRuntimeMaxUse=32M\nMaxRetentionSec=7day\nMaxFileSec=1day\n',
  '/usr/local/sbin/aelion-storage-maintenance':STORAGE_MAINTENANCE,
  '/etc/systemd/system/aelion-storage.service':'[Unit]\nDescription=Aelion managed cache and log maintenance\nAfter=local-fs.target\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/aelion-storage-maintenance\nNice=19\nIOSchedulingClass=idle\nTimeoutStartSec=5min\n',
  '/etc/systemd/system/aelion-storage.timer':'[Unit]\nDescription=Bound Aelion guest storage\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=15min\nPersistent=true\n[Install]\nWantedBy=timers.target\n'
};
export const STORAGE_POLICY_BOOTSTRAP=String.raw`python3 - <<'AELION_STORAGE_POLICY'
import pathlib,base64,json,subprocess,os
files=json.loads(base64.b64decode('`+Buffer.from(JSON.stringify(STORAGE_POLICY_FILES)).toString('base64')+String.raw`'));changed=False
for name,content in files.items():
 path=pathlib.Path(name);data=content.encode()
 if path.exists() and path.read_bytes()==data: continue
 path.parent.mkdir(parents=True,exist_ok=True);temporary=path.with_name(path.name+'.aelion-new');temporary.write_bytes(data);temporary.chmod(0o755 if name.startswith('/usr/local/sbin/') else 0o644);temporary.replace(path);changed=True
if changed:
 subprocess.run(['systemctl','daemon-reload'],check=True)
 subprocess.run(['systemctl','restart','systemd-journald'],check=True)
subprocess.run(['systemctl','enable','--now','aelion-storage.timer'],check=True)
subprocess.run(['systemctl','enable','--now','fstrim.timer'],check=True)
print('AELION_STORAGE_POLICY_READY')
AELION_STORAGE_POLICY
`;
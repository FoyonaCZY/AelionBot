// Uses APT's existing proxy settings and signed repositories. Mirror overrides
// are local to these installation commands; system sources/proxy files stay intact.
export const PACKAGE_INSTALLER=String.raw`#!/usr/bin/python3
import json,os,pathlib,re,signal,subprocess,sys,tempfile,time

SOURCES=[('current',None),('tuna','https://mirrors.tuna.tsinghua.edu.cn'),('ustc','https://mirrors.ustc.edu.cn'),('debian','https://deb.debian.org')]
STAGES={'desktop','office','browser','runtime'}

def progress_line(line):
    match=re.match(r'^(dlstatus|pmstatus):([^:]+(?::[a-z][a-z0-9-]*)?):([0-9.]+):',line)
    if not match: return None
    try: percent=float(match[3])
    except ValueError: return None
    if not 0<=percent<=100: return None
    package=match[2] if match[1]=='pmstatus' and re.fullmatch(r'[a-zA-Z0-9.+:_-]{1,120}',match[2]) else None
    return percent,package

def source_text(origin,codename):
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,30}',codename): raise ValueError('Invalid Debian codename')
    key='[signed-by=/usr/share/keyrings/debian-archive-keyring.gpg]'
    return '\n'.join('deb '+key+' '+origin+'/'+repo+' '+suite+' main contrib non-free non-free-firmware' for repo,suite in [('debian',codename),('debian',codename+'-updates'),('debian-security',codename+'-security')])+'\n'

class Installer:
    def __init__(self,state='/var/lib/aelion',cache='/var/cache/apt/archives',apt='/usr/bin/apt-get',codename=None):
        self.state=pathlib.Path(state);self.cache=pathlib.Path(cache);self.apt=apt
        self.state.mkdir(parents=True,exist_ok=True);self.stage='desktop';self.source='current';self.last_write=0
        self.codename=codename
        if self.codename is None:
            values=dict(line.split('=',1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
            if values.get('ID','').strip('"')!='debian': raise RuntimeError('Only the managed Debian guest is supported')
            self.codename=values.get('VERSION_CODENAME','').strip('"')
    def emit(self,phase,percent=None,package=None,error=None,force=False):
        now=time.monotonic()
        if not force and now-self.last_write<2: return
        self.last_write=now
        value={'stage':self.stage,'phase':phase,'source':self.source,'updatedAt':time.time()}
        if percent is not None: value['percent']=round(percent,1)
        if package: value['package']=package
        if error: value['error']=error
        path=self.state/'desktop-progress.json';temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value));temp.replace(path)
    def options(self,name,origin):
        args=['-o','Acquire::Retries=1','-o','Acquire::http::Timeout=20','-o','Acquire::https::Timeout=20','-o','DPkg::Lock::Timeout=45','-o','Dpkg::Use-Pty=0','-o','APT::Status-Fd=1','-o','APT::Keep-Downloaded-Packages=true','-o','Dpkg::Options::=--force-confdef','-o','Dpkg::Options::=--force-confold']
        if origin:
            path=self.state/('sources-'+name+'.list');path.write_text(source_text(origin,self.codename))
            args+=['-o','Dir::Etc::sourcelist='+str(path),'-o','Dir::Etc::sourceparts=-']
        return args
    def cache_bytes(self):
        total=0
        for directory in [self.cache,self.cache/'partial']:
            try:
                for path in directory.iterdir():
                    if path.is_file() and not path.is_symlink(): total+=path.stat().st_size
            except OSError: pass
        return total
    def stop(self,child):
        if child.poll() is not None: return
        try: os.killpg(child.pid,signal.SIGTERM)
        except (AttributeError,OSError): child.terminate()
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try: os.killpg(child.pid,signal.SIGKILL)
            except (AttributeError,OSError): child.kill()
            child.wait(timeout=5)
    def run(self,args,phase,limit,idle=None):
        self.emit(phase,force=True)
        env=os.environ.copy();env.update(DEBIAN_FRONTEND='noninteractive',LC_ALL='C')
        # Maintainer scripts need a stable writable stdout throughout apt/dpkg.
        # Use separate file descriptions so monitoring never moves the writer.
        output=tempfile.NamedTemporaryFile(prefix='aelion-apt-',suffix='.log',delete=False)
        child=None;reader=None
        try:
            inherited=()
            if 'APT::Status-Fd=1' in args:
                # APT closes its status descriptor in maintainer scripts.
                # It must never share FD 1 with their ordinary stdout.
                status_fd=os.dup(output.fileno());inherited=(status_fd,)
                args=['APT::Status-Fd='+str(status_fd) if arg=='APT::Status-Fd=1' else arg for arg in args]
            try:
                child=subprocess.Popen(args,stdout=output,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,env=env,start_new_session=True,**({'pass_fds':inherited} if inherited else {}))
            finally:
                for fd in inherited: os.close(fd)
            reader=open(output.name,'r',encoding='utf-8',errors='replace')
        except BaseException:
            if child is not None: self.stop(child)
            output.close();os.unlink(output.name);raise
        begin=last_activity=time.monotonic();last_bytes=self.cache_bytes();percent=None;package=None;ended=False
        try:
            while not ended:
                now=time.monotonic()
                if limit and now-begin>limit or idle and now-last_activity>idle:
                    self.stop(child);self.emit('retrying',error='download-timeout' if phase=='downloading' else 'command-timeout',force=True);return 124
                line=reader.readline()
                if not line:
                    if child.poll() is not None:
                        line=reader.readline()
                        if not line: ended=True;continue
                    else: time.sleep(.1)
                if line:
                    print(line.rstrip(),flush=True)
                    item=progress_line(line)
                    if item:
                        if percent is None or item[0]>percent: last_activity=now
                        percent,package=item
                    elif phase in ('updating','installing'): last_activity=now
                if idle and phase=='downloading':
                    size=self.cache_bytes()
                    if size!=last_bytes: last_activity=now;last_bytes=size
                self.emit(phase,percent,package)
            return child.wait(timeout=5)
        finally:
            self.stop(child);reader.close();output.close();os.unlink(output.name)
    def install(self,stage,packages):
        if stage not in STAGES or not packages or any(not re.fullmatch(r'[a-z0-9][a-z0-9+.:_-]{0,119}',p) for p in packages): raise ValueError('Invalid package installation request')
        self.stage=stage;(self.state/'desktop-stage').write_text(stage)
        saved={}
        try: saved=json.loads((self.state/'apt-source.json').read_text())
        except (OSError,ValueError): pass
        if not isinstance(saved,dict) or saved.get('name') not in dict(SOURCES) or not isinstance(saved.get('updatedAt'),(int,float)): saved={}
        order=sorted(SOURCES,key=lambda source:source[0]!=saved.get('name'))
        for name,origin in order:
            self.source=name;options=self.options(name,origin)
            print('Aelion package source: '+name,flush=True)
            fresh=saved.get('name')==name and 0<=time.time()-saved.get('updatedAt',0)<900
            if not fresh:
                if self.run([self.apt,*options,'-o','APT::Update::Error-Mode=any','update'],'updating',150,60)!=0: continue
                saved={'name':name,'updatedAt':time.time()};(self.state/'apt-source.json').write_text(json.dumps(saved))
            download=[self.apt,*options,'--download-only','--fix-broken','--no-remove','-y','--no-install-recommends','install',*packages]
            if self.run(download,'downloading',900,60)!=0:
                saved={};continue
            install=[self.apt,*options,'--no-download','--fix-broken','--no-remove','-y','--no-install-recommends','install',*packages]
            # Slow emulated guests can spend more than 15 minutes configuring
            # packages while making progress. Bound inactivity, not total work.
            if self.run(install,'installing',0,900)!=0:
                self.emit('failed',error='package-configure',force=True);raise RuntimeError('Package configuration failed; downloaded files were retained')
            self.emit('complete',percent=100,force=True);return
        self.emit('failed',error='sources-unavailable',force=True);raise RuntimeError('Package sources unavailable; retry to reuse already downloaded files')

if __name__=='__main__':
    try: Installer().install(sys.argv[1],sys.argv[2:])
    except Exception as error: print(str(error),file=sys.stderr);sys.exit(1)
`;

export const PACKAGE_INSTALLER_BOOTSTRAP=String.raw`python3 - <<'AELION_PACKAGE_HELPER'
import base64,pathlib,os
path=pathlib.Path('/usr/local/sbin/aelion-packages');temporary=path.with_suffix('.new');temporary.write_bytes(base64.b64decode('`+Buffer.from(PACKAGE_INSTALLER).toString('base64')+String.raw`'));temporary.chmod(0o755);temporary.replace(path)
AELION_PACKAGE_HELPER
`;

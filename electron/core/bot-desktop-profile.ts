export const BOT_DESKTOP_VERSION='4';

// One X server and D-Bus session per Bot. Reattaching never changes another desktop.
export const BOT_DESKTOP_SCRIPT=String.raw`#!/usr/bin/python3
import fcntl, json, os, pathlib, re, secrets, socket, subprocess, sys, time

ROOT=pathlib.Path('/home/aelion/.aelion-desktops')
BOOT=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def workspace(bot):
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',bot): raise RuntimeError('Invalid Bot workspace')
    path=pathlib.Path('/work')/bot
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    if path.is_symlink() or path.resolve()!=path: raise RuntimeError('Invalid workspace directory')
    return path

def write(path,value):
    temp=path.with_suffix('.new')
    temp.write_text(json.dumps(value))
    temp.chmod(0o600)
    temp.replace(path)

def alive(pid,token):
    try: return token.encode() in pathlib.Path('/proc',str(pid),'cmdline').read_bytes().split(b'\0')
    except (OSError,TypeError): return False

def load(bot):
    try:
        data=json.loads((ROOT/(bot+'.json')).read_text())
        if data['botId']==bot and data['bootId']==BOOT and alive(data['xpid'],'Aelion-'+bot): return data
    except (OSError,ValueError,KeyError): pass

def environment(bot,data):
    work=workspace(bot)
    env=os.environ.copy()
    for key in ['DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','SESSION_MANAGER','WAYLAND_DISPLAY','XDG_SESSION_ID']:
        env.pop(key,None)
    env.update(HOME=str(work),DISPLAY=':'+str(data['display']),XAUTHORITY=data['authority'],XDG_RUNTIME_DIR=data['runtime'],XDG_CONFIG_HOME=str(work/'.config'),XDG_CACHE_HOME=str(work/'.cache'),XDG_DATA_HOME=str(work/'.local/share'),XDG_CURRENT_DESKTOP='XFCE',DESKTOP_SESSION='xfce',LANG='zh_CN.UTF-8',AELION_BOT_ID=bot)
    try: env['DBUS_SESSION_BUS_ADDRESS']=json.loads((ROOT/(bot+'.env.json')).read_text())['DBUS_SESSION_BUS_ADDRESS']
    except (OSError,ValueError,KeyError): pass
    return env

def ready(env):
    result=subprocess.run(['xprop','-root','_NET_SUPPORTING_WM_CHECK'],env=env,capture_output=True,text=True,timeout=3)
    return result.returncode==0 and 'window id #' in result.stdout

def prepare_browser(work):
    # Chrome cannot create its user-data directory through a dangling XDG symlink.
    # Do this for reattached sessions too, before returning the existing desktop.
    profile=work/'.browser-profile'
    profile.mkdir(mode=0o700,exist_ok=True)
    config=work/'.config'
    config.mkdir(mode=0o700,exist_ok=True)
    chrome=config/'google-chrome'
    if not chrome.exists() and not chrome.is_symlink():
        chrome.symlink_to(profile,target_is_directory=True)

def ensure(bot):
    work=workspace(bot); ROOT.mkdir(mode=0o700,exist_ok=True)
    with (ROOT/'lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        prepare_browser(work)
        data=load(bot)
        if data:
            if not ready(environment(bot,data)): raise RuntimeError('Bot desktop session is not responding; restart the work computer after saving other tasks')
            return data
        display=None
        for number in range(30,230):
            if pathlib.Path('/tmp/.X11-unix/X'+str(number)).exists(): continue
            with socket.socket() as probe:
                try: probe.bind(('127.0.0.1',5900+number));display=number;break
                except OSError: pass
        if display is None: raise RuntimeError('No desktop display is available')
        session=work/'.desktop';session.mkdir(mode=0o700,exist_ok=True)
        runtime=pathlib.Path('/tmp')/('aelion-desktop-'+bot);runtime.mkdir(mode=0o700,exist_ok=True)
        if runtime.is_symlink() or runtime.stat().st_uid!=os.getuid(): raise RuntimeError('Invalid runtime directory')
        authority=str(session/'Xauthority')
        subprocess.run(['xauth','-f',authority,'add',':'+str(display),'.',secrets.token_hex(16)],check=True,capture_output=True)
        data={'botId':bot,'display':display,'port':5900+display,'bootId':BOOT,'authority':authority,'runtime':str(runtime)}
        env=environment(bot,data)
        for folder in ['Desktop','Downloads','Documents','.config','.cache','.local/share']:(work/folder).mkdir(parents=True,exist_ok=True)
        dirs=work/'.config/user-dirs.dirs'
        if not dirs.exists(): dirs.write_text('XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\nXDG_DOCUMENTS_DIR="$HOME/Documents"\n')
        for name,command,icon in [('Work','thunar '+str(work),'folder-documents'),('Browser','/usr/local/bin/aelion-browser --no-first-run --no-default-browser-check','web-browser'),('Writer','libreoffice --writer','libreoffice-writer'),('Calc','libreoffice --calc','libreoffice-calc')]:
            shortcut=work/'Desktop'/(name+'.desktop')
            if not shortcut.exists(): shortcut.write_text('[Desktop Entry]\nType=Application\nName='+name+'\nExec='+command+'\nIcon='+icon+'\nTerminal=false\n');shortcut.chmod(0o755)
        log=(session/'desktop.log').open('ab')
        xserver=subprocess.Popen(['Xtigervnc',':'+str(display),'-geometry','1440x900','-depth','24','-localhost','yes','-SecurityTypes','None','-rfbport',str(data['port']),'-AlwaysShared','-AcceptSetDesktopSize=0','-nolisten','tcp','-auth',authority,'-desktop','Aelion-'+bot],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        data['xpid']=xserver.pid;write(ROOT/(bot+'.json'),data)
        try:
            for _ in range(60):
                if xserver.poll() is not None: raise RuntimeError('Bot X server exited; inspect '+str(session/'desktop.log'))
                if subprocess.run(['xdpyinfo'],env=env,capture_output=True).returncode==0: break
                time.sleep(.1)
            else: raise RuntimeError('Bot X server startup timed out')
            child=subprocess.Popen(['dbus-run-session','--',sys.executable,__file__,'run',bot],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
            data['sessionPid']=child.pid;write(ROOT/(bot+'.json'),data)
            for _ in range(150):
                if child.poll() is not None: raise RuntimeError('Bot desktop exited; inspect '+str(session/'desktop.log'))
                if ready(env): return data
                time.sleep(.1)
            raise RuntimeError('Bot desktop startup timed out')
        except Exception:
            xserver.terminate()
            raise

def main():
    if len(sys.argv)<3: raise RuntimeError('Expected operation and Bot ID')
    mode,bot=sys.argv[1:3];workspace(bot)
    if mode=='run':
        write(ROOT/(bot+'.env.json'),{'DBUS_SESSION_BUS_ADDRESS':os.environ['DBUS_SESSION_BUS_ADDRESS']})
        session=subprocess.Popen(['xfce4-session'])
        # xfdesktop loads its initial background after the window manager comes up.
        subprocess.Popen(['sh','-c','sleep 3; /usr/local/bin/aelion-style'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        sys.exit(session.wait())
    data=ensure(bot)
    if mode=='ensure': print(json.dumps({'botId':bot,'display':data['display'],'port':data['port'],'bootId':BOOT}));return
    if mode!='exec' or len(sys.argv)<4: raise RuntimeError('Expected a desktop command')
    env=environment(bot,data);os.chdir(workspace(bot));os.execvpe(sys.argv[3],sys.argv[3:],env)

if __name__=='__main__':
    try: main()
    except Exception as error: print(str(error),file=sys.stderr);sys.exit(1)
`;

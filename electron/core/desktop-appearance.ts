export const DESKTOP_APPEARANCE_VERSION='2';

// Runs as the desktop owner, preserving unrelated GTK customizations.
export const DESKTOP_APPEARANCE_SCRIPT=String.raw`#!/usr/bin/python3
import os, pathlib, re, subprocess

config=pathlib.Path(os.environ.get('XDG_CONFIG_HOME',str(pathlib.Path.home()/'.config')))
css=config/'gtk-3.0/gtk.css'
css.parent.mkdir(parents=True,exist_ok=True)
before=css.read_text() if css.exists() else ''
legacy='.xfce4-panel{background-color:#1b2939;color:#eef3f8;border-radius:10px;} .xfce4-panel button{border-radius:8px;}\n'
base=re.sub(r'/\* Aelion desktop appearance \*/.*?/\* End Aelion desktop appearance \*/\n?', '', before.replace(legacy,''),flags=re.S)
block='''/* Aelion desktop appearance */
.xfce4-panel { background-color: rgba(249,248,252,0.94); color: #454352; border: 0; border-radius: 0; box-shadow: none; }
.xfce4-panel button { background-color: transparent; color: #454352; border: 0; box-shadow: none; border-radius: 7px; }
.xfce4-panel button:hover { background-color: rgba(118,103,155,0.12); }
/* End Aelion desktop appearance */
'''
after=base.rstrip()+'\n'+block
changed=after!=before
if changed:
    if css.exists() and not css.with_suffix('.before-aelion-light').exists(): css.with_suffix('.before-aelion-light').write_text(before)
    css.write_text(after)
def run(*args):
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=5)
def set_value(name,kind,value):
    result=run('xfconf-query','-c','xfce4-panel','-p',name,'-s',str(value))
    if result.returncode: run('xfconf-query','-c','xfce4-panel','-p',name,'-n','-t',kind,'-s',str(value))
properties=run('xfconf-query','-c','xfce4-panel','-l').stdout.splitlines()
panels=sorted(set(match.group(0) for name in properties if (match:=re.match(r'/panels/panel-\d+',name))))
for panel in panels:
    set_value(panel+'/autohide-behavior','int',2)
    set_value(panel+'/background-style','uint',0)
    set_value(panel+'/enter-opacity','uint',100)
    set_value(panel+'/leave-opacity','uint',0)
if changed: run('xfce4-panel','--restart')
`;

import {BOT_DESKTOP_SCRIPT,BOT_DESKTOP_VERSION} from './bot-desktop-profile';
import {PACKAGE_INSTALLER_BOOTSTRAP} from './package-installer';
export const WORKSTATION_VERSION = '4';
const preferChromium=process.platform==='darwin';

const wallpaper = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1200" viewBox="0 0 1920 1200"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#182634"/><stop offset=".55" stop-color="#172235"/><stop offset="1" stop-color="#2e3150"/></linearGradient><radialGradient id="a"><stop stop-color="#668cac" stop-opacity=".36"/><stop offset="1" stop-color="#668cac" stop-opacity="0"/></radialGradient><radialGradient id="b"><stop stop-color="#9b7fc6" stop-opacity=".25"/><stop offset="1" stop-color="#9b7fc6" stop-opacity="0"/></radialGradient></defs><rect width="1920" height="1200" fill="url(#bg)"/><ellipse cx="1450" cy="210" rx="900" ry="740" fill="url(#a)"/><ellipse cx="500" cy="1250" rx="1100" ry="800" fill="url(#b)"/><path d="M-200 1040C370 450 810 1210 2080 190" fill="none" stroke="#dde9f7" stroke-opacity=".09" stroke-width="2"/><path d="M-200 1080C410 510 850 1270 2080 240" fill="none" stroke="#dde9f7" stroke-opacity=".05" stroke-width="2"/><text x="1810" y="1090" text-anchor="end" fill="#e5edf7" fill-opacity=".65" font-family="sans-serif" font-size="30" letter-spacing="2">Aelion</text><text x="1810" y="1123" text-anchor="end" fill="#c5d1e1" fill-opacity=".45" font-family="sans-serif" font-size="14" letter-spacing="4">YOUR WORKSPACE</text></svg>`;

const homePage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Aelion 工作电脑</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f6f7f9;color:#202631;font:16px/1.7 "Noto Sans CJK SC",sans-serif}main{max-width:940px;margin:auto;padding:90px 40px}.brand{font-size:18px;font-weight:650;color:#687789;margin-bottom:66px}h1{font-size:44px;letter-spacing:-1px;margin:0 0 10px;font-weight:600}.intro{color:#76808e;margin-bottom:32px}form{display:flex;background:white;border:1px solid #e0e4eb;border-radius:17px;padding:10px 12px;gap:10px;box-shadow:0 8px 30px #20304004}input{border:0;outline:0;background:none;flex:1;padding:10px;font:inherit}button{border:0;border-radius:11px;background:#24374c;color:white;padding:10px 24px;font:inherit;cursor:pointer}.links{display:flex;gap:12px;margin:24px 0 60px;flex-wrap:wrap}a{color:#41536a;text-decoration:none;background:#e9edf2;border-radius:10px;padding:9px 18px;font-size:14px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{background:white;border:1px solid #e3e6eb;border-radius:17px;padding:23px}.card strong{display:block;margin-bottom:8px}.card p{color:#7c8591;font-size:13px;margin:0}footer{margin-top:36px;color:#939ba5;font-size:12px}</style><main><div class="brand">Aelion · 工作电脑</div><h1>开始今天的工作。</h1><p class="intro">浏览网页，整理资料，把想法变成成果。</p><form action="https://www.google.com/search"><input name="q" placeholder="搜索网页…" aria-label="搜索网页"><button>搜索</button></form><nav class="links"><a href="https://www.google.com">Google</a><a href="https://www.bing.com">Bing</a><a href="https://github.com">GitHub</a><a href="https://www.wikipedia.org">Wikipedia</a></nav><section class="cards"><div class="card"><strong>浏览器</strong><p>浏览器已安装。可以浏览网页、下载资料或打开本地预览。</p></div><div class="card"><strong>工作文件</strong><p>从桌面的“工作文件”打开文件管理器。每个 Bot 有自己的工作文件夹。</p></div><div class="card"><strong>文档与表格</strong><p>Writer、Calc、Impress、PDF 阅读器和文本编辑器已准备好。</p></div></section><footer>文件保存在这台工作电脑中。通过 AelionBot 的对话产物卡片预览和导出。</footer></main></html>`;

// Launch GUI processes in the actual logged-in desktop session, also when called over SSH.
export const SESSION_LAUNCHER = String.raw`#!/usr/bin/python3
import os, pathlib, subprocess, sys
env = os.environ.copy()
bot=env.get('AELION_BOT_ID')
if bot:
    if len(sys.argv)<2: sys.exit('An application is required')
    # Autostart applications already inherit the correct desktop and D-Bus session.
    # Re-entering ensure here waits on the lock held by the desktop's own startup.
    if env.get('AELION_DESKTOP_CONTEXT')==bot:
        os.execvpe(sys.argv[1],sys.argv[1:],env)
    os.execv('/usr/local/bin/aelion-bot-desktop',['aelion-bot-desktop','exec',bot]+sys.argv[1:])
for process in pathlib.Path('/proc').iterdir():
    if not process.name.isdigit(): continue
    try:
        if (process / 'comm').read_text().strip() != 'xfce4-session': continue
        if process.stat().st_uid != os.getuid(): continue
        raw = (process / 'environ').read_bytes().split(b'\0')
        for part in raw:
            key, separator, value = part.partition(b'=')
            if separator and key.decode() in ['DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','XDG_CURRENT_DESKTOP','DESKTOP_SESSION']:
                env[key.decode()] = value.decode()
        break
    except (OSError, UnicodeError): pass
env.setdefault('DISPLAY', ':0')
env.setdefault('XAUTHORITY', '/home/aelion/.Xauthority')
env.setdefault('XDG_RUNTIME_DIR', '/run/user/1000')
env.setdefault('XDG_CURRENT_DESKTOP', 'XFCE')
env['LANG'] = 'zh_CN.UTF-8'
if len(sys.argv) < 2: sys.exit('An application is required')
os.execvpe(sys.argv[1], sys.argv[1:], env)
`;

const styleScript = String.raw`#!/usr/bin/python3
import pathlib, subprocess
def run(*args):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def set_value(channel, name, kind, value):
    result = run('xfconf-query','-c',channel,'-p',name,'-s',str(value))
    if result.returncode: run('xfconf-query','-c',channel,'-p',name,'-n','-t',kind,'-s',str(value))
set_value('xsettings','/Net/ThemeName','string','Arc-Darker')
set_value('xsettings','/Net/IconThemeName','string','Adwaita')
set_value('xsettings','/Gtk/FontName','string','Noto Sans CJK SC 10')
set_value('xsettings','/Gtk/MonospaceFontName','string','DejaVu Sans Mono 10')
set_value('xfwm4','/general/theme','string','Arc-Darker')
set_value('xfwm4','/general/title_font','string','Noto Sans CJK SC Bold 10')
set_value('xfwm4','/general/use_compositing','bool','true')
set_value('xfce4-desktop','/desktop-icons/style','int',2)
set_value('xfce4-desktop','/desktop-icons/file-icons/show-filesystem','bool','false')
set_value('xfce4-desktop','/desktop-icons/file-icons/show-home','bool','false')
set_value('xfce4-desktop','/desktop-icons/file-icons/show-trash','bool','false')
set_value('xfce4-desktop','/desktop-icons/icon-size','uint',48)
properties = run('xfconf-query','-c','xfce4-desktop','-l').stdout.splitlines()
backgrounds = [p for p in properties if p.endswith('/last-image')]
if not backgrounds: backgrounds=['/backdrop/screen0/monitorVirtual-1/workspace0/last-image']
for name in backgrounds:
    set_value('xfce4-desktop',name,'string','/usr/local/share/aelion/wallpaper.png')
    set_value('xfce4-desktop',name.rsplit('/',1)[0]+'/image-style','int',5)
for panel in [1,2]:
    set_value('xfce4-panel',f'/panels/panel-{panel}/size','uint',40 if panel==1 else 52)
    set_value('xfce4-panel',f'/panels/panel-{panel}/icon-size','uint',24 if panel==1 else 32)
run('xdg-mime','default','thunar.desktop','inode/directory')
editors=[path for path in pathlib.Path('/usr/share/applications').glob('*mousepad*.desktop') if 'settings' not in path.name]
if editors:
    for mime in ['text/plain','text/markdown','application/json','text/x-python']:
        run('xdg-mime','default',editors[0].name,mime)
run('xdg-settings','set','default-web-browser','aelion-browser.desktop')
run('xset','s','off'); run('xset','-dpms'); run('xset','s','noblank')
run('xfdesktop','--reload')
if '--arrange' in run('xfdesktop','--help').stdout: run('xfdesktop','--arrange')
`;

const launcher=(name:string,exec:string,icon:string)=>`[Desktop Entry]\nVersion=1.0\nType=Application\nName=${name}\nExec=${exec}\nIcon=${icon}\nTerminal=false\nStartupNotify=true\n`;
const files:Record<string,string>={
  '/usr/local/bin/aelion-session':SESSION_LAUNCHER,
  '/usr/local/bin/aelion-bot-desktop':BOT_DESKTOP_SCRIPT,
  '/var/lib/aelion/bot-desktop-version':BOT_DESKTOP_VERSION,
  '/usr/local/bin/aelion-style':styleScript,
  '/usr/local/share/aelion/wallpaper.svg':wallpaper,
  '/usr/local/share/aelion/start.html':homePage,
  '/home/aelion/.config/xfce4/helpers.rc':'WebBrowser=custom\nWebBrowserCustom=/usr/local/bin/aelion-browser\nFileManager=Thunar\nTerminalEmulator=xfce4-terminal\n',
  '/home/aelion/.config/gtk-3.0/gtk.css':'.xfce4-panel{background-color:#1b2939;color:#eef3f8;border-radius:10px;} .xfce4-panel button{border-radius:8px;}\n',
  '/home/aelion/Desktop/Chrome.desktop':launcher('浏览器','/usr/local/bin/aelion-session /usr/local/bin/aelion-browser --no-first-run --no-default-browser-check file:///usr/local/share/aelion/start.html','web-browser'),
  '/usr/share/applications/aelion-browser.desktop':launcher('浏览器','/usr/local/bin/aelion-browser %U','web-browser'),
  '/usr/local/bin/aelion-browser':preferChromium?'#!/bin/sh\nexec chromium "$@"\n':'#!/bin/sh\nif command -v google-chrome-stable >/dev/null 2>&1; then exec google-chrome-stable "$@"; fi\nexec chromium "$@"\n',
  '/home/aelion/Desktop/Work.desktop':launcher('工作文件','/usr/local/bin/aelion-session thunar /work','folder-documents'),
  '/home/aelion/Desktop/Writer.desktop':launcher('文档','/usr/local/bin/aelion-session libreoffice --writer','libreoffice-writer'),
  '/home/aelion/Desktop/Calc.desktop':launcher('表格','/usr/local/bin/aelion-session libreoffice --calc','libreoffice-calc'),
  '/etc/xdg/autostart/aelion-style.desktop':launcher('Aelion desktop','/usr/local/bin/aelion-session /usr/local/bin/aelion-style','preferences-desktop-theme')
};
const assets=Buffer.from(JSON.stringify(files)).toString('base64');

export const DESKTOP_SCRIPT = String.raw`#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
mkdir -p /var/lib/aelion
exec 9>/var/lib/aelion/desktop.lock
flock -n 9 || exit 0
rm -f /var/lib/aelion/desktop-error
trap 'echo "Desktop preparation failed at $(date -Iseconds), stage $(cat /var/lib/aelion/desktop-stage 2>/dev/null)" > /var/lib/aelion/desktop-error' EXIT
printf system > /var/lib/aelion/desktop-stage
timeout 600 dpkg --configure -a || echo 'Pending package dependencies will be repaired by APT'
`+PACKAGE_INSTALLER_BOOTSTRAP+String.raw`
printf desktop > /var/lib/aelion/desktop-stage
arch=$(dpkg --print-architecture)
case "$arch" in amd64|arm64) ;; *) echo "Unsupported guest architecture: $arch" >&2; exit 1 ;; esac
/usr/local/sbin/aelion-packages desktop "linux-image-$arch" git python3-venv ca-certificates curl locales xserver-xorg-core xserver-xorg-video-all xserver-xorg-input-libinput x11-xserver-utils xinit xfce4-session xfce4-settings xfwm4 xfdesktop4 xfce4-panel xfce4-appfinder xfce4-terminal dbus-x11 dbus-user-session lightdm lightdm-gtk-greeter thunar thunar-archive-plugin gvfs gvfs-backends xdg-utils mousepad ristretto evince xclip xdotool arc-theme adwaita-icon-theme fonts-noto-core fonts-noto-cjk librsvg2-bin librsvg2-common tigervnc-standalone-server python3-pil xauth x11-utils
/usr/local/sbin/aelion-packages office libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 libreoffice-l10n-zh-cn
if [ "$arch" = arm64 ] || [ '`+(preferChromium?'1':'0')+String.raw`' = 1 ] || ! command -v google-chrome-stable >/dev/null 2>&1; then
  printf browser > /var/lib/aelion/desktop-stage
  /usr/local/sbin/aelion-packages browser chromium
fi
printf finishing > /var/lib/aelion/desktop-stage
sed -i 's/^# *zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen
locale-gen zh_CN.UTF-8
mkdir -p /etc/lightdm/lightdm.conf.d
printf '[Seat:*]\nautologin-user=aelion\nautologin-user-timeout=0\nuser-session=xfce\n' > /etc/lightdm/lightdm.conf.d/50-aelion.conf
python3 - <<'PY'
import base64,json,pathlib,os
files=json.loads(base64.b64decode('`+assets+String.raw`'))
for name, content in files.items():
    path=pathlib.Path(name); path.parent.mkdir(parents=True,exist_ok=True)
    backup=pathlib.Path('/var/lib/aelion/profile-backups') / name.lstrip('/')
    backup.parent.mkdir(parents=True,exist_ok=True)
    legacy=path.with_suffix(path.suffix+'.before-aelion')
    if legacy.is_file() and not legacy.is_symlink() and not backup.exists(): legacy.rename(backup)
    elif path.exists() and not backup.exists(): backup.write_bytes(path.read_bytes())
    path.write_text(content,encoding='utf-8')
    if name.startswith('/usr/local/bin/') or name.endswith('.desktop'): path.chmod(0o755)
    if name.startswith('/home/aelion/'):
        os.chown(path,1000,1000)
        parent=path.parent
        while parent != pathlib.Path('/home/aelion'):
            os.chown(parent,1000,1000); parent=parent.parent
PY
rsvg-convert -o /usr/local/share/aelion/wallpaper.png /usr/local/share/aelion/wallpaper.svg
systemctl enable lightdm
kernel=$(find /boot -maxdepth 1 -name "vmlinuz-*-$arch" ! -name '*cloud*' | sort -V | tail -n 1 | sed 's|.*/vmlinuz-||')
test -n "$kernel"
uuid=$(grub-probe --target=fs_uuid /)
grep -q "gnulinux-$kernel-advanced-$uuid" /boot/grub/grub.cfg
mkdir -p /etc/default/grub.d
printf 'GRUB_DEFAULT="gnulinux-advanced-%s>gnulinux-%s-advanced-%s"\n' "$uuid" "$kernel" "$uuid" > /etc/default/grub.d/90-aelion.cfg
update-grub
if [ "$(uname -r)" != "$kernel" ]; then
  touch /var/lib/aelion/desktop-needs-reboot
  trap - EXIT
  exit 0
fi
rm -f /var/lib/aelion/desktop-needs-reboot
if ! systemctl is-active --quiet lightdm; then systemctl reset-failed lightdm || true; systemctl start lightdm; sleep 3; fi
systemctl is-active --quiet lightdm
pgrep -u aelion -x xfce4-session >/dev/null
runuser -u aelion -- /usr/local/bin/aelion-session /usr/local/bin/aelion-style
command -v aelion-browser thunar libreoffice xclip xdotool
if [ "$arch" = arm64 ] || [ '`+(preferChromium?'1':'0')+String.raw`' = 1 ]; then command -v chromium; else command -v google-chrome-stable || command -v chromium; fi
touch /var/lib/aelion/desktop-ready
printf '`+WORKSTATION_VERSION+String.raw`' > /var/lib/aelion/workstation-version
trap - EXIT
`;

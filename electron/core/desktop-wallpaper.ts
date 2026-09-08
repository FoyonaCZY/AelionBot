import {DESKTOP_APPEARANCE_SCRIPT,DESKTOP_APPEARANCE_VERSION} from './desktop-appearance';

// Update the wallpaper and managed panel appearance, preserving desktop files.
// PNG bytes travel over SSH stdin, never through a shell argument.
export const WALLPAPER_INSTALL_SCRIPT = String.raw`
import base64, hashlib, os, pathlib, pwd, subprocess, sys, tempfile

image = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
expected = sys.argv[1]
if len(image) > 8 * 1024 * 1024 or not image.startswith(b'\x89PNG\r\n\x1a\n') or hashlib.sha256(image).hexdigest() != expected:
    sys.exit('Invalid wallpaper image')
folder = pathlib.Path('/usr/local/share/aelion')
folder.mkdir(parents=True, exist_ok=True)
target = folder / 'wallpaper.png'
backup = folder / 'wallpaper.before-light.png'
if target.is_file() and not backup.exists():
    backup.write_bytes(target.read_bytes())
fd, temporary = tempfile.mkstemp(prefix='.wallpaper-', dir=folder)
try:
    with os.fdopen(fd, 'wb') as output:
        output.write(image)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(temporary, 0o644)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary): os.unlink(temporary)

appearance=pathlib.Path('/usr/local/bin/aelion-appearance')
appearance.write_bytes(base64.b64decode('`+Buffer.from(DESKTOP_APPEARANCE_SCRIPT).toString('base64')+String.raw`'))
appearance.chmod(0o755)
style=pathlib.Path('/usr/local/bin/aelion-style')
if style.is_file() and '/usr/local/bin/aelion-appearance' not in style.read_text():
    with style.open('a') as output: output.write("\nrun('/usr/local/bin/aelion-appearance')\n")

# Run xfconf in each live desktop's own D-Bus session as its owner.
account = pwd.getpwnam('aelion')
sessions = set()
for process in pathlib.Path('/proc').iterdir():
    if not process.name.isdigit(): continue
    try:
        if process.stat().st_uid != account.pw_uid or (process / 'comm').read_text().strip() != 'xfce4-session': continue
        values = dict(part.split(b'=', 1) for part in (process / 'environ').read_bytes().split(b'\0') if b'=' in part)
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'USER': 'aelion', 'LOGNAME': 'aelion', 'HOME': account.pw_dir}
        for key in ['HOME', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME']:
            if key.encode() in values: env[key] = values[key.encode()].decode()
        identity = (env.get('DISPLAY'), env.get('DBUS_SESSION_BUS_ADDRESS'))
        if not all(identity) or identity in sessions: continue
        sessions.add(identity)
        def run(*args):
            return subprocess.run(args, env=env, user=account.pw_uid, group=account.pw_gid, extra_groups=[], cwd=account.pw_dir, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5)
        properties = run('/usr/bin/xfconf-query', '-c', 'xfce4-desktop', '-l').stdout.splitlines()
        backgrounds = [name for name in properties if name.endswith('/last-image')]
        for name in backgrounds:
            run('/usr/bin/xfconf-query', '-c', 'xfce4-desktop', '-p', name, '-s', str(target))
            style = name.rsplit('/', 1)[0] + '/image-style'
            result = run('/usr/bin/xfconf-query', '-c', 'xfce4-desktop', '-p', style, '-s', '5')
            if result.returncode: run('/usr/bin/xfconf-query', '-c', 'xfce4-desktop', '-p', style, '-n', '-t', 'int', '-s', '5')
        run('/usr/bin/xfdesktop', '--reload')
        result=run('/usr/local/bin/aelion-appearance')
        if result.returncode: sys.exit('Desktop appearance update failed')
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        continue
pathlib.Path('/var/lib/aelion/desktop-appearance-version').write_text('`+DESKTOP_APPEARANCE_VERSION+String.raw`')
print('Wallpaper and appearance installed')
`;

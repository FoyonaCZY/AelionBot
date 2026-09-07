"""Run only in a disposable Debian container; installs a small signed package."""
import json
import pathlib
import subprocess
import tempfile

repo=pathlib.Path(__file__).resolve().parent.parent
source=(repo/'electron/core/package-installer.ts').read_text().split('export const PACKAGE_INSTALLER=String.raw`',1)[1].split('\n`;',1)[0]
namespace={'__name__':'fixture'}
exec(compile(source,'aelion-packages','exec'),namespace)
assert pathlib.Path('/etc/os-release').read_text().find('bookworm')>=0

# Leave an unreachable optional source alongside the original sources. The
# helper must detect the partial update failure and use a command-local source.
bad=pathlib.Path('/etc/apt/sources.list.d/aelion-smoke.list')
bad.write_text('deb http://127.0.0.1:9/debian bookworm main\n')
proxy=pathlib.Path('/etc/apt/apt.conf.d/99-aelion-smoke-proxy')
proxy.write_text('Acquire::http::Proxy "DIRECT";\nAcquire::https::Proxy "DIRECT";\n')
before={str(path):path.read_bytes() for path in pathlib.Path('/etc/apt').rglob('*') if path.is_file()}
namespace['SOURCES']=[('current',None),('debian','https://deb.debian.org')]
with tempfile.TemporaryDirectory(prefix='aelion-apt-smoke-') as root:
    installer=namespace['Installer'](root,codename='bookworm')
    installer.install('office',['hello'])
    assert json.loads((pathlib.Path(root)/'apt-source.json').read_text())['name']=='debian'
    assert json.loads((pathlib.Path(root)/'desktop-progress.json').read_text())['phase']=='complete'
    subprocess.run(['hello','--version'],check=True)
    assert all(pathlib.Path(path).read_bytes()==body for path,body in before.items()),'System APT configuration changed'
print(json.dumps({'signedPackageInstalled':True,'unreachableSourceRecovered':True,'aptAndProxyConfigurationUnchanged':True,'passed':True}))

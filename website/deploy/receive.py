#!/usr/bin/python3 -I
"""Restricted SSH receiver for the AelionBot static website."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import uuid

SITE = Path('/var/www/aelion.chat')
REPOSITORY = 'FoyonaCZY/AelionBot'
EXTENSIONS = {'.html', '.css', '.js', '.json', '.xml', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.mp4', '.webm'}
REQUIRED = {'index.html', 'blog/index.html', '404.html', 'robots.txt', 'sitemap.xml'}
MAX_ARCHIVE = 50 * 1024 * 1024
MAX_CONTENT = 250 * 1024 * 1024


def safe_path(name):
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or '\\' in name or ':' in name
            or any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in name)
            or any(part.startswith('.') for part in path.parts)
            or not path.parts or len(name) > 1024):
        raise ValueError('Unsafe archive path')
    value = path.as_posix()
    if value == 'blog/_preview' or value.startswith('blog/_preview/'):
        raise ValueError('Draft preview in archive')
    return value


def validate_manifest(manifest, expected):
    if manifest.get('schemaVersion') != 1 or manifest.get('repository') != REPOSITORY:
        raise ValueError('Invalid website manifest')
    if not re.fullmatch(r'[a-f0-9]{40}', str(manifest.get('revision', ''))):
        raise ValueError('Invalid revision')
    for key in ('runId', 'runNumber', 'runAttempt'):
        value = manifest.get(key)
        if type(value) is not int or not 0 < value < 2**53:
            raise ValueError('Invalid workflow identity')
    if (manifest['revision'], manifest['runNumber'], manifest['runAttempt']) != expected:
        raise ValueError('Archive does not match requested deployment')
    files = manifest.get('files')
    if not isinstance(files, dict) or not REQUIRED.issubset(files) or len(files) > 10000:
        raise ValueError('Missing website files')
    for name, digest in files.items():
        if safe_path(name) != name or Path(name).suffix.lower() not in EXTENSIONS or not re.fullmatch(r'[a-f0-9]{64}', str(digest)):
            raise ValueError('Invalid file manifest')
    if 'deployment.json' in files or not any(name.startswith('assets/') and name.endswith('.js') for name in files):
        raise ValueError('Invalid public assets')


def unpack(archive, stage, expected):
    entries = {}; total = 0
    with tarfile.open(archive, 'r:gz') as bundle:
        for member in bundle:
            if member.isdir() and member.name in ('.', './'):
                continue
            name = safe_path(member.name)
            if name in entries or len(entries) >= 10000 or not (member.isfile() or member.isdir()) or member.issparse():
                raise ValueError('Unsupported or duplicate archive entry')
            if member.isfile() and Path(name).suffix.lower() not in EXTENSIONS:
                raise ValueError('Unexpected website file')
            if member.size < 0:
                raise ValueError('Invalid file size')
            total += member.size
            if total > MAX_CONTENT:
                raise ValueError('Website exceeds size limit')
            entries[name] = member
        if 'deployment.json' not in entries or entries['deployment.json'].size > 1024 * 1024 or not entries['deployment.json'].isfile():
            raise ValueError('Missing deployment manifest')
        manifest = json.load(bundle.extractfile(entries['deployment.json']))
        validate_manifest(manifest, expected)
        regular = {name for name, member in entries.items() if member.isfile()}
        if regular != set(manifest['files']) | {'deployment.json'}:
            raise ValueError('Archive contains missing or unlisted files')
        for name, member in entries.items():
            target = stage / name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            digest = hashlib.sha256()
            with bundle.extractfile(member) as source, target.open('xb') as destination:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk); destination.write(chunk)
            target.chmod(0o644)
            if name != 'deployment.json' and digest.hexdigest() != manifest['files'][name]:
                raise ValueError('Website checksum mismatch: ' + name)
    stage.chmod(0o755)
    return manifest


def swap(root, destination):
    pending = root / ('.current-' + uuid.uuid4().hex)
    try:
        pending.symlink_to(destination)
        os.replace(pending, root / 'current')
    finally:
        pending.unlink(missing_ok=True)


def previous_release(root):
    link = root / 'current'
    if not link.is_symlink():
        raise ValueError('Current website must be a release symlink')
    previous = link.resolve(strict=True)
    if previous.parent != root / 'releases' or not (previous / 'index.html').is_file():
        raise ValueError('Current release is outside this website')
    return previous


def retain_assets(previous, stage):
    manifest = previous / 'deployment.json'
    if manifest.is_file():
        names = json.loads(manifest.read_text())['files']
        names = [name for name in names if name.startswith(('assets/', 'blog-media/'))]
    else:
        names = [path.relative_to(previous).as_posix() for folder in ('assets', 'blog-media')
                 if not (previous / folder).is_symlink()
                 for path in (previous / folder).rglob('*') if path.is_file() and not path.is_symlink()]
    for name in names:
        safe_path(name)
        source = previous / name; target = stage / name
        if source.is_symlink() or not source.is_file() or target.exists():
            continue
        if not source.resolve().is_relative_to(previous):
            raise ValueError('Previous asset is outside the website')
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        shutil.copyfile(source, target); target.chmod(0o644)


def local_health(manifest):
    for path in ('deployment.json', 'index.html', 'blog/index.html'):
        result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--noproxy', '*', '--max-time', '15',
                                 '--resolve', 'aelion.chat:443:127.0.0.1', 'https://aelion.chat/' + path],
                                check=True, capture_output=True)
        if path == 'deployment.json':
            if json.loads(result.stdout) != manifest:
                raise ValueError('Nginx is serving a different deployment')
        elif hashlib.sha256(result.stdout).hexdigest() != manifest['files'][path]:
            raise ValueError('Public page failed its health check')


def publish(root, archive, expected, health=local_health):
    root = Path(root)
    if root.resolve() != root or (root / 'releases').resolve() != root / 'releases':
        raise ValueError('Website directories must not be symlinks')
    previous = previous_release(root)
    incoming = root / '.incoming'
    if incoming.is_symlink():
        raise ValueError('Invalid staging directory')
    incoming.mkdir(mode=0o700, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='stage-', dir=incoming))
    destination = None; activated = False; created = False
    try:
        manifest = unpack(archive, stage, expected)
        old_path = previous / 'deployment.json'
        old = json.loads(old_path.read_text()) if old_path.is_file() else {}
        current_order = (old.get('runNumber', 0), old.get('runAttempt', 0))
        order = (manifest['runNumber'], manifest['runAttempt'])
        if order < current_order:
            raise ValueError('Refusing an older workflow deployment')
        if order == current_order:
            if old != manifest:
                raise ValueError('Workflow identity was reused with different content')
            health(manifest)
            return {'status': 'already-current', 'revision': manifest['revision']}
        retain_assets(previous, stage)
        name = f"ci-{order[0]}-{order[1]}-{manifest['revision'][:12]}"
        destination = root / 'releases' / name
        if destination.exists() or destination.is_symlink():
            raise ValueError('Release already exists; rerun the workflow')
        os.rename(stage, destination)
        created = True
        try:
            swap(root, destination); activated = True
            health(manifest)
        except Exception:
            if previous_release(root) == destination:
                swap(root, previous)
            activated = False
            raise
        # Keep the newest releases plus the active and previous versions.
        candidates = [path for path in (root / 'releases').iterdir()
                      if path.is_dir() and not path.is_symlink() and re.fullmatch(r'ci-\d+-\d+-[a-f0-9]{12}', path.name)]
        candidates.sort(key=lambda path: tuple(map(int, path.name.split('-')[1:3])), reverse=True)
        for path in candidates[5:]:
            if path not in (destination, previous) and path.resolve().parent == root / 'releases':
                try:
                    shutil.rmtree(path)
                except OSError:
                    print('Could not prune an old website release', file=sys.stderr)
        return {'status': 'deployed', 'revision': manifest['revision'], 'release': name}
    finally:
        if stage.exists() and stage.resolve().parent == incoming:
            shutil.rmtree(stage)
        if created and destination and not activated and destination.exists() and destination.resolve().parent == root / 'releases' and previous_release(root) != destination:
            shutil.rmtree(destination)


def main():
    os.umask(0o022)
    command = re.fullmatch(r'deploy ([a-f0-9]{40}) ([1-9][0-9]{0,14}) ([1-9][0-9]{0,6})', os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    if not command:
        raise ValueError('Only website deployments are allowed')
    expected = (command[1], int(command[2]), int(command[3]))
    def timeout(*_):
        raise TimeoutError('Deployment exceeded its time limit')
    signal.signal(signal.SIGALRM, timeout); signal.alarm(180)
    with (SITE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.NamedTemporaryFile(prefix='archive-', suffix='.tar.gz', dir=SITE / '.incoming') as archive:
            total = 0
            while chunk := sys.stdin.buffer.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_ARCHIVE:
                    raise ValueError('Archive exceeds size limit')
                archive.write(chunk)
            archive.flush()
            print(json.dumps(publish(SITE, archive.name, expected)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Website deployment failed: ' + str(error), file=sys.stderr)
        sys.exit(1)

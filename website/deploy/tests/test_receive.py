import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('receive', Path(__file__).resolve().parents[1] / 'receive.py')
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


class WebsiteDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aelion-website-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'site'
        self.old = self.root / 'releases' / 'previous'
        (self.old / 'assets').mkdir(parents=True)
        (self.old / 'index.html').write_text('previous website')
        (self.old / 'assets' / 'old.js').write_text('previous asset')
        (self.root / 'current').symlink_to(self.old)

    def archive(self, run=2, revision='a' * 40, extra=None, corrupt=False):
        files = {name: ('new ' + name).encode() for name in receiver.REQUIRED}
        files['assets/app.js'] = b'console.log("website")'
        manifest = {'schemaVersion': 1, 'repository': receiver.REPOSITORY, 'revision': revision,
                    'runId': 100 + run, 'runNumber': run, 'runAttempt': 1,
                    'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        if corrupt:
            files['index.html'] = b'changed after hashing'
        files['deployment.json'] = json.dumps(manifest).encode()
        path = Path(self.temp.name) / f'archive-{run}.tar.gz'
        with tarfile.open(path, 'w:gz') as bundle:
            for name, data in files.items():
                entry = tarfile.TarInfo('./' + name); entry.size = len(data)
                bundle.addfile(entry, io.BytesIO(data))
            if extra:
                bundle.addfile(*extra)
        return path, (revision, run, 1)

    def publish(self, **kwargs):
        archive, identity = self.archive(**kwargs)
        return receiver.publish(self.root, archive, identity, lambda _: None)

    def test_publish_is_atomic_and_retains_previous_assets(self):
        result = self.publish()
        current = (self.root / 'current').resolve()
        self.assertEqual(result['status'], 'deployed')
        self.assertEqual((current / 'index.html').read_text(), 'new index.html')
        self.assertEqual((current / 'assets/old.js').read_text(), 'previous asset')
        self.assertEqual((self.old / 'index.html').read_text(), 'previous website')
        self.assertEqual(list((self.root / '.incoming').iterdir()), [])

    def test_health_failure_restores_previous_website(self):
        archive, identity = self.archive()
        def failed(_):
            raise RuntimeError('health check failed')
        with self.assertRaisesRegex(RuntimeError, 'health check'):
            receiver.publish(self.root, archive, identity, failed)
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(list((self.root / 'releases').iterdir()), [self.old])

    def test_existing_release_is_not_deleted_on_conflict(self):
        existing = self.root / 'releases' / ('ci-2-1-' + 'a' * 12)
        existing.mkdir(); (existing / 'keep.txt').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.publish()
        self.assertEqual((existing / 'keep.txt').read_text(), 'keep')
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_traversal_and_links_never_reach_the_public_directory(self):
        for name, kind in [('../outside.txt', tarfile.REGTYPE), ('assets/link.js', tarfile.SYMTYPE), ('assets/hard.js', tarfile.LNKTYPE)]:
            with self.subTest(name=name):
                entry = tarfile.TarInfo(name); entry.type = kind; entry.linkname = '/etc/passwd'
                with self.assertRaises(ValueError):
                    self.publish(extra=(entry, io.BytesIO(b'')))
                self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertFalse((self.root / 'outside.txt').exists())

    def test_unlisted_files_and_changed_content_are_rejected(self):
        entry = tarfile.TarInfo('extra.txt'); entry.size = 3
        with self.assertRaisesRegex(ValueError, 'unlisted'):
            self.publish(extra=(entry, io.BytesIO(b'bad')))
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.publish(corrupt=True)
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_retries_are_idempotent_and_old_workflows_cannot_replace_newer_ones(self):
        self.publish(); current = (self.root / 'current').resolve()
        self.assertEqual(self.publish()['status'], 'already-current')
        with self.assertRaisesRegex(ValueError, 'older workflow'):
            self.publish(run=1)
        self.assertEqual((self.root / 'current').resolve(), current)

    def test_identity_mismatch_and_private_paths_are_rejected(self):
        archive, identity = self.archive()
        with self.assertRaisesRegex(ValueError, 'does not match'):
            receiver.publish(self.root, archive, ('b' * 40, identity[1], identity[2]), lambda _: None)
        for name in ('.env', '/absolute.html', 'assets/../escape.js', 'blog/_preview/draft/index.html', 'C:\\private.txt'):
            with self.assertRaises(ValueError):
                receiver.safe_path(name)


if __name__ == '__main__':
    unittest.main()

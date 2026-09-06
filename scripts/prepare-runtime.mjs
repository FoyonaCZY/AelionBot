import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {runtimeArchiver} from './runtime-archiver.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const downloads = join(root, 'runtime', 'downloads');
const qemu = join(root, 'runtime', 'qemu');
mkdirSync(downloads, { recursive: true });
mkdirSync(qemu, { recursive: true });

async function digest(file, algorithm = 'sha512') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, dest, expected) {
  if (existsSync(dest) && expected && await digest(dest) === expected) {
    console.log(`Verified cached ${dest}`); return;
  }
  const partial = `${dest}.part`;
  const start = existsSync(partial) ? statSync(partial).size : 0;
  const response = await fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {} });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  const resumed = response.status === 206;
  let count = resumed ? start : 0;
  const total = Number(response.headers.get('content-length') || 0) + count;
  let last = 0;
  const input = Readable.fromWeb(response.body);
  input.on('data', chunk => {
    count += chunk.length;
    if (Date.now() - last > 5000) { console.log(`${url.split('/').pop()}: ${Math.round(count/1048576)} / ${Math.round(total/1048576)} MiB`); last = Date.now(); }
  });
  await pipeline(input, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }));
  const actual = await digest(partial);
  if (expected && actual !== expected) throw new Error(`Checksum mismatch for ${url}; partial retained for diagnosis`);
  const { renameSync } = await import('node:fs');
  renameSync(partial, dest);
  console.log(`Verified ${dest}: ${actual}`);
}

const qemuInstaller = join(downloads, 'qemu-w64-setup-20260811.exe');
const qemuHash = '5bcf9eed634e8575a37b74f445af41a2fe4106da512d0c30c368301d4c105037fdfab40a5287367a28a957624cddebbc8c07e16c88ab6634f554cdf3d16bf543';
if (!existsSync(join(qemu, 'qemu-system-x86_64.exe'))) {
  await download('https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe', qemuInstaller, qemuHash);
  const archiver=await runtimeArchiver(downloads),seven=archiver.path;
  const args = archiver.bandizip ? ['x', '-y', '-aoa', `-o:${qemu}`, qemuInstaller] : ['x', qemuInstaller, `-o${qemu}`, '-y'];
  await new Promise((ok, fail) => {
    const child = spawn(seven, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', fail); child.on('exit', code => code === 0 ? ok() : fail(new Error(`7zip exit ${code}`)));
  });
}
if (!existsSync(join(qemu, 'qemu-system-x86_64.exe'))) throw new Error('QEMU executable missing after extraction');
writeFileSync(join(qemu, 'aelion-runtime.json'), JSON.stringify({ version: '11.1.0', source: 'https://qemu.weilnetz.de/w64/', installerSha512: qemuHash }, null, 2));
console.log('QEMU runtime ready. Guest image is provisioned by the application.');

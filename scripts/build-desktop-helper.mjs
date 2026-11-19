// Builds the macOS helper of host Computer Use from its Swift source and checks that it answers. On other systems
// there is nothing to build: Windows compiles its helper at run time with the PowerShell it already has.
//   node scripts/build-desktop-helper.mjs [--force] [--check <binary>]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..'),
  source = join(root, 'electron', 'core', 'host', 'desktop', 'desktop-helper-mac.swift'),
  output = join(root, 'runtime', 'desktop-helper', 'aelion-desktop-helper');

const modified = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
/** Compiles the helper unless the binary is newer than its source. Returns the binary, or nothing off macOS. */
export function buildDesktopHelper({ force = false } = {}) {
  if (process.platform !== 'darwin') return undefined;
  if (!force && modified(output) > modified(source)) return output;
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-swift-version',
      '5',
      '-target',
      `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos15.0`,
      '-o',
      output,
      source,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  return output;
}
/**
 * Starts the helper and asks what needs no permission: that it is alive, and which apps are installed. Listing windows
 * needs the accessibility grant, which a build machine does not have; either answer shows the request was understood.
 */
export async function checkDesktopHelper(binary) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buffer = '',
    ready = false;
  child.stdout.on('data', (data) => {
    buffer += data;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.ready) ready = true;
      else replies.set(message.id, message);
    }
  });
  const exited = new Promise((done) => child.on('close', done));
  for (const [id, op] of ['ping', 'list_apps', 'list_windows'].entries())
    child.stdin.write(JSON.stringify({ id: id + 1, op }) + '\n');
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 30000);
  await exited;
  clearTimeout(timer);
  const [ping, apps, windows] = [1, 2, 3].map((id) => replies.get(id));
  if (!ready || !ping?.ok || typeof ping.result.accessibility !== 'boolean' || ping.result.display?.length !== 4)
    throw Error('The desktop helper did not answer ping: ' + JSON.stringify(ping));
  if (!apps?.ok || !apps.result.some((app) => app.name && app.id.endsWith('.app')))
    throw Error('The desktop helper listed no installed apps: ' + JSON.stringify(apps)?.slice(0, 400));
  if (!(windows?.ok ? Array.isArray(windows.result) : windows?.code === 'accessibility_permission'))
    throw Error('The desktop helper could not list windows: ' + JSON.stringify(windows)?.slice(0, 400));
  return {
    apps: apps.result.length,
    accessibility: ping.result.accessibility,
    screenRecording: ping.result.screenRecording,
    windows: windows.ok ? windows.result.length : windows.code,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'darwin') console.log('The desktop helper is built on macOS only; nothing to do.');
  else {
    const at = process.argv.indexOf('--check'),
      binary =
        at >= 0 ? resolve(process.argv[at + 1]) : buildDesktopHelper({ force: process.argv.includes('--force') });
    console.log(JSON.stringify({ desktopHelper: binary, ...(await checkDesktopHelper(binary)) }));
  }
}

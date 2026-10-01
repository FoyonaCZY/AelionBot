import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers';
import { assessPowerShell, classifyHostCommand } from '../electron/core/host/command-policy';
import { PowerShellParser } from '../electron/core/host/powershell-parser';
import type { HostRiskContext } from '../electron/core/host/permission-risk';
import type { HostPermissionDetails } from '../shared/types/core';

const posix: HostRiskContext = {
  workspaceDir: '/home/u/proj',
  dataDir: '/home/u/.config/aelion-bot',
  homeDir: '/home/u',
  platform: 'linux',
  env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
};
const run = (command: string, context: HostRiskContext = posix, cwd = context.workspaceDir): HostPermissionDetails => ({
  operation: 'command',
  command,
  cwd,
  reason: 'test',
});
const low = (command: string, context: HostRiskContext = posix) =>
  classifyHostCommand(run(command, context), context).lowRisk;

test('POSIX read-only commands and pipelines of them are local decisions', () => {
  for (const command of [
    'ls',
    'ls -la src',
    'cat README.md',
    'cat src/app.ts | head -n 40',
    'head -20 package.json',
    'tail -n 5 CHANGELOG.md',
    'wc -l src/a.ts src/b.ts',
    'ls src | grep test | sort | uniq -c',
    'grep -n TODO src/app.ts',
    'grep -e "two words" README.md',
    'find src -name "*.ts" -type f',
    'find . -maxdepth 2 -type d',
    'node --version && npm -v',
    'python3 --version; pwd',
    'echo done',
    'which node rg',
    'command -v git',
    'stat -c %s README.md',
    'cut -d: -f1 data.txt',
  ])
    assert.equal(low(command), true, command);
});

test('POSIX commands that write, execute, expand, recurse or leave the project still need review', () => {
  for (const command of [
    'cat .env',
    'cat ~/.ssh/id_rsa',
    'cat ../secrets.txt',
    'cat /etc/passwd',
    'cat *.txt',
    'cat "*.env"',
    'grep -r password .',
    'grep -e foo /etc/passwd README.md',
    'grep foo',
    'cat $(echo .env)',
    'cat `ls`',
    'cat $HOME/notes',
    'ls > out.txt',
    'cat README.md >> log',
    'ls &',
    'ls & rm -rf src',
    'rm -rf src',
    'sed -i s/a/b/ file',
    'find . -exec rm {} ;',
    'find . -delete',
    'find . -name x | xargs rm',
    'cat README.md | sh',
    'cat script.py | python3',
    'sort -o out.txt data.txt',
    'tail -f log.txt',
    'npm run build',
    'go version',
    'cargo --version',
    'pnpm --version',
    'git push',
    'git -c core.pager=evil log',
    'echo {a,b}',
    'ls ~',
    'ls =ls',
    'FOO=bar ls',
    'cat',
    'ls; curl http://example.com',
    'cat README.md\nrm x',
    "ls 'unterminated",
    'ls "a"b',
  ])
    assert.equal(low(command), false, command);
});

test('a relative PATH entry disables the native-command shortcut', () => {
  const context = { ...posix, env: { PATH: '.:/usr/bin' } };
  assert.equal(low('ls', context), false);
  assert.equal(low('ls', { ...posix, env: { PATH: '/usr/bin::/bin' } }), false);
});

test('Windows single native commands stay literal and avoid PowerShell argument pitfalls', () => {
  const windows: HostRiskContext = {
    workspaceDir: 'C:\\projects\\demo',
    dataDir: 'C:\\Users\\u\\AppData\\Roaming\\aelion-bot',
    homeDir: 'C:\\Users\\u',
    platform: 'win32',
    env: { Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs;' },
  };
  for (const command of ['node --version', 'python -V', 'where.exe git node'])
    assert.equal(low(command, windows), true, command);
  for (const command of [
    'node -e "require(1)"',
    'git -c:core.pager=x log',
    'rg --% foo',
    'node --version; Remove-Item x',
    'npm run build',
    'where git',
    'go version',
  ])
    assert.equal(low(command, windows), false, command);
  assert.equal(low('node --version', { ...windows, env: { Path: '%USERPROFILE%\\bin;C:\\Windows' } }), false);
});

test('reading back a file this run wrote is local; other outside reads are not', () => {
  const context: HostRiskContext = { ...posix, ownWrites: new Set(['/tmp/render/page-1.png']) };
  const read = (path: string) => classifyHostCommand({ operation: 'read_file', path, reason: 'test' }, context).lowRisk;
  if (process.platform === 'linux') assert.equal(read('/tmp/render/page-1.png'), true);
  assert.equal(read('/tmp/render/page-2.png'), false);
  assert.equal(read('render/page-1.png'), false, 'relative paths are not matched against recorded writes');
  const secret: HostRiskContext = { ...posix, ownWrites: new Set(['/tmp/out/.env']) };
  assert.equal(
    classifyHostCommand({ operation: 'read_file', path: '/tmp/out/.env', reason: 'test' }, secret).lowRisk,
    false,
  );
});

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
function localContext(t: test.TestContext) {
  const root = tempDir(t, 'aelion-command-policy-'),
    project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'README.md'), 'hello');
  writeFileSync(join(project, 'src', 'app.ts'), 'export {}');
  const context: HostRiskContext = {
    workspaceDir: project,
    dataDir: join(root, 'data'),
    homeDir: root,
    platform: process.platform,
    env: {
      [process.platform === 'win32' ? 'Path' : 'PATH']:
        process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin',
    },
  };
  return { project, context };
}

test(
  'read-only git commands are local only in a repository without program-running config or hooks',
  { skip: !gitAvailable() },
  (t) => {
    const { project, context } = localContext(t);
    execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true });
    for (const command of [
      'git status',
      'git status -sb',
      'git log --oneline -5',
      'git diff --stat',
      'git branch -a',
      'git rev-parse HEAD',
    ])
      assert.equal(low(command, context), true, command);
    for (const command of [
      'git log -p .env',
      'git show HEAD:.env',
      'git diff --output=x',
      'git branch -D main',
      'git config --list',
      'git grep --untracked key',
      'git checkout .',
    ])
      assert.equal(low(command, context), false, command);
    execFileSync('git', ['config', 'core.fsmonitor', 'evil'], { cwd: project, windowsHide: true });
    assert.equal(low('git status', context), false, 'fsmonitor runs a program');
    execFileSync('git', ['config', '--unset', 'core.fsmonitor'], { cwd: project, windowsHide: true });
    assert.equal(low('git status', context), true);
    writeFileSync(join(project, '.git', 'hooks', 'post-index-change'), '#!/bin/sh\n');
    assert.equal(low('git status', context), false, 'an installed hook may run');
  },
);

test('ripgrep is local only for explicit project files', (t) => {
  const { context } = localContext(t);
  assert.equal(low('rg -n hello README.md', context), true);
  assert.equal(low('rg --files src', context), true);
  for (const command of [
    'rg hello',
    'rg hello src',
    'rg --pre cat hello README.md',
    'rg -z hello README.md',
    'rg -L hello README.md',
    'rg hello ../x',
  ])
    assert.equal(low(command, context), false, command);
});

const parser = process.platform === 'win32' ? new PowerShellParser() : undefined;
test.after(() => parser?.dispose());
test(
  'PowerShell scripts are judged on the real syntax tree: compound read-only queries pass',
  { skip: !parser },
  async (t) => {
    const { project, context } = localContext(t);
    if (gitAvailable()) execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true });
    const assess = async (command: string) => {
      const parsed = await parser!.parse(command);
      return parsed.ok && assessPowerShell(parsed.ast, run(command, context, project), context).lowRisk;
    };
    const allowed = [
      'Get-ChildItem src -Recurse -Filter *.ts | Select-Object -First 5 Name, Length',
      'Get-ChildItem | Where-Object { $_.Length -gt 10 } | ForEach-Object { $_.Name }',
      'Get-ChildItem -Recurse -File | Measure-Object | Select-Object -ExpandProperty Count',
      '(Get-ChildItem src -Recurse -File).Count',
      'Get-Content README.md | Select-String "hello" -Context 2',
      'Get-Content -Raw README.md',
      `$p = "${project}\\src"; Get-ChildItem $p | Sort-Object Name`,
      '$dir = "src"; Get-ChildItem "$dir" -Name',
      'if (Test-Path README.md) { Write-Host "yes" } else { Write-Host "no" }',
      'Select-String -Path README.md -Pattern hello -SimpleMatch',
      'Get-ChildItem src | Select-Object Name, @{ n = "KB"; e = { [math]::Round($_.Length / 1KB, 1) } }'.replace(
        '[math]::Round($_.Length / 1KB, 1)',
        '$_.Length / 1KB',
      ),
      'node --version; python --version 2>&1',
      'Write-Output "=== files ==="; Get-ChildItem src -Name',
      'foreach ($f in Get-ChildItem src) { $f.Name }',
      'Get-ChildItem src | Format-Table Name, Length -AutoSize | Out-String',
      'Select-String -Path README.md -Pattern hello | ForEach-Object { "$($_.LineNumber): $($_.Line)" }',
      'Get-Content README.md -ErrorAction SilentlyContinue',
      '(Get-Command node -ErrorAction SilentlyContinue).Source',
      'Select-String -Path README.md -Pattern hello | ForEach-Object { "{0}: {1}" -f $_.LineNumber, $_.Line.Trim() }',
      'Get-Content README.md 2>$null',
      '"abc".ToUpper()',
      ...(gitAvailable()
        ? ['git status --short; git log --oneline -5', 'git diff --stat; if ($LASTEXITCODE -ne 0) { exit 1 }']
        : []),
    ];
    for (const command of allowed) assert.equal(await assess(command), true, command);
    const denied = [
      'Remove-Item src -Recurse -Force',
      'Get-Content README.md | Set-Content copy.md',
      'Get-ChildItem -Recurse | Select-String password',
      '$files = Get-ChildItem -Recurse; $files | Select-String key',
      'Get-ChildItem | Write-Output | Select-String key',
      'Get-ChildItem | ForEach-Object { Get-Content $_ }',
      'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
      'Invoke-Expression "Get-Date"',
      'iex "ls"',
      '& "C:\\Windows\\System32\\cmd.exe" /c dir',
      '. .\\setup.ps1',
      'Get-Content README.md > out.txt',
      'Get-ChildItem *> files.txt',
      'Invoke-WebRequest https://example.com',
      'Get-Content ..\\outside.txt',
      'Get-Content C:\\Windows\\win.ini',
      'Get-Content .env',
      'Get-Content .en?',
      'Get-Content .en[v]',
      'Get-Content $env:USERPROFILE\\.ssh\\id_rsa',
      '${C:\\Windows\\win.ini}',
      '"abc".GetType().Assembly',
      '$x = "a"; $x.Normalize()',
      '[IO.File]::ReadAllText("README.md")',
      'Start-Process notepad',
      'Set-Location ..; Get-ChildItem',
      '$env:Path = "."; git status',
      '& { Get-Date }',
      '$(Remove-Item x)',
      'Write-Host "$(Remove-Item x)"',
      'Get-ChildItem | ForEach-Object { $_.Replace("a", "b") }',
      'Get-ChildItem | ForEach-Object { $_.Delete() }',
      'Get-Content README.md 2>> log.txt',
      'Get-Content README.md 2> err.txt',
      'Get-Content README.md -ErrorAction Inquire',
      'Get-ChildItem | Select-Object @{ e = { Remove-Item $_ } }',
      'Get-ChildItem | Where-Object { $_.Delete() }',
      'Copy-Item README.md x',
      'New-Item x -ItemType File',
      'git push',
      'git -c core.pager=evil log',
      'python script.py',
      'Get-Content README.md | python',
      'foreach ($i in 1..100000000) { $i }',
      'function f { Remove-Item x }; f',
      'Get-ChildItem -Path "$HOME"',
      'Get-Content -Path "src\\$(Remove-Item x)"',
    ];
    for (const command of denied) assert.equal(await assess(command), false, command);
    const escape = await parser!.parse('} ; Remove-Item x ; . {');
    assert.equal(escape.ok, false, 'text that would escape the host wrapper does not parse');
  },
);

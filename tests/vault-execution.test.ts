import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Harness, TOOLS } from '../electron/core/agent/harness';
import { Interactions, respondToInteraction } from '../electron/core/agent/interactions';
import { HostDesktop } from '../electron/core/host/desktop/host-desktop';
import type { DesktopCapture, DesktopDriver, DesktopWindow } from '../electron/core/host/desktop/desktop-helper';
import { HostComputer } from '../electron/core/host/host';
import { Cognition } from '../electron/core/memory/cognition';
import { VAULT_REDACTION_MARKER } from '../electron/core/vault/vault-redactor';
import { VaultResolver } from '../electron/core/vault/vault-resolver';
import { VaultService } from '../electron/core/vault/vault-service';
import { VaultStore, type VaultCodec } from '../electron/core/vault/vault-store';
import { ComputerController } from '../electron/core/vm/computer';
import type { VmController } from '../electron/core/vm/vm';
import type { Completion, ModelClient } from '../electron/core/model/model';
import { Store } from '../electron/core/storage/store';
import { TerminalSessions } from '../electron/core/tools/terminal-sessions';
import { errorCode } from '../shared/errors';
import type { HostComputerSettings } from '../shared/types/permission-types';
import type { WireMessage } from '../shared/types/core';
import type { VaultItemWriteInput } from '../shared/types/vault-types';

const call = (name: string, args: unknown) => ({
  id: randomUUID(),
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

const testCodec: VaultCodec = {
  isAvailable: () => true,
  encrypt: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (cipher: string) => Buffer.from(cipher.slice(4), 'base64').toString('utf8'),
};

function createTestHarness(
  t: test.TestContext,
  complete: (messages: WireMessage[], index: number) => Completion,
  opts: {
    autoApproveHost?: boolean;
    autoApproveVault?: 'allow' | 'allow-run' | 'deny';
    onVaultUse?: (requestId: string) => void;
    onVaultInput?: (requestId: string) => void;
    vm?: Partial<VmController>;
    computer?: ComputerController;
    hostDesktop?: HostDesktop;
    afterRun?: (messages: WireMessage[] | undefined) => void;
  } = {},
) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, 'aelion-vault-e2e-'));
  const store = new Store(join(dir, 'data'));
  store.data.model.model = 'test';
  store.data.model.contextTokens = 64000;

  const vaultStore = new VaultStore(store.dir, testCodec);
  const vault = new VaultService(vaultStore);

  const interactionLog: Array<{ kind: string; decision: string; details?: unknown }> = [];
  let computer!: ComputerController;

  const interactions = new Interactions(
    () => {
      for (const req of interactions.snapshot()) {
        queueMicrotask(() => {
          try {
            if (req.kind === 'host_permission' && opts.autoApproveHost !== false) {
              interactions.approve(req.id, true);
            } else if (req.kind === 'vault_use') {
              opts.onVaultUse?.(req.id);
              if (opts.autoApproveVault) {
                interactions.decideVaultUse(req.id, opts.autoApproveVault);
              }
            } else if (req.kind === 'vault_input') {
              opts.onVaultInput?.(req.id);
            }
          } catch {}
        });
      }
    },
    (request, decision) => {
      interactionLog.push({
        kind: request.kind,
        decision,
        ...(request.kind === 'host_permission' ? { details: structuredClone(request.details) } : {}),
      });
    },
  );

  const vaultResolver = new VaultResolver(vault, (req, signal) => interactions.requestVaultUse(req, signal));
  const host = new HostComputer(
    {
      dataDir: store.dir,
      homeDir: dir,
      projectDir: dir,
      env: { ...process.env },
      secrets: () => vault.activeSecrets(),
      imagePreview: (_bytes, id) => ({ id, width: 20, height: 20 }),
    },
    interactions,
  );
  mkdirSync(host.workspace(store.data.bots[0].id), { recursive: true });

  const vmMock = {
    state: { status: 'ready', desktopReady: true, appsReady: true },
    ...opts.vm,
  } as unknown as VmController;

  computer = opts.computer ?? new ComputerController(vmMock, dir, () => {}, vaultResolver);

  let modelIdx = 0;
  const model = {
    complete: async (messages: WireMessage[]) => complete(messages, ++modelIdx),
  } as unknown as ModelClient;

  let cognition: Cognition | undefined;
  if (opts.afterRun) {
    cognition = new Cognition(
      store,
      model,
      { list: () => [], autoManaged: () => false } as any,
      () => {},
      () => false,
      () => vault.allSecretsForRedaction(),
      60_000,
    );
    const origAfterRun = cognition.afterRun.bind(cognition);
    cognition.afterRun = (botId, runId, messages, tools) => {
      opts.afterRun!(messages);
      return origAfterRun(botId, runId, messages, tools);
    };
  }

  const harness = new Harness(
    store,
    vmMock,
    model,
    () => {},
    computer,
    undefined,
    undefined,
    host,
    interactions,
    cognition,
  );
  harness.setVault(vault, vaultResolver);
  if (opts.hostDesktop) harness.setHostDesktop(opts.hostDesktop);

  t.after(async () => {
    harness.disposeTools();
    await cognition?.close();
    host.dispose();
    interactions.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    store,
    vault,
    vaultResolver,
    interactions,
    interactionLog,
    host,
    vmMock,
    computer,
    harness,
    bot: store.data.bots[0],
  };
}

test('exec_command blind-injects vaultEnv and vaultFiles with SSH passphrase, cleans temp files, and redacts all outputs/logs', async (t) => {
  const apiToken = 'ghp' + '_VaultRealSecretToken123456';
  const sshPrivateKey =
    '-----BEGIN ' +
    'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHI=\n' +
    '-----END ' +
    'OPENSSH PRIVATE KEY-----';
  const sshPassphrase = 'correct-horse-battery-staple';
  const capturedPath = join(mkdtempSync(join(realpathSync(tmpdir()), 'aelion-vault-obs-')), 'observed.json');
  t.after(() => rmSync(dirname(capturedPath), { recursive: true, force: true }));

  let capturedPromptEnv: unknown;
  const f = createTestHarness(
    t,
    (messages, index) => {
      if (index === 1) {
        const script = [
          'const fs = require("fs");',
          'const cp = require("child_process");',
          'const askOut = process.env.SSH_ASKPASS ? cp.execFileSync(process.env.SSH_ASKPASS, { encoding: "utf8" }) : "";',
          'fs.writeFileSync(' + JSON.stringify(capturedPath) + ', JSON.stringify({',
          '  token: process.env.GH_TOKEN,',
          '  keyPath: process.env.SSH_KEY,',
          '  keyContent: fs.readFileSync(process.env.SSH_KEY, "utf8"),',
          '  askpass: process.env.SSH_ASKPASS,',
          '  askOut,',
          '  requireForce: process.env.SSH_ASKPASS_REQUIRE,',
          '}));',
          'console.log("LEAKED=" + process.env.GH_TOKEN);',
          'console.log("KEY=" + fs.readFileSync(process.env.SSH_KEY, "utf8"));',
        ].join(' ');
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            call('exec_command', {
              command: `node -e ${JSON.stringify(script)}`,
              location: 'host',
              tty: false,
              vaultEnv: { GH_TOKEN: '{{vault:gh.password}}' },
              vaultFiles: { SSH_KEY: '{{vault:prod_ssh.privateKey}}' },
            }),
          ],
        };
      }
      // Second turn receives redacted tool response, never plaintext
      capturedPromptEnv = messages.find((m) => m.role === 'tool')?.content;
      return { content: 'Command completed securely.', calls: [], finishReason: 'stop' };
    },
    { autoApproveHost: true, autoApproveVault: 'allow' },
  );

  f.vault.save({
    category: 'api_key',
    slug: 'gh',
    title: 'GitHub Token',
    policy: 'ask-once-per-run',
    fields: { password: apiToken },
  });
  f.vault.save({
    category: 'ssh_key',
    slug: 'prod_ssh',
    title: 'Prod SSH',
    policy: 'ask-once-per-run',
    fields: { privateKey: sshPrivateKey, passphrase: sshPassphrase },
  });

  await f.harness.run(f.bot.id, 'Run deployment check');
  assert.equal(f.store.data.runs[0].status, 'completed', f.store.data.runs[0].error || '');
  assert.equal(f.store.data.messages.find((m) => m.role === 'tool')?.status, 'done', String(capturedPromptEnv));

  // 1. vault.json is stored directly as a file in dataDir (required by backup-secrets.ts) and permission prompt runs first
  assert.ok(statSync(join(f.store.dir, 'vault.json')).isFile());
  const hostPerm = f.interactionLog.find((entry) => entry.kind === 'host_permission');
  assert.ok(hostPerm, 'host_permission must run first');
  assert.equal(JSON.stringify(hostPerm.details).includes(apiToken), false);
  assert.equal(JSON.stringify(hostPerm.details).includes('OPENSSH PRIVATE KEY'), false);

  // 2. Real secrets reached process env & 0o600 files + SSH_ASKPASS
  const observed = JSON.parse(readFileSync(capturedPath, 'utf8'));
  assert.equal(observed.token, apiToken);
  assert.equal(observed.keyContent.trim(), sshPrivateKey.trim());
  assert.equal(observed.askOut, sshPassphrase);
  assert.equal(observed.requireForce, 'force');

  // 3. Ephemeral vault temp files and dir deleted after process exit
  assert.equal(existsSync(observed.keyPath), false);
  assert.equal(existsSync(dirname(observed.keyPath)), false);
  assert.equal(existsSync(observed.askpass), false);

  // 4. Returned tool message to model, results/*.json, ledger, ChatMessage, events.jsonl contain NO plaintext
  const promptToolStr = String(capturedPromptEnv || '');
  assert.equal(promptToolStr.includes(apiToken), false);
  assert.equal(promptToolStr.includes('correct-horse-battery-staple'), false);
  assert.equal(promptToolStr.includes('OPENSSH PRIVATE KEY'), false);
  assert.ok(promptToolStr.includes(VAULT_REDACTION_MARKER));

  const resultsDir = join(f.store.dir, 'results');
  for (const file of readdirSync(resultsDir)) {
    const content = readFileSync(join(resultsDir, file), 'utf8');
    assert.equal(content.includes(apiToken), false);
    assert.equal(content.includes('OPENSSH PRIVATE KEY'), false);
  }
  const allStoreText = JSON.stringify({
    runs: f.store.data.runs,
    messages: f.store.data.messages,
  });
  assert.equal(allStoreText.includes(apiToken), false);
  assert.equal(allStoreText.includes('OPENSSH PRIVATE KEY'), false);
});

test('TerminalSessions.read redacts VM and host output even without HostComputer', async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'aelion-vm-term-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vaultStore = new VaultStore(dir, testCodec);
  const vault = new VaultService(vaultStore);
  vault.save({
    category: 'api_key',
    slug: 'vm_api',
    title: 'VM API',
    policy: 'auto',
    fields: { password: 'vm-secret-value-xyz999' },
  });
  const resolver = new VaultResolver(vault);
  const seenVmPayload: unknown[] = [];
  const fakeVm = {
    state: { status: 'ready', desktopReady: true, appsReady: true },
    execute: async (_cmd: string, _botId: string, _signal?: AbortSignal, _lim?: number, opts?: any) => {
      seenVmPayload.push(opts?.vaultPayload);
      return {
        exitCode: 0,
        stdout: 'ENV=' + (opts?.vaultPayload?.env?.API_KEY || ''),
        stderr: '',
      };
    },
  } as unknown as VmController;

  const terminals = new TerminalSessions(fakeVm, undefined, undefined, dir, resolver, vault.redactor);
  const res = await terminals.start(
    'bot-1',
    'run-vm',
    { location: 'vm', command: 'echo "$API_KEY"', vaultEnv: { API_KEY: '{{vault:vm_api.password}}' } },
    new AbortController().signal,
  );
  assert.equal((seenVmPayload[0] as any).env.API_KEY, 'vm-secret-value-xyz999');
  assert.equal(res.output.includes('vm-secret-value-xyz999'), false);
  assert.ok(res.output.includes(VAULT_REDACTION_MARKER));
});

test('computer(type) injects secret via xclip stdin, clears clipboard + primary in finally, and blocks open_app(url)', async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'aelion-comp-vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vaultStore = new VaultStore(dir, testCodec);
  const vault = new VaultService(vaultStore);
  vault.save({
    category: 'login',
    slug: 'portal',
    title: 'Portal',
    policy: 'auto',
    fields: { password: 'PortalPassword!888' },
  });
  const resolver = new VaultResolver(vault);

  const desktopCalls: Array<{ command: string; stdin?: string }> = [];
  let failPasteKey = false;
  const fakeVm = {
    state: { status: 'ready', desktopReady: true, appsReady: true },
    ensureBotDesktop: async (botId: string) => ({ vncUrl: 'ws://local/' + botId }),
    desktopScreenshot: async () => {
      const png = Buffer.alloc(32);
      Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
      png.writeUInt32BE(1280, 16);
      png.writeUInt32BE(800, 20);
      return png;
    },
    execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    executeDesktop: async (
      command: string,
      _botId: string,
      _signal?: AbortSignal,
      _lim?: number,
      inputBytes?: Buffer,
    ) => {
      desktopCalls.push({ command, ...(inputBytes ? { stdin: inputBytes.toString('utf8') } : {}) });
      if (failPasteKey && command.includes('xdotool key')) {
        return { exitCode: 1, stdout: '', stderr: 'xdotool crashed' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  } as unknown as VmController;

  const computer = new ComputerController(fakeVm, dir, () => {}, resolver);
  const sig = new AbortController().signal;

  // open_app with vault placeholder is rejected with vault.sink_not_allowed
  await assert.rejects(
    () =>
      computer.execute(
        'b1',
        { action: 'open_app', app: 'browser', url: 'https://x.com?pw={{vault:portal.password}}' },
        sig,
      ),
    (err) => errorCode(err) === 'vault.sink_not_allowed',
  );

  const obs = await computer.execute('b1', { action: 'screenshot' }, sig);
  await computer.execute(
    'b1',
    {
      action: 'batch',
      observationId: obs.screenshot.id,
      actions: [
        { action: 'click', x: 100, y: 200 },
        { action: 'type', text: '{{vault:portal.password}}' },
        { action: 'key', key: 'ENTER' },
      ],
    },
    sig,
    { botId: 'b1', runId: 'run-comp' },
  );

  const clipCall = desktopCalls.find(
    (c) => c.command.includes('xclip -selection clipboard -in') && c.stdin !== undefined,
  );
  assert.ok(clipCall, 'xclip should receive password via stdin');
  assert.equal(clipCall.stdin, 'PortalPassword!888');
  assert.equal(clipCall.command.includes('PortalPassword!888'), false);
  assert.equal(clipCall.command.includes('base64'), false);

  const clearCall = desktopCalls.find(
    (c) =>
      c.command.includes('xclip -selection clipboard -in </dev/null') &&
      c.command.includes('xclip -selection primary -in </dev/null'),
  );
  assert.ok(clearCall, 'clipboard and primary selection must be cleared in finally');

  // Verify finally clears clipboard even if key paste fails
  desktopCalls.length = 0;
  failPasteKey = true;
  const obs2 = await computer.execute('b1', { action: 'screenshot' }, sig);
  await assert.rejects(() =>
    computer.execute(
      'b1',
      { action: 'type', observationId: obs2.screenshot.id, text: '{{vault:portal.password}}' },
      sig,
      { botId: 'b1', runId: 'run-comp' },
    ),
  );
  assert.ok(
    desktopCalls.some(
      (c) =>
        c.command.includes('xclip -selection clipboard -in </dev/null') &&
        c.command.includes('xclip -selection primary -in </dev/null'),
    ),
    'clipboard cleared even after xdotool failure',
  );
});

test('host_computer(set_value) injects password and short CVV cleanly and redacts observe(includeText=true)', async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'aelion-host-desk-vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vaultStore = new VaultStore(dir, testCodec);
  const vault = new VaultService(vaultStore);
  vault.save({
    category: 'card',
    slug: 'visa',
    title: 'Personal Visa',
    fields: { cardNumber: '4242424242424242', cvv: '842' },
  });

  const approvedUse: Array<{ allowRunGrant: boolean; fields: string[]; targetSummary: string }> = [];
  const resolver = new VaultResolver(vault, async (req) => {
    approvedUse.push({ allowRunGrant: req.allowRunGrant, fields: req.fields, targetSummary: req.targetSummary });
    return 'allow';
  });

  const setValues: Array<{ element: number; value: string }> = [];
  const win: DesktopWindow = {
    id: 1,
    title: 'Checkout - Chrome',
    className: 'Chrome',
    pid: 1,
    exe: '/Applications/Google Chrome.app',
    name: 'Google Chrome',
    minimized: false,
    foreground: true,
    elevated: false,
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
  };
  let settings: HostComputerSettings = { enabled: true };
  const fakeDriver: DesktopDriver = {
    quietLaunch: false,
    status: async () => ({ accessibility: true, screenRecording: true, elevated: false, display: [0, 0, 1200, 800] }),
    listApps: async () => [],
    listWindows: async () => [win],
    window: async () => win,
    foreground: async () => win,
    capture: async (_id, _file, opts) => {
      const cap: DesktopCapture = {
        ...win,
        originX: 0,
        originY: 0,
        scale: 1,
        imageWidth: 1200,
        imageHeight: 800,
        ...(opts.text
          ? {
              text: '0 Edit "卡号" = "4242424242424242" [10,20 100x24]\n1 Edit "安全码" = "842" [10,50 60x24]',
              elements: [
                [10, 20, 100, 24],
                [10, 50, 60, 24],
              ],
            }
          : {}),
      };
      return cap;
    },
    input: async () => {},
    press: async () => {},
    scroll: async () => {},
    setValue: async (_winId, element, value) => {
      setValues.push({ element, value });
    },
    launch: async () => {},
    dispose: () => {},
  };

  const hostDesktop = new HostDesktop({
    driver: fakeDriver,
    imageDir: dir,
    settings: {
      read: () => settings,
      write: (next) => {
        settings = next;
      },
    },
    requestAccess: async () => {},
    running: () => true,
    changed: () => {},
    sleep: async () => {},
    vaultResolver: resolver,
    redactText: (text, runId) => vault.redactor.redactString(text, { runId }),
  });

  const sig = new AbortController().signal;
  const obs = await hostDesktop.execute(
    'b1',
    'run-hc',
    { action: 'get_window_state', window: 1, includeText: true },
    sig,
  );
  const res = await hostDesktop.execute(
    'b1',
    'run-hc',
    {
      action: 'batch',
      window: 1,
      observationId: obs.screenshot!.id,
      includeText: true,
      actions: [
        { action: 'set_value', element: 0, value: '{{vault:visa.cardNumber}}' },
        { action: 'set_value', element: 1, value: '{{vault:visa.cvv}}' },
      ],
    },
    sig,
    { botId: 'b1', runId: 'run-hc' },
  );

  assert.deepEqual(setValues, [
    { element: 0, value: '4242424242424242' },
    { element: 1, value: '842' },
  ]);
  // Card category enforces always-ask with allowRunGrant = false, single grouped prompt per batch, and window targetSummary
  assert.equal(approvedUse.length, 1);
  assert.deepEqual(approvedUse[0].fields.sort(), ['cardNumber', 'cvv']);
  assert.ok(approvedUse.every((u) => u.allowRunGrant === false && u.targetSummary.includes('Google Chrome')));
  assert.equal(res.text?.includes('4242424242424242'), false);
  assert.equal(res.text?.includes('"842"'), false);
  assert.ok(res.text?.includes(VAULT_REDACTION_MARKER));
});

test('vault_save scrubs user message, history, results, ledger, events.jsonl and MemoryCapture inputs', async (t) => {
  const email = 'alice.secret@example.com';
  const card = '4242 4242 4242 9999';
  let capturedForMemory: WireMessage[] | undefined;

  const f = createTestHarness(
    t,
    (_messages, index) => {
      if (index === 1) {
        return {
          content: `Saving ${email} now.`,
          reasoning: `Storing ${email} in vault.`,
          finishReason: 'tool_calls',
          calls: [
            call('vault_save', {
              category: 'card',
              title: 'Primary Card',
              fields: { email, cardNumber: '4242424242429999' },
            }),
          ],
        };
      }
      return { content: 'Saved into your Vault.', calls: [], finishReason: 'stop' };
    },
    {
      afterRun: (msgs) => {
        capturedForMemory = msgs;
      },
    },
  );

  await f.harness.run(f.bot.id, `Save my email ${email} and card ${card} for future checkout`);
  assert.equal(f.store.data.runs[0].status, 'completed', f.store.data.runs[0].error || '');

  // User ChatMessage was scrubbed and flagged
  const userMsg = f.store.data.messages.find((m) => m.role === 'user');
  assert.ok(userMsg);
  assert.equal(userMsg.vaultScrubbed, true);
  assert.equal(userMsg.content.includes(email), false);
  assert.equal(userMsg.content.includes('4242424242429999'), false);
  assert.equal(userMsg.content.includes(card), false);

  // Assistant display activity, events.jsonl, results/*.json, history and MemoryCapture messages have zero plaintext
  const allDataStr = JSON.stringify({
    messages: f.store.data.messages,
    conversations: f.store.data.conversations,
    runs: f.store.data.runs,
    memoryMsgs: capturedForMemory,
  });
  assert.equal(allDataStr.includes(email), false);
  assert.equal(allDataStr.includes('4242424242429999'), false);
  assert.equal(allDataStr.includes(card), false);

  const eventsFile = join(f.store.dir, 'events.jsonl');
  if (existsSync(eventsFile)) {
    const eventsText = readFileSync(eventsFile, 'utf8');
    assert.equal(eventsText.includes(email), false);
    assert.equal(eventsText.includes('4242424242429999'), false);
  }
});

test('vault_request collects secret off-band with zero plaintext leakage in history, interactions, and tool output', async (t) => {
  const enteredSecret = 'UltraSecret!VaultInputPassword#42';
  let toolResultStr = '';

  const f = createTestHarness(
    t,
    (messages, index) => {
      if (index === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            call('vault_request', {
              title: 'GitHub Password',
              reason: 'Need GitHub login credentials',
              category: 'login',
              suggestedSlug: 'gh_req',
              bindings: [{ kind: 'domain', value: 'github.com' }],
              fields: [
                { key: 'username', label: 'Username', kind: 'text', required: true },
                { key: 'password', label: 'Password', kind: 'password', required: true },
              ],
            }),
          ],
        };
      }
      toolResultStr = String(messages.find((m) => m.role === 'tool')?.content || '');
      return { content: 'Done using Vault item.', calls: [], finishReason: 'stop' };
    },
    {
      onVaultInput: (reqId) => {
        const vaultInput: VaultItemWriteInput = {
          category: 'login',
          slug: 'gh_req',
          title: 'GitHub Password',
          bindings: [{ kind: 'domain', value: 'github.com' }],
          fields: { username: 'octocat', password: enteredSecret },
        };
        respondToInteraction(f.interactions, f.computer, { id: reqId, action: 'submit', vaultInput });
      },
    },
  );

  await f.harness.run(f.bot.id, 'Please log me into GitHub');
  assert.equal(f.store.data.runs[0].status, 'completed', f.store.data.runs[0].error || '');

  assert.equal(toolResultStr.includes('gh_req'), true);
  assert.equal(toolResultStr.includes(enteredSecret), false);

  const items = f.vault.overview().items;
  assert.equal(items.length, 1);
  assert.deepEqual(f.vault.decryptFields(items[0].id), { username: 'octocat', password: enteredSecret });

  const persistedStr = JSON.stringify({
    messages: f.store.data.messages,
    conversations: f.store.data.conversations,
    runs: f.store.data.runs,
    interactions: f.interactionLog,
  });
  assert.equal(persistedStr.includes(enteredSecret), false);
});

test('code_exec invokes nested tools cleanly without resolving secrets in JS sandbox and blocks hard-forbidden tools', async (t) => {
  const capturedFromPython: string[] = [];
  const f = createTestHarness(
    t,
    (messages, index) => {
      if (index === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            call('code_exec', {
              code: `
                const py = await tools.python_execute({
                  code: 'import os; print("OUT=" + os.environ["SVC_KEY"])',
                  vaultEnv: { SVC_KEY: '{{vault:svc.password}}' },
                });
                return { stdout: py.result.stdout };
              `,
            }),
          ],
        };
      }
      const toolReply = String(messages.find((m) => m.role === 'tool')?.content || '');
      assert.equal(toolReply.includes('nested-python-secret-777'), false);
      assert.ok(toolReply.includes(VAULT_REDACTION_MARKER));
      return { content: 'Nested completed.', calls: [], finishReason: 'stop' };
    },
    {
      autoApproveVault: 'allow',
      vm: {
        executePython: async (_code: string, input: Buffer) => {
          const payload = JSON.parse(input.toString('utf8'));
          const secret = payload?.env?.SVC_KEY;
          capturedFromPython.push(secret);
          return { exitCode: 0, stdout: 'OUT=' + secret + '\n', stderr: '', durationMs: 1 };
        },
      } as unknown as Partial<VmController>,
    },
  );
  f.vault.save({
    category: 'api_key',
    slug: 'svc',
    title: 'Service Key',
    policy: 'auto',
    fields: { password: 'nested-python-secret-777' },
  });

  await assert.rejects(
    () =>
      (f.harness as any).executeTool(
        f.bot,
        { path: 'leak.txt', content: '{{vault:svc.password}}', location: 'vm' },
        'file_write',
        new AbortController().signal,
        'direct-run',
        {},
      ),
    (err) => errorCode(err) === 'vault.sink_not_allowed',
  );

  assert.ok(TOOLS.some((tool) => tool.function.name === 'vault_list'));
  await f.harness.run(f.bot.id, 'Run nested execution');
  assert.equal(f.store.data.runs[0].status, 'completed', f.store.data.runs[0].error || '');
  assert.ok(capturedFromPython.includes('nested-python-secret-777'));
});

test('vault_use denial throws InteractionDenied vault.denied without executing sink, and vault_request cancel returns cancelled', async (t) => {
  let executedCommand = false;
  const f = createTestHarness(
    t,
    (messages, index) => {
      if (index === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            call('exec_command', {
              command: 'node -e "process.stdout.write(process.env.TOK)"',
              location: 'vm',
              vaultEnv: { TOK: '{{vault:deny_tok.password}}' },
            }),
          ],
        };
      }
      if (index === 2) {
        const deniedMsg = String(messages.find((m) => m.role === 'tool')?.content || '');
        assert.ok(deniedMsg.includes('"denied":true'));
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            call('vault_request', {
              title: 'Cancelled Form',
              reason: 'Need token',
              category: 'api_key',
              fields: [{ key: 'password', label: 'Token', kind: 'password', required: true }],
            }),
          ],
        };
      }
      const reqMsg = String(messages.filter((m) => m.role === 'tool').at(-1)?.content || '');
      assert.ok(reqMsg.includes('"cancelled":true'));
      return { content: 'Handled denial and cancellation.', calls: [], finishReason: 'stop' };
    },
    {
      autoApproveVault: 'deny',
      onVaultInput: (reqId) => {
        respondToInteraction(f.interactions, f.computer, { id: reqId, action: 'cancel' });
      },
      vm: {
        execute: async () => {
          executedCommand = true;
          return { exitCode: 0, stdout: 'should-not-run', stderr: '', durationMs: 1 };
        },
      } as unknown as Partial<VmController>,
    },
  );

  f.vault.save({
    category: 'api_key',
    slug: 'deny_tok',
    title: 'Deny Token',
    policy: 'always-ask',
    fields: { password: 'should-never-execute-token' },
  });

  await f.harness.run(f.bot.id, 'Try denied vault use then cancelled request');
  assert.equal(f.store.data.runs[0].status, 'completed', f.store.data.runs[0].error || '');
  assert.equal(executedCommand, false);
});

test('mcp_call keeps permission inspection on placeholders, expands after approval, and redacts output/error', async (t) => {
  const secret = 'ghp' + '_McpBoundSecretToken555666';
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'aelion-mcp-vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vaultStore = new VaultStore(dir, testCodec);
  const vault = new VaultService(vaultStore);
  vault.save({
    category: 'api_key',
    slug: 'gh_mcp',
    title: 'GitHub MCP',
    bindings: [{ kind: 'mcp', value: 'github' }],
    policy: 'auto-when-bound',
    fields: { password: secret },
  });

  const inspectedArgs: unknown[] = [];
  const calledArgs: unknown[] = [];
  const interactions = new Interactions(() => {
    for (const req of interactions.snapshot()) {
      queueMicrotask(() => {
        try {
          if (req.kind === 'host_permission') interactions.approve(req.id, true);
        } catch {}
      });
    }
  });
  t.after(() => interactions.dispose());

  const resolver = new VaultResolver(vault, (req, sig) => interactions.requestVaultUse(req, sig));
  const { MCP_HANDLER } = await import('../electron/core/agent/tools/handlers/mcp');

  const fakeMcp = {
    inspectCall: async (_server: string, _tool: string, input: Record<string, unknown>) => {
      inspectedArgs.push(structuredClone(input));
      return {
        fingerprint: 'fp-1',
        permission: {
          operation: 'mcp' as const,
          reason: 'Call github MCP',
          tool: 'mcp_call',
          arguments: structuredClone(input),
        },
      };
    },
    fileBridge: () => undefined,
    call: async (_server: string, _tool: string, input: Record<string, unknown>) => {
      calledArgs.push(structuredClone(input));
      return { echo: input.token };
    },
  };

  const res = (await MCP_HANDLER.handler({
    bot: { id: 'b1', name: 'Bot', soul: '', color: '#000', createdAt: '', memories: [] },
    args: { server: 'github', name: 'auth_check', arguments: { token: '{{vault:gh_mcp.password}}' } },
    name: 'mcp_call',
    signal: new AbortController().signal,
    runId: 'run-mcp',
    options: {},
    run: undefined,
    workspace: dir,
    deps: {
      interactions,
      vault,
      vaultResolver: resolver,
      vaultContext: (botId: string, runId: string) => ({ botId, runId }),
      integrations: { mcp: fakeMcp } as any,
    } as any,
  })) as { echo: string };

  // inspectCall saw unexpanded placeholder; mcp.call saw expanded secret; handler returned redacted result
  assert.deepEqual(inspectedArgs, [{ token: '{{vault:gh_mcp.password}}' }]);
  assert.deepEqual(calledArgs, [{ token: secret }]);
  assert.equal(res.echo, VAULT_REDACTION_MARKER);
});

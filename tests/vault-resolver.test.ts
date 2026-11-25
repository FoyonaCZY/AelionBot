import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { InteractionDenied } from '../electron/core/agent/interactions';
import {
  buildVmVaultPayload,
  materializeHostVaultFiles,
  VaultResolver,
  type VaultApprovalRequest,
} from '../electron/core/vault/vault-resolver';
import { VaultService } from '../electron/core/vault/vault-service';
import { VaultStore, type VaultCodec } from '../electron/core/vault/vault-store';
import { generateTotp } from '../electron/core/vault/vault-totp';
import { errorCode } from '../shared/errors';
import {
  allowedSinksForField,
  containsVaultRef,
  extractVaultRefs,
  isHardBlockedSink,
  parseVaultRef,
  VAULT_REF_RE,
} from '../shared/vault-refs';
import { tempDir } from './helpers';

const rejectsCode = (code: string) => (error: unknown) => errorCode(error) === code;

const fakePemKey = (body: string) =>
  ['-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', body, '-----END ' + 'OPENSSH PRIVATE KEY-----'].join('\n');

const testCodec: VaultCodec = {
  isAvailable: () => true,
  encrypt: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (cipher: string) => Buffer.from(cipher.slice(4), 'base64').toString('utf8'),
};

function setupVault(t: test.TestContext, fixedTimeMs = 59_000) {
  const dir = tempDir(t);
  const store = new VaultStore(dir, testCodec);
  const service = new VaultService(store, undefined, () => fixedTimeMs);
  return { dir, store, service };
}

test('Placeholder syntax, boundaries, missing item/field and virtual TOTP resolution', async (t) => {
  const { service } = setupVault(t, 59_000);
  service.save({
    category: 'login',
    slug: 'github',
    title: 'GitHub',
    policy: 'auto',
    fields: {
      username: 'alice',
      password: 'gh-password-secret',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    },
  });
  service.save({
    category: 'contact',
    slug: 'profile',
    title: 'Profile',
    fields: { email: 'alice@example.com' },
  });

  assert.ok(VAULT_REF_RE.global);
  assert.deepEqual('{{vault:github.totp}}'.match(VAULT_REF_RE), ['{{vault:github.totp}}']);
  assert.equal(containsVaultRef('hello {{vault:github.password}}'), true);
  assert.equal(containsVaultRef('hello {{vault:bad}}'), false);
  assert.deepEqual(parseVaultRef('{{vault:github.totp}}'), { item: 'github', field: 'totp' });
  assert.equal(parseVaultRef('{{vault:github.constructor}}'), null);
  assert.equal(extractVaultRefs('{{vault:github.username}} and {{vault:github.totp}}').length, 2);

  const resolver = new VaultResolver(service, undefined, () => 59_000);
  const baseCtx = { botId: 'bot-1', runId: 'run-1', sink: 'vm_desktop' as const, targetSummary: 'VM desktop' };

  // Malformed refs and prototype keys fail with vault.ref_invalid
  for (const badText of [
    '{{vault:missing_dot}}',
    '{{vault:UPPER.password}}',
    '{{vault:__proto__.password}}',
    '{{vault:github.constructor}}',
    '{{vault:github.prototype}}',
    '{{vault:github.unclosed',
  ]) {
    await assert.rejects(resolver.resolveText(badText, baseCtx), rejectsCode('vault.ref_invalid'));
  }

  // Unknown item / field fail strictly
  await assert.rejects(resolver.resolveText('{{vault:unknown.password}}', baseCtx), rejectsCode('vault.not_found'));
  await assert.rejects(
    resolver.resolveText('{{vault:github.nonexistent}}', baseCtx),
    rejectsCode('vault.field_not_found'),
  );
  await assert.rejects(resolver.resolveText('{{vault:profile.totp}}', baseCtx), rejectsCode('vault.field_not_found'));

  // Valid resolution including dynamic RFC 6238 virtual `totp` field
  const resolved = await resolver.resolveText(
    'user={{vault:github.username}} pass={{vault:github.password}} otp={{vault:github.totp}}',
    baseCtx,
  );
  const expectedTotp = generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', { timestampMs: 59_000 });
  assert.equal(resolved, `user=alice pass=gh-password-secret otp=${expectedTotp}`);
  assert.equal(expectedTotp, '287082');

  // Ephemeral TOTP code is redacted during run-1 and evicted upon clearRun('run-1')
  assert.equal(service.redactor.redactString(`code=${expectedTotp}`), 'code=[redacted:vault]');
  resolver.clearRun('run-1');
  assert.equal(service.redactor.redactString(`code=${expectedTotp}`), `code=${expectedTotp}`);
});

test('Sink capability matrix blocks card outside desktop, blocks inline ssh privateKey with guidance, and blocks hard-blocked tools', async (t) => {
  const { service } = setupVault(t);
  service.save({
    category: 'card',
    slug: 'visa',
    title: 'Visa Card',
    // Even if caller attempts to pass non-desktop allowedSinks, card stays strictly desktop-only
    allowedSinks: ['exec_env', 'vm_desktop'],
    fields: {
      cardNumber: '4242424242424242',
      cvv: '412',
    },
  });
  service.save({
    category: 'ssh_key',
    slug: 'prod_ssh',
    title: 'Prod SSH',
    policy: 'auto',
    fields: {
      privateKey: fakePemKey('TESTKEYDATA1234567890'),
      passphrase: 'ssh-passphrase-secret',
    },
  });

  const resolver = new VaultResolver(service, async () => 'allow');

  // Card is rejected on exec_env, exec_inline, exec_file, python_env, mcp
  for (const sink of ['exec_env', 'exec_inline', 'exec_file', 'python_env', 'mcp'] as const) {
    await assert.rejects(
      resolver.resolveText('{{vault:visa.cardNumber}}', {
        botId: 'bot-1',
        runId: 'run-1',
        sink,
        targetSummary: sink,
      }),
      rejectsCode('vault.sink_not_allowed'),
    );
  }
  // Card is allowed on vm_desktop & host_desktop
  const desktopCard = await resolver.resolveText('{{vault:visa.cardNumber}}', {
    botId: 'bot-1',
    runId: 'run-1',
    sink: 'vm_desktop',
    targetSummary: 'VM desktop',
  });
  assert.equal(desktopCard, '4242424242424242');

  // ssh_key.privateKey inline to command or env is rejected with guidance pointing to vaultFiles
  await assert.rejects(
    resolver.resolveText('echo {{vault:prod_ssh.privateKey}}', {
      botId: 'bot-1',
      runId: 'run-1',
      sink: 'exec_inline',
      targetSummary: 'exec_command',
    }),
    (err: unknown) => errorCode(err) === 'vault.sink_not_allowed' && (err as Error).message.includes('vaultFiles'),
  );
  await assert.rejects(
    resolver.resolveEnv(
      { SSH_KEY: '{{vault:prod_ssh.privateKey}}' },
      { botId: 'bot-1', runId: 'run-1', sink: 'exec_env', targetSummary: 'exec_command' },
    ),
    rejectsCode('vault.sink_not_allowed'),
  );

  // ssh_key.privateKey via resolveFiles (exec_file) succeeds and includes companion passphrase & 0o600/0o700 cleanup
  const resolvedFiles = await resolver.resolveFiles(
    { SSH_KEY: '{{vault:prod_ssh.privateKey}}' },
    { botId: 'bot-1', runId: 'run-1', targetSummary: 'git clone' },
  );
  assert.equal(resolvedFiles.length, 1);
  assert.equal(resolvedFiles[0].envVar, 'SSH_KEY');
  assert.equal(resolvedFiles[0].companionPassphrase, 'ssh-passphrase-secret');

  const vmPayload = buildVmVaultPayload(resolvedFiles, { FOO: 'bar' });
  assert.equal(vmPayload.files[0].passphrase, 'ssh-passphrase-secret');

  const materialized = materializeHostVaultFiles(resolvedFiles);
  assert.ok(existsSync(materialized.env.SSH_KEY));
  assert.ok(existsSync(materialized.env.SSH_ASKPASS));
  assert.equal(materialized.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(materialized.env.DISPLAY, 'none');
  if (process.platform !== 'win32') {
    assert.equal(statSync(materialized.env.SSH_KEY).mode & 0o777, 0o600);
    assert.equal(statSync(materialized.env.SSH_ASKPASS).mode & 0o777, 0o700);
  }
  materialized.cleanup();
  assert.equal(existsSync(materialized.dir), false);

  // Hard-blocked tools & open_app(url) are all rejected with vault.sink_not_allowed
  for (const blockedTool of [
    'memory',
    'file_write',
    'file_patch',
    'apply_patch',
    'group_send_message',
    'bot_send_message',
    'web_read',
    'skill_save',
    'open_preview',
    'widget_save',
    'automation_create',
    'request_user_input',
    'request_user_control',
  ]) {
    assert.throws(
      () => resolver.assertToolInputAllowed(blockedTool, { content: '{{vault:prod_ssh.passphrase}}' }),
      rejectsCode('vault.sink_not_allowed'),
    );
  }
  assert.throws(
    () =>
      resolver.assertToolInputAllowed('computer', {
        action: 'open_app',
        app: 'browser',
        url: 'https://example.com/?token={{vault:prod_ssh.passphrase}}',
      }),
    rejectsCode('vault.sink_not_allowed'),
  );
  assert.throws(
    () =>
      resolver.assertToolInputAllowed('computer', {
        action: 'batch',
        actions: [{ action: 'open_app', app: 'browser', url: 'https://example.com/?t={{vault:prod_ssh.passphrase}}' }],
      }),
    rejectsCode('vault.sink_not_allowed'),
  );
  // Hard-blocked tools inspect object keys as well as values
  assert.throws(
    () => resolver.assertToolInputAllowed('file_write', { path: 'a.txt', '{{vault:prod_ssh.passphrase}}': 'x' }),
    rejectsCode('vault.sink_not_allowed'),
  );
  // isHardBlockedSink & allowedSinksForField respect fieldKey & explicit allowedSinks
  assert.equal(isHardBlockedSink('ssh_key', 'text', 'exec_inline', 'privateKey'), true);
  assert.deepEqual(allowedSinksForField('secret', 'multiline_key', ['exec_env'], 'tlsCert'), ['exec_env']);
  // Allowed sink tools pass entry check
  resolver.assertToolInputAllowed('exec_command', {
    command: 'echo ok',
    vaultFiles: { SSH_KEY: '{{vault:prod_ssh.privateKey}}' },
  });
  resolver.assertToolInputAllowed('mcp__github__create_issue', { title: '{{vault:prod_ssh.passphrase}}' });
});

test('Bot scope and execution context matrix (headless, scheduledRun, groupOrigin, peerOrigin, connector)', async (t) => {
  const { service } = setupVault(t);
  service.save({
    category: 'contact',
    slug: 'auto_contact',
    title: 'Auto Contact',
    policy: 'auto',
    botIds: ['bot-a'],
    fields: { email: 'auto@example.com' },
  });
  service.save({
    category: 'api_key',
    slug: 'manual_key',
    title: 'Manual API Key',
    policy: 'auto',
    allowInAutomation: false,
    fields: { apiKey: 'sk-manual-123456' },
  });
  service.save({
    category: 'api_key',
    slug: 'auto_key',
    title: 'Automated API Key',
    policy: 'auto',
    allowInAutomation: true,
    fields: { apiKey: 'sk-automated-123456' },
  });
  service.save({
    category: 'card',
    slug: 'corp_card',
    title: 'Corporate Card',
    allowInAutomation: true, // Forced false by card invariant
    fields: { cardNumber: '5555444433332222' },
  });

  const prompts: VaultApprovalRequest[] = [];
  const resolver = new VaultResolver(service, async (req) => {
    prompts.push(req);
    return 'allow';
  });

  // Bot scope
  await assert.rejects(
    resolver.resolveText('{{vault:auto_contact.email}}', {
      botId: 'bot-b',
      runId: 'r1',
      sink: 'mcp',
      targetSummary: 'mcp',
    }),
    rejectsCode('vault.bot_not_allowed'),
  );
  assert.equal(
    await resolver.resolveText('{{vault:auto_contact.email}}', {
      botId: 'bot-a',
      runId: 'r1',
      sink: 'mcp',
      targetSummary: 'mcp',
    }),
    'auto@example.com',
  );

  // peerOrigin blocked for all categories
  await assert.rejects(
    resolver.resolveText('{{vault:auto_contact.email}}', {
      botId: 'bot-a',
      runId: 'r2',
      sink: 'mcp',
      targetSummary: 'mcp',
      peerOrigin: true,
    }),
    rejectsCode('vault.context_not_allowed'),
  );

  // Connector non-owner blocked; owner allowed
  await assert.rejects(
    resolver.resolveText('{{vault:auto_contact.email}}', {
      botId: 'bot-a',
      runId: 'r3',
      sink: 'mcp',
      targetSummary: 'mcp',
      connector: { isOwner: false },
    }),
    rejectsCode('vault.context_not_allowed'),
  );
  assert.equal(
    await resolver.resolveText('{{vault:auto_contact.email}}', {
      botId: 'bot-a',
      runId: 'r3',
      sink: 'mcp',
      targetSummary: 'mcp',
      connector: { isOwner: true },
    }),
    'auto@example.com',
  );

  // Group chat: card forbidden; bot-triggered turn forbidden; human-triggered login/api_key forces vault_use even if policy === 'auto'
  await assert.rejects(
    resolver.resolveText('{{vault:corp_card.cardNumber}}', {
      botId: 'bot-a',
      runId: 'r4',
      sink: 'vm_desktop',
      targetSummary: 'vm',
      groupOrigin: true,
    }),
    rejectsCode('vault.context_not_allowed'),
  );
  await assert.rejects(
    resolver.resolveText('{{vault:auto_contact.email}}', {
      botId: 'bot-a',
      runId: 'r4',
      sink: 'mcp',
      targetSummary: 'mcp',
      groupOrigin: true,
      groupBotTriggered: true,
    }),
    rejectsCode('vault.context_not_allowed'),
  );
  prompts.length = 0;
  assert.equal(
    await resolver.resolveText('{{vault:auto_key.apiKey}}', {
      botId: 'bot-a',
      runId: 'r4',
      sink: 'exec_env',
      targetSummary: 'exec',
      groupOrigin: true,
    }),
    'sk-automated-123456',
  );
  assert.equal(prompts.length, 1);

  // Scheduled & Headless: card forbidden; manual_key forbidden; auto_key allowed without prompt
  for (const mode of [{ scheduledRun: true }, { headless: true }]) {
    await assert.rejects(
      resolver.resolveText('{{vault:corp_card.cardNumber}}', {
        botId: 'bot-a',
        runId: 'r5',
        sink: 'vm_desktop',
        targetSummary: 'vm',
        ...mode,
      }),
      rejectsCode('vault.context_not_allowed'),
    );
    await assert.rejects(
      resolver.resolveText('{{vault:manual_key.apiKey}}', {
        botId: 'bot-a',
        runId: 'r5',
        sink: 'exec_env',
        targetSummary: 'exec',
        ...mode,
      }),
      rejectsCode('vault.context_not_allowed'),
    );
    assert.equal(
      await resolver.resolveText('{{vault:auto_key.apiKey}}', {
        botId: 'bot-a',
        runId: 'r5',
        sink: 'exec_env',
        targetSummary: 'exec',
        ...mode,
      }),
      'sk-automated-123456',
    );
  }
});

test('Policy state machine: auto, auto-when-bound, ask-once-per-run, always-ask, mismatch alerts and deny audit', async (t) => {
  const { service } = setupVault(t);
  service.save({
    category: 'login',
    slug: 'bound_auto',
    title: 'Bound Auto',
    policy: 'auto-when-bound',
    bindings: [{ kind: 'domain', value: 'github.com' }],
    fields: { password: 'bound-auto-password' },
  });
  service.save({
    category: 'login',
    slug: 'once_run',
    title: 'Once Per Run',
    policy: 'ask-once-per-run',
    bindings: [{ kind: 'mcp', value: 'github' }],
    fields: { username: 'octocat', password: 'once-run-password' },
  });
  service.save({
    category: 'card',
    slug: 'card_item',
    title: 'Personal Card',
    policy: 'auto', // Ignored: card always enforces always-ask
    fields: { cardNumber: '4111222233334444' },
  });

  const seenRequests: VaultApprovalRequest[] = [];
  let nextDecision: 'allow' | 'allow-run' | 'deny' = 'allow-run';

  const resolver = new VaultResolver(service, async (req) => {
    seenRequests.push(req);
    return nextDecision;
  });

  // 1. auto-when-bound: exact / subdomain match skips prompt; unknown target or mismatch prompts
  assert.equal(
    await resolver.resolveText('{{vault:bound_auto.password}}', {
      botId: 'b1',
      runId: 'run-1',
      sink: 'host_desktop',
      targetSummary: 'Chrome - github.com',
      target: { kind: 'domain', value: 'gist.github.com' },
    }),
    'bound-auto-password',
  );
  assert.equal(seenRequests.length, 0);

  // Target absent -> cannot verify binding -> prompts (and allow-run caches for the run when unbound)
  nextDecision = 'allow-run';
  await resolver.resolveText('{{vault:bound_auto.password}}', {
    botId: 'b1',
    runId: 'run-1',
    sink: 'host_desktop',
    targetSummary: 'Desktop',
  });
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].bindingMismatch, undefined);
  assert.equal(seenRequests[0].allowRunGrant, true);

  // Subsequent unbound call in same run-1 reuses the allow-run grant
  await resolver.resolveText('{{vault:bound_auto.password}}', {
    botId: 'b1',
    runId: 'run-1',
    sink: 'host_desktop',
    targetSummary: 'Desktop',
  });
  assert.equal(seenRequests.length, 1);

  // Target mismatch -> prompts with bindingMismatch: true and allowRunGrant: false
  await resolver.resolveText('{{vault:bound_auto.password}}', {
    botId: 'b1',
    runId: 'run-1',
    sink: 'host_desktop',
    targetSummary: 'Chrome - evil.com',
    target: { kind: 'domain', value: 'evil.com' },
  });
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[1].bindingMismatch, true);
  assert.equal(seenRequests[1].allowRunGrant, false);

  // Headless / scheduledRun with auto-when-bound + bindings & missing target rejects instead of silent auto
  service.save({
    category: 'api_key',
    slug: 'bound_auto_headless',
    title: 'Bound Auto Headless',
    policy: 'auto-when-bound',
    allowInAutomation: true,
    bindings: [{ kind: 'domain', value: 'api.example.com' }],
    fields: { apiKey: 'sk-bound-headless-123' },
  });
  await assert.rejects(
    resolver.resolveText('{{vault:bound_auto_headless.apiKey}}', {
      botId: 'b1',
      runId: 'run-h1',
      sink: 'exec_env',
      targetSummary: 'headless exec',
      headless: true,
    }),
    rejectsCode('vault.context_not_allowed'),
  );

  // App binding requires word/delimiter boundary ("mail" must not match "blackmail")
  service.save({
    category: 'login',
    slug: 'mail_app',
    title: 'Mail App',
    policy: 'auto-when-bound',
    bindings: [{ kind: 'app', value: 'Mail' }],
    fields: { password: 'mail-app-password' },
  });
  await resolver.resolveText('{{vault:mail_app.password}}', {
    botId: 'b1',
    runId: 'run-app-1',
    sink: 'host_desktop',
    targetSummary: 'Window: Blackmail App',
    target: { kind: 'app', value: 'Blackmail App' },
  });
  assert.equal(seenRequests.length, 3);
  assert.equal(seenRequests[2].bindingMismatch, true);
  await resolver.resolveText('{{vault:mail_app.password}}', {
    botId: 'b1',
    runId: 'run-app-1',
    sink: 'host_desktop',
    targetSummary: 'Window: Apple Mail - Inbox',
    target: { kind: 'app', value: 'Apple Mail - Inbox' },
  });
  assert.equal(seenRequests.length, 3);

  // 2. ask-once-per-run: grouped multi-field call prompts once, caches allow-run for same run+sink, re-prompts on new run or mismatch
  seenRequests.length = 0;
  nextDecision = 'allow-run';
  const objResolved = await resolver.resolveObject(
    { user: '{{vault:once_run.username}}', pass: '{{vault:once_run.password}}' },
    {
      botId: 'b1',
      runId: 'run-A',
      sink: 'mcp',
      targetSummary: 'MCP: github / login',
      target: { kind: 'mcp', value: 'github' },
    },
  );
  assert.deepEqual(objResolved, { user: 'octocat', pass: 'once-run-password' });
  assert.equal(seenRequests.length, 1);
  assert.deepEqual(seenRequests[0].fields, ['username', 'password']);
  assert.equal(seenRequests[0].allowRunGrant, true);

  // Second call in same run-A and same sink uses cached grant
  await resolver.resolveText('{{vault:once_run.password}}', {
    botId: 'b1',
    runId: 'run-A',
    sink: 'mcp',
    targetSummary: 'MCP: github / op',
    target: { kind: 'mcp', value: 'github' },
  });
  assert.equal(seenRequests.length, 1);

  // Binding mismatch forces re-prompt even inside run-A
  await resolver.resolveText('{{vault:once_run.password}}', {
    botId: 'b1',
    runId: 'run-A',
    sink: 'mcp',
    targetSummary: 'MCP: other / op',
    target: { kind: 'mcp', value: 'other-server' },
  });
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[1].bindingMismatch, true);

  // Different runId prompts again; choosing 'allow' (once) does NOT cache for next call in run-B
  nextDecision = 'allow';
  await resolver.resolveText('{{vault:once_run.password}}', {
    botId: 'b1',
    runId: 'run-B',
    sink: 'mcp',
    targetSummary: 'MCP: github',
    target: { kind: 'mcp', value: 'github' },
  });
  await resolver.resolveText('{{vault:once_run.password}}', {
    botId: 'b1',
    runId: 'run-B',
    sink: 'mcp',
    targetSummary: 'MCP: github',
    target: { kind: 'mcp', value: 'github' },
  });
  assert.equal(seenRequests.length, 4);

  // 3. always-ask (card): always prompts with allowRunGrant: false
  seenRequests.length = 0;
  nextDecision = 'allow';
  await resolver.resolveText('{{vault:card_item.cardNumber}}', {
    botId: 'b1',
    runId: 'run-C',
    sink: 'vm_desktop',
    targetSummary: 'VM desktop',
  });
  await resolver.resolveText('{{vault:card_item.cardNumber}}', {
    botId: 'b1',
    runId: 'run-C',
    sink: 'vm_desktop',
    targetSummary: 'VM desktop',
  });
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[0].allowRunGrant, false);
  assert.equal(seenRequests[1].allowRunGrant, false);

  // 4. User deny throws InteractionDenied (code: 'vault.denied') and logs denied audit without plaintext
  nextDecision = 'deny';
  await assert.rejects(
    resolver.resolveText('{{vault:card_item.cardNumber}}', {
      botId: 'b1',
      runId: 'run-C',
      sink: 'vm_desktop',
      targetSummary: 'VM desktop',
    }),
    (err: unknown) => err instanceof InteractionDenied && errorCode(err) === 'vault.denied',
  );
  const audits = service.audit({ limit: 5 });
  assert.equal(audits[0].action, 'denied');
  assert.equal(audits[0].decision, 'denied');
  assert.equal(JSON.stringify(audits).includes('4111222233334444'), false);

  // 5. Unreadable item fails fast with vault.unreadable BEFORE invoking approval handler
  const dir2 = tempDir(t);
  const serviceA = new VaultService(new VaultStore(dir2, testCodec));
  const itemA = serviceA.save({
    category: 'login',
    slug: 'cross_machine',
    title: 'Cross Machine',
    fields: { password: 'cross-machine-secret' },
  });
  const wrongCodec: VaultCodec = {
    isAvailable: () => true,
    encrypt: (v) => v,
    decrypt: () => {
      throw new Error('wrong key');
    },
  };
  const serviceB = new VaultService(new VaultStore(dir2, wrongCodec));
  assert.throws(() => serviceB.reveal(itemA.id), rejectsCode('vault.unreadable'));
  let promptCalled = false;
  const resolverB = new VaultResolver(serviceB, async () => {
    promptCalled = true;
    return 'allow';
  });
  await assert.rejects(
    resolverB.resolveText('{{vault:cross_machine.password}}', {
      botId: 'b1',
      runId: 'run-x',
      sink: 'vm_desktop',
      targetSummary: 'VM desktop',
    }),
    rejectsCode('vault.unreadable'),
  );
  assert.equal(promptCalled, false);
});

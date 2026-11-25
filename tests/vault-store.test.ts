import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { packBotFile, unpackBotFile } from '../electron/core/backup/bot-file';
import { exportBotContent, type BotTransferDeps } from '../electron/core/backup/bot-transfer';
import {
  collectSecrets,
  openSecrets,
  rewrapSecrets,
  sealSecrets,
  type SecretCodec,
} from '../electron/core/backup/backup-secrets';
import { applyPendingRestore, stageRestore, writeBackup } from '../electron/core/backup/data-backup';
import { SkillLibrary } from '../electron/core/extensions/skill-library';
import { Store } from '../electron/core/storage/store';
import { VaultRedactor, VAULT_REDACTION_MARKER } from '../electron/core/vault/vault-redactor';
import { VaultScrubber } from '../electron/core/vault/vault-scrubber';
import { VaultService } from '../electron/core/vault/vault-service';
import { VAULT_AUDIT_LIMIT, VaultStore, type VaultCodec } from '../electron/core/vault/vault-store';
import { generateTotp } from '../electron/core/vault/vault-totp';
import { errorCode } from '../shared/errors';
import { maskPreview, normalizeSlug } from '../shared/vault-refs';
import { tempDir } from './helpers';

const rejectsCode = (code: string) => (error: unknown) => errorCode(error) === code;

const fakePemKey = (body: string, label = 'OPENSSH ' + 'PRIVATE KEY') =>
  [`-----BEGIN ${label}-----`, body, `-----END ${label}-----`].join('\n');

const machineCodec = (machine: string, available = true): VaultCodec => ({
  isAvailable: () => available,
  encrypt: (value: string) => {
    if (!available) throw new Error('encryption unavailable');
    return `${machine}:${Buffer.from(value, 'utf8').toString('base64')}`;
  },
  decrypt: (cipher: string) => {
    if (!cipher.startsWith(`${machine}:`)) throw new Error('wrong machine key');
    return Buffer.from(cipher.slice(machine.length + 1), 'base64').toString('utf8');
  },
});

test('VaultService CRUD, partial field updates, deletion, slug normalization and uniqueness', (t) => {
  const dir = tempDir(t);
  const store = new VaultStore(dir, machineCodec('macA'));
  const service = new VaultService(store);

  const created = service.save({
    category: 'login',
    title: 'GitHub 个人账号!',
    notes: 'Main repo account',
    tags: ['dev', 'Dev', 'git'],
    bindings: [{ kind: 'domain', value: 'github.com' }],
    fields: {
      username: 'octocat',
      password: 'super-secret-password',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    },
  });

  assert.equal(created.slug, 'github');
  assert.deepEqual(created.tags, ['dev', 'git']);
  assert.equal(created.policy, 'ask-once-per-run');
  assert.ok(created.fields.some((f) => f.key === 'totp' && f.derived === true && f.kind === 'totp'));

  // Duplicate slug auto-disambiguates
  const second = service.save({
    category: 'login',
    title: 'GitHub',
    fields: { username: 'workcat', password: 'work-password-123' },
  });
  assert.equal(second.slug, 'github-2');

  // Reserved prototype names cannot become slugs
  assert.equal(normalizeSlug('__proto__'), 'proto');
  assert.equal(normalizeSlug('constructor'), 'constructor-item');
  assert.equal(normalizeSlug('纯中文标题', 'card'), 'card');

  // Partial update: keep username, update password, delete totpSecret -> derived totp disappears
  const updated = service.save({
    id: created.id,
    category: 'login',
    title: 'GitHub 个人账号!',
    fields: {
      password: 'rotated-password-999',
      totpSecret: null,
    },
  });
  assert.equal(
    updated.fields.some((f) => f.key === 'totp'),
    false,
  );
  assert.equal(
    updated.fields.some((f) => f.key === 'totpSecret'),
    false,
  );

  const revealed = service.reveal(created.id);
  assert.deepEqual(revealed, {
    username: 'octocat',
    password: 'rotated-password-999',
  });

  // Delete item and confirm missing lookup fails
  service.delete(second.id);
  assert.equal(service.overview().items.length, 1);
  assert.throws(() => service.reveal(second.id), rejectsCode('vault.not_found'));
  assert.throws(() => service.delete(second.id), rejectsCode('vault.not_found'));

  // Raw file on disk never contains plaintext secrets
  const disk = readFileSync(store.file, 'utf8');
  assert.equal(disk.includes('rotated-password-999'), false);
  assert.equal(disk.includes('octocat'), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(store.file).mode & 0o777, 0o600);
  }
});

test('VaultStore throws vault.encryption_unavailable when safeStorage is unavailable and never writes plaintext', (t) => {
  const dir = tempDir(t);
  const store = new VaultStore(dir, machineCodec('macA', false));
  const service = new VaultService(store);

  assert.equal(service.available, false);
  assert.throws(
    () =>
      service.save({
        category: 'api_key',
        title: 'OpenAI',
        fields: { apiKey: 'sk-test-1234567890' },
      }),
    rejectsCode('vault.encryption_unavailable'),
  );
  assert.equal(existsSync(store.file), false);
});

test('Decrypt-on-use avoids decrypting during listing/prompt and marks items unreadable on wrong machine', (t) => {
  const dir = tempDir(t);
  let decryptCalls = 0;
  const countingCodecA: VaultCodec = {
    ...machineCodec('macA'),
    decrypt: (cipher) => {
      decryptCalls++;
      return machineCodec('macA').decrypt(cipher);
    },
  };

  const serviceA = new VaultService(new VaultStore(dir, countingCodecA));
  const item = serviceA.save({
    category: 'api_key',
    title: 'Anthropic',
    bindings: [{ kind: 'domain', value: 'api.anthropic.com' }],
    fields: { apiKey: 'sk-ant-secret-9999' },
  });

  // Reopen with counting codec: overview, listForBot and prompt must NOT call decrypt()
  decryptCalls = 0;
  const serviceA2 = new VaultService(new VaultStore(dir, countingCodecA));
  assert.equal(serviceA2.overview().items.length, 1);
  assert.equal(serviceA2.listForBot('bot-1', { domain: 'api.anthropic.com' }).length, 1);
  const promptText = serviceA2.prompt('bot-1');
  assert.ok(promptText.includes(item.slug));
  assert.equal(promptText.includes('sk-ant-secret-9999'), false);
  assert.equal(decryptCalls, 0);

  // Reopen on another machine (codec B): decrypt fails -> vault.unreadable + unreadable: true
  const serviceB = new VaultService(new VaultStore(dir, machineCodec('macB')));
  assert.throws(() => serviceB.reveal(item.id), rejectsCode('vault.unreadable'));
  assert.equal(serviceB.getMeta(item.id)?.unreadable, true);
  assert.equal(serviceB.overview().items[0]?.unreadable, true);

  // Re-entering fields on machine B clears unreadable flag
  const repaired = serviceB.save({
    id: item.id,
    category: 'api_key',
    title: 'Anthropic',
    fields: { apiKey: 'sk-ant-reentered-1234' },
  });
  assert.equal(repaired.unreadable, undefined);
  assert.equal(serviceB.reveal(item.id).apiKey, 'sk-ant-reentered-1234');

  // Calling fieldKinds downgrade or overwriting a text field with PEM privateKey never downgrades multiline_key
  const ssh = serviceB.save({
    category: 'ssh_key',
    title: 'Downgrade Guard',
    fieldKinds: { privateKey: 'text' },
    fields: {
      privateKey: fakePemKey('AAAAb3BlbnNzaC1rZXktdjEAAAA='),
    },
  });
  assert.equal(ssh.fields.find((f) => f.key === 'privateKey')?.kind, 'multiline_key');

  const custom = serviceB.save({
    category: 'secret',
    title: 'Note Then PEM',
    fields: { blob: 'plain-initial-text' },
  });
  const upgraded = serviceB.save({
    id: custom.id,
    category: 'secret',
    title: 'Note Then PEM',
    fields: {
      blob: fakePemKey('MIIEvQIBADANBgkqhkiG9w0BAQE=', 'PRIVATE ' + 'KEY'),
    },
  });
  assert.equal(upgraded.fields.find((f) => f.key === 'blob')?.kind, 'multiline_key');
  assert.throws(
    () =>
      serviceB.save({
        category: 'secret',
        title: 'Bad Kind',
        fieldKinds: { v: 'bogus' as any },
        fields: { v: 'secret-val' },
      }),
    rejectsCode('vault.ref_invalid'),
  );
});

test('Audit ring buffer keeps only the latest 500 records without secrets', (t) => {
  const dir = tempDir(t);
  const service = new VaultService(new VaultStore(dir, machineCodec('macA')));
  const item = service.save({
    category: 'secret',
    title: 'Ring Item',
    fields: { value: 'ring-secret-value' },
  });

  for (let i = 0; i < 520; i++) {
    service.recordAudit({
      action: 'use',
      itemId: item.id,
      itemTitle: item.title,
      fields: ['value'],
      target: `step-${i}`,
      decision: 'auto',
    });
  }

  const all = service.audit();
  assert.equal(all.length, VAULT_AUDIT_LIMIT);
  assert.equal(all[0].target, 'step-519');
  assert.equal(all[all.length - 1].target, 'step-20');
  assert.equal(JSON.stringify(all).includes('ring-secret-value'), false);
});

test('maskPreview covers all field kinds and never exposes raw sensitive values', () => {
  const samples = [
    { kind: 'email' as const, value: 'zhangsan@example.com', expect: 'z***@example.com' },
    { kind: 'email' as const, value: 'ab@example.com', expect: '***@example.com' },
    { kind: 'phone' as const, value: '+86 138-0013-5678', expect: '***-****-5678' },
    { kind: 'card_number' as const, value: '4242-4242-4242-4242', expect: '•••• 4242' },
    { kind: 'password' as const, value: 'MyVeryLongSecretPass123!', expect: '••••••' },
    { kind: 'cvv' as const, value: '412', expect: '••••••' },
    { kind: 'totp' as const, value: 'JBSWY3DPEHPK3PXP', expect: '••••••' },
    {
      kind: 'multiline_key' as const,
      value: fakePemKey('b3BlbnNzaC1rZXktdjEAAAAABG5vbmU='),
    },
    { kind: 'text' as const, value: '李明', expect: '••••' },
    { kind: 'text' as const, value: '上海市浦东新区张江高科技园区', expect: '上海***' },
  ];

  for (const sample of samples) {
    const masked = maskPreview(sample.value, sample.kind);
    if (sample.expect) assert.equal(masked, sample.expect);
    assert.notEqual(masked, sample.value);
    assert.equal(masked.includes(sample.value), false);
    if (sample.kind === 'multiline_key') {
      assert.match(masked, /^SSH Key \(SHA256:[a-f0-9]{4}…[a-f0-9]{2}\)$/);
    }
  }
});

test('RFC 6238 TOTP test vectors (SHA-1 and SHA-256) and invalid secret rejection', () => {
  // RFC 6238 Appendix B test secrets: 20-byte ASCII "12345678901234567890" and 32-byte ASCII
  const sha1Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const sha256Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====';

  const vectors: Array<[number, string, string]> = [
    [59, '94287082', '46119246'],
    [1111111109, '07081804', '68084774'],
    [1111111111, '14050471', '67062674'],
    [1234567890, '89005924', '91819424'],
    [2000000000, '69279037', '90698825'],
  ];

  for (const [sec, expectedSha1, expectedSha256] of vectors) {
    assert.equal(
      generateTotp(sha1Secret, { timestampMs: sec * 1000, digits: 8, period: 30, algorithm: 'sha1' }),
      expectedSha1,
    );
    assert.equal(
      generateTotp(sha256Secret, { timestampMs: sec * 1000, digits: 8, period: 30, algorithm: 'sha256' }),
      expectedSha256,
    );
    // Default 6-digit output matches trailing 6 digits
    assert.equal(generateTotp(sha1Secret, { timestampMs: sec * 1000 }), expectedSha1.slice(-6));
  }

  // Case-insensitive & spaced secret succeeds
  assert.equal(generateTotp('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq', { timestampMs: 59_000 }), '287082');

  // Invalid Base32 secrets throw vault.totp_invalid
  for (const bad of ['', '   ', '12345678', 'INVALID!SECRET', 'ABC=']) {
    assert.throws(() => generateTotp(bad), rejectsCode('vault.totp_invalid'));
  }
});

test('VaultRedactor redacts encoded/card/PEM normal secrets and strictly scopes short secrets to runId contexts', () => {
  const redactor = new VaultRedactor();
  const pem = fakePemKey('AAAAb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=');
  redactor.setForItem('item-1', [
    { value: 'p@ss/w?rd=1&2 hello', kind: 'password' },
    { value: '4242-4242-4242-9876', kind: 'card_number' },
    { value: pem, kind: 'multiline_key' },
    { value: '412', kind: 'cvv' },
  ]);
  redactor.recordRunSecret('run-used', '412', 'cvv');
  redactor.recordRunSecret('run-used', '8392', 'cvv');
  redactor.recordRunSecret('run-used', '287082', 'totp'); // Ephemeral >= 6 char TOTP scoped to runId

  // Normal secrets (>= 6 chars) are scrubbed across raw, URL/form-URL, JSON-escaped, base64, card variants and PEM+newline base64
  const raw = 'p@ss/w?rd=1&2 hello';
  const payload = {
    raw,
    url: encodeURIComponent(raw),
    formUrl: encodeURIComponent(raw).replace(/%20/g, '+'),
    b64: Buffer.from(raw, 'utf8').toString('base64'),
    cardSpaced: '4242 4242 4242 9876',
    cardDigits: '4242424242429876',
    pemChunk: 'AAAAb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=',
    pemTrailingNewlineB64: Buffer.from(pem + '\n', 'utf8').toString('base64'),
    totp: '287082',
  };
  const clean = redactor.redactValue(payload, { runId: 'run-used' });
  for (const val of Object.values(clean)) {
    assert.equal(val, VAULT_REDACTION_MARKER);
  }

  // Object keys containing secrets are redacted too, and cyclic obj <-> Error references do not overflow
  const keyed = redactor.redactValue({ [`prefix-${raw}`]: 'ok' });
  assert.deepEqual(keyed, { [`prefix-${VAULT_REDACTION_MARKER}`]: 'ok' });
  const cyclicObj: Record<string, unknown> = { secret: raw };
  const cyclicErr = new Error(`boom ${raw}`) as Error & { meta?: unknown };
  cyclicObj.err = cyclicErr;
  cyclicErr.meta = cyclicObj;
  const redactedCyclic = redactor.redactValue(cyclicObj) as { secret: string; err: Error & { meta: unknown } };
  assert.equal(redactedCyclic.secret, VAULT_REDACTION_MARKER);
  assert.equal(redactedCyclic.err.message, `boom ${VAULT_REDACTION_MARKER}`);
  assert.equal(redactedCyclic.err.meta, redactedCyclic);

  // clearRun evicts ephemeral run-scoped TOTP and short secrets; removeItem evicts item secrets
  redactor.clearRun('run-used');
  assert.equal(redactor.redactString('287082'), '287082');
  redactor.removeItem('item-1');
  assert.equal(redactor.activeValues().length, 0);

  // Re-register short secrets for run-used and verify accessibility tree + Chinese prose redaction
  redactor.recordRunSecret('run-used', '412', 'cvv');
  redactor.recordRunSecret('run-used', '8392', 'cvv');

  // Short secrets (3-5 chars) MUST NOT clobber ports/status codes/line numbers globally
  const normalLog = 'Listening on port 8392, HTTP status 412, line 412 ok';
  assert.equal(redactor.redactString(normalLog, { runId: 'run-used' }), normalLog);
  assert.equal(redactor.redactString('CVV: 412 value="412"', { runId: 'run-other' }), 'CVV: 412 value="412"');

  // Inside the runId that actually used the short secret, host accessibility tree (` = "412"`), `value="..."` and CVV/PIN/安全码 are redacted
  assert.equal(
    redactor.redactString('12 Edit "安全码" = "412" [0,0 50x20]\n13 Edit = "8392" [0,20 50x20]', { runId: 'run-used' }),
    `12 Edit "安全码" = "${VAULT_REDACTION_MARKER}" [0,0 50x20]\n13 Edit = "${VAULT_REDACTION_MARKER}" [0,20 50x20]`,
  );
  assert.equal(
    redactor.redactString('field value="412" and CVV is 412, 安全码 412, PIN: 8392', { runId: 'run-used' }),
    `field value="${VAULT_REDACTION_MARKER}" and CVV is ${VAULT_REDACTION_MARKER}, 安全码 ${VAULT_REDACTION_MARKER}, PIN: ${VAULT_REDACTION_MARKER}`,
  );
  const widgetObj = redactor.redactValue(
    { role: 'textfield', name: 'CVC', value: '412', port: '412', line: 8392 },
    { runId: 'run-used' },
  );
  assert.equal(widgetObj.value, VAULT_REDACTION_MARKER);
  assert.equal(widgetObj.port, '412');
  assert.equal(widgetObj.line, 8392);

  // activeValues() must never leak 3-5 char short secrets to external redactors
  assert.equal(redactor.activeValues().includes('412'), false);
  assert.equal(redactor.activeValues().includes('8392'), false);

  // redactError keeps AppError.code intact while redacting secret message
  redactor.register('secret-err-value');
  const err = new Error('Failed with secret-err-value');
  const redactedErr = redactor.redactError(err);
  assert.equal(redactedErr.message, `Failed with ${VAULT_REDACTION_MARKER}`);
});

test('VaultScrubber masks vault_save args pre-log and scrubs saved values from messages, history, preparedContext and turnContext', (t) => {
  let store!: Store;
  t.after(() => store?.close());
  const dir = tempDir(t);
  store = new Store(dir, { incremental: true });
  const bot = store.data.bots[0];
  const secretEmail = 'alice.secret@example.com';
  const secretPassWithQuote = 'p@ss"quote\\slash\nline2';
  const secretCardSpaced = '4242 4242 4242 4242';
  const secretCardDigits = '4242424242424242';
  const secretPin = '9481';
  const rawInput = `请记住我的邮箱 ${secretEmail}，卡号 ${secretCardSpaced}，密码 ${secretPassWithQuote} 和 PIN ${secretPin}`;

  const userMsg = store.message(bot.id, 'user', rawInput);
  // Settle the message via save() so checkSettledEdits verifies store.touch() is called properly
  const runId = 'run-scrub-1';
  const run = {
    id: runId,
    botId: bot.id,
    status: 'running' as const,
    startedAt: new Date().toISOString(),
    modelCalls: 1,
    toolCalls: 0,
  };
  store.data.runs.push(run);
  userMsg.runId = runId;
  store.touch(userMsg);
  store.save();

  const maskedArgs = VaultScrubber.maskVaultSaveArgs({
    category: 'contact',
    title: '个人信息',
    fields: { email: secretEmail, pin: secretPin },
  });
  assert.deepEqual(maskedArgs.fields, { email: '[已加密保存]', pin: '[已加密保存]' });

  const history = store.data.conversations[bot.id];
  history.push({ role: 'user', content: rawInput });
  history.push({
    role: 'assistant',
    native: {
      protocol: 'responses',
      key: 'openai',
      data: [{ type: 'function_call', arguments: JSON.stringify({ fields: { password: secretPassWithQuote } }) }],
    },
    content: `Saving ${secretPassWithQuote}`,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'vault_save',
          arguments: JSON.stringify({
            category: 'contact',
            title: '个人信息',
            fields: { email: secretEmail, cardNumber: secretCardDigits, password: secretPassWithQuote, pin: secretPin },
          }),
        },
      },
    ],
  });
  const preparedContext = structuredClone(history);
  const turnContext = {
    role: 'system' as const,
    content: `当前请求：${rawInput}\nMessages available for reactions: ${JSON.stringify([{ content: rawInput }])}`,
  };

  const result = VaultScrubber.scrubAfterSave({
    store,
    runId,
    botId: bot.id,
    item: { id: 'v1', slug: 'personal', title: '个人信息' },
    savedFields: [
      { key: 'email', value: secretEmail },
      { key: 'cardNumber', value: secretCardDigits },
      { key: 'password', value: secretPassWithQuote },
      { key: 'pin', value: secretPin },
    ],
    history,
    preparedContext,
    turnContext,
    callId: 'call-1',
  });

  assert.equal(result.scrubbedMessages, 1);
  assert.equal(result.scrubbedToolCalls, 2);
  assert.equal(result.scrubbedTurnContext, true);

  assert.equal(userMsg.vaultScrubbed, true);
  assert.equal(userMsg.content.includes(secretEmail), false);
  assert.equal(userMsg.content.includes(secretCardSpaced), false);
  assert.equal(userMsg.content.includes(secretPassWithQuote), false);
  assert.equal(userMsg.content.includes(secretPin), false);
  assert.ok(userMsg.content.includes('[保险库：个人信息.email]'));
  assert.ok(userMsg.content.includes('[保险库：个人信息.cardNumber]'));
  assert.ok(userMsg.content.includes('[保险库：个人信息.password]'));
  assert.ok(userMsg.content.includes('[保险库：个人信息.pin]'));

  assert.equal(history[1].native, undefined);
  assert.equal(preparedContext[1].native, undefined);
  assert.equal(JSON.stringify(history).includes(secretEmail), false);
  assert.equal(JSON.stringify(history).includes(secretPassWithQuote), false);
  assert.equal(JSON.stringify(history).includes(secretPin), false);
  assert.ok(history[1].tool_calls![0].function.arguments.includes('[vault:saved]'));
  assert.equal(JSON.stringify(preparedContext).includes(secretEmail), false);
  assert.equal(turnContext.content.includes(secretEmail), false);
  assert.equal(turnContext.content.includes(JSON.stringify(secretPassWithQuote).slice(1, -1)), false);
  assert.equal(turnContext.content.includes(secretPin), false);
});

test('Full backup/restore migrates vault.json secrets across machines while .aelionbot never includes Vault data', async (t) => {
  const openStores: Store[] = [];
  t.after(() => openStores.forEach((s) => s.close()));

  const root = tempDir(t);
  const oldData = join(root, 'old-data');
  const oldConfig = join(root, 'old-config');
  const newData = join(root, 'new-data');
  const newConfig = join(root, 'new-config');
  mkdirSync(oldConfig, { recursive: true });
  mkdirSync(newConfig, { recursive: true });

  const codecA: SecretCodec = machineCodec('A');
  const codecB: SecretCodec = machineCodec('B');

  const oldStore = new Store(oldData, { incremental: true });
  openStores.push(oldStore);
  oldStore.flush();

  const vaultA = new VaultService(new VaultStore(oldData, codecA));
  const savedItem = vaultA.save({
    category: 'login',
    title: 'Prod Login',
    fields: { username: 'admin', password: 'backup-migration-password' },
  });

  // 1. Direct backup-secrets roundtrip check
  const collected = collectSecrets((name) => join(oldData, name), codecA);
  const sealed = await sealSecrets(collected, 'backup-pass');
  const opened = await openSecrets(sealed, 'backup-pass');
  assert.ok(Object.values(opened).some((plain) => plain.includes('backup-migration-password')));

  // 2. Full writeBackup -> stageRestore -> applyPendingRestore across machines
  const archive = join(root, 'full.aelionbackup');
  await writeBackup({
    dataDir: oldData,
    configDir: oldConfig,
    target: archive,
    appVersion: '0.55.3',
    device: 'mac-a',
    password: 'strong-backup-password',
    codec: codecA,
  });
  assert.equal(readFileSync(archive).includes('backup-migration-password'), false);

  const newStoreInit = new Store(newData, { incremental: true });
  newStoreInit.close();

  const staged = await stageRestore({
    file: archive,
    dataDir: newData,
    configDir: newConfig,
    appVersion: '0.55.3',
    codec: codecB,
    password: 'strong-backup-password',
  });
  assert.equal(staged.unreadableSecrets, 0);
  assert.equal(applyPendingRestore(newData)?.ok, true);

  const vaultB = new VaultService(new VaultStore(newData, codecB));
  assert.deepEqual(vaultB.reveal(savedItem.id), {
    username: 'admin',
    password: 'backup-migration-password',
  });

  // 3. Restoring without password (skipSecrets) leaves vault item unreadable until re-entered
  const skipData = join(root, 'skip-data');
  const skipConfig = join(root, 'skip-config');
  mkdirSync(skipConfig, { recursive: true });
  const skipStoreInit = new Store(skipData, { incremental: true });
  skipStoreInit.close();
  const stagedSkip = await stageRestore({
    file: archive,
    dataDir: skipData,
    configDir: skipConfig,
    appVersion: '0.55.3',
    codec: codecB,
    skipSecrets: true,
  });
  assert.equal(stagedSkip.unreadableSecrets, 1);
  assert.equal(applyPendingRestore(skipData)?.ok, true);
  const vaultSkipped = new VaultService(new VaultStore(skipData, codecB));
  assert.throws(() => vaultSkipped.reveal(savedItem.id), rejectsCode('vault.unreadable'));
  assert.equal(vaultSkipped.overview().items[0]?.unreadable, true);

  // Verify direct rewrapSecrets helper works on standalone vault.json too
  const rewrapResult = rewrapSecrets((name) => join(skipData, name), codecB, opened);
  assert.equal(rewrapResult.rewrapped, 1);
  assert.equal(rewrapResult.unreadable, 0);

  // 4. Single Bot export (.aelionbot) MUST NEVER contain vault.json or any Vault secrets/titles
  const bot = oldStore.data.bots[0];
  const deps: BotTransferDeps = {
    store: oldStore,
    dataDir: oldData,
    skills: new SkillLibrary(oldStore, {
      homeDir: root,
      projectDir: root,
      dataDir: oldData,
      configDir: oldConfig,
      env: {},
    }),
    providers: { list: () => [], selection: () => undefined },
    memory: { exportData: () => '{}', importData: () => {} },
  };
  const botBytes = packBotFile(exportBotContent(deps, bot.id, true), {
    appVersion: '0.55.3',
    exportedAt: '2026-11-25T00:00:00.000Z',
  });
  const rawZip = Buffer.from(botBytes).toString('utf8');
  assert.equal(rawZip.includes('vault.json'), false);
  assert.equal(rawZip.includes('Prod Login'), false);
  assert.equal(rawZip.includes('backup-migration-password'), false);
  assert.equal(unpackBotFile(botBytes).name, bot.name);
});

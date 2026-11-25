import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Interactions, respondToInteraction } from '../electron/core/agent/interactions';
import { RemoteHub, type RemoteDeps } from '../electron/core/remote/remote-hub';
import { Store } from '../electron/core/storage/store';
import { VaultService } from '../electron/core/vault/vault-service';
import { VaultStore, type VaultCodec } from '../electron/core/vault/vault-store';
import type { ComputerController } from '../electron/core/vm/computer';
import { startRelay } from '../relay/src/relay';
import { RemoteClient, type ClientStatus, type SocketLike } from '../shared/remote/client';
import { fromBase64Url, generateAgreementKey } from '../shared/remote/crypto';
import { readPairingUrl } from '../shared/remote/protocol';
import type { InteractionRequest } from '../shared/types/core';
import type { VaultItemWriteInput } from '../shared/types/vault-types';
import { until } from './helpers';

const vaultCodec: VaultCodec = {
  isAvailable: () => true,
  encrypt: (value: string) => `enc:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (cipher: string) => Buffer.from(cipher.slice(4), 'base64').toString('utf8'),
};

const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

function phone(
  link: { u: string; r: string; k: string; n: string },
  device: CryptoKeyPair,
  pairing?: { id: string; secret: Uint8Array },
) {
  const statuses: ClientStatus[] = [];
  const client = new RemoteClient({
    computer: { relay: link.u, room: link.r, key: link.k, name: link.n },
    device,
    pairing,
    socket: (url) => new WebSocket(url) as unknown as SocketLike,
    onStatus: (status) => statuses.push(status),
    onEvent: () => {},
  });
  client.connect();
  return { client, statuses };
}

test('RemoteHub allows vault.overview, vault.save, vault.audit and vault_use/vault_input responses while blocking reveal/delete/importSshKey', async (t) => {
  const relay = await startRelay({ port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'aelion-vault-remote-'));
  const store = new Store(dir);
  const vaultStore = new VaultStore(dir, vaultCodec);
  const vault = new VaultService(vaultStore);
  const pushes: Array<{ url: string; body?: unknown }> = [];
  let hub!: RemoteHub;

  const interactions = new Interactions(() => {
    hub?.changed();
  });
  interactions.setVaultSave((input, actor) => vault.save(input, actor));

  const fakeComputer = {} as ComputerController;
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const deps: RemoteDeps = {
    store,
    dataDir: dir,
    codec: { encrypt: (v) => 'x' + v, decrypt: (v) => v.slice(1) },
    version: '0.54.0',
    call: async (method, ...args) => {
      calls.push({ method, args });
      if (method === 'vaultOverview') return vault.overview();
      if (method === 'vaultSave') return vault.save(args[0] as VaultItemWriteInput);
      if (method === 'vaultAudit') return vault.audit(args[0] as { itemId?: string; limit?: number } | undefined);
      if (method === 'vaultReveal') return vault.reveal(String(args[0]));
      if (method === 'vaultDelete') return vault.delete(String(args[0]));
      if (method === 'respondInteraction') return respondToInteraction(interactions, fakeComputer, args[0] as any);
      return undefined;
    },
    streams: () => [],
    interactions: () => interactions.snapshot(),
    computer: {
      state: { desktops: {} },
      stateFor: (botId) => ({ botId, status: 'idle', manualControl: false }),
    },
    vmStatus: () => 'stopped',
    groups: () => undefined,
    speech: () => ({ input: false, output: false }),
    attachments: { bytes: () => Buffer.alloc(0), metadata: () => ({ name: '', mime: '', size: 0 }) },
    permissionMode: () => 'auto',
    idleSeconds: () => 9999,
    keepAwake: () => {},
    changed: () => {},
    fetch: (async (url: URL, init: RequestInit) => {
      pushes.push({ url: String(url), body: init.body });
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  };

  hub = new RemoteHub(deps);
  t.after(async () => {
    hub.stop();
    interactions.dispose();
    await relay.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await hub.update({ enabled: true, relayUrl: `http://localhost:${relay.port}` });
  await until(() => hub.view().status === 'online', { message: () => JSON.stringify(hub.view()) });

  // Pair mobile client
  await hub.startPairing();
  const pairing = hub.view().pairing!;
  const link = readPairingUrl(new URL(pairing.url).hash)!;
  const device = await generateAgreementKey();
  const p = phone(link, device, { id: link.i, secret: fromBase64Url(link.s) });
  t.after(() => p.client.close());
  await until(() => p.client.status === 'pending');
  await p.client.call('device.update', { name: 'My Phone' });
  await until(() => hub.view().pairing?.request?.name === 'My Phone');
  hub.decidePairing(true);
  await until(() => p.client.status === 'ready');

  // Subscribe push on paired phone to verify push notifications for vault_use / vault_input
  await p.client.call('push.subscribe', {
    endpoint: 'https://push.example.net/sub',
    keys: { p256dh: UA_PUBLIC, auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
  });

  // 1. vault.save (write-only) + vault.overview (metadata-only) + vault.audit
  const saved = await p.client.call('vault.save', {
    category: 'login',
    slug: 'mobile-item',
    title: 'Mobile Login',
    fields: { username: 'bob', password: 'mobile-password-123' },
  });
  assert.equal(saved.slug, 'mobile-item');
  assert.equal(saved.fields.find((f) => f.key === 'password')?.preview, '••••••');

  const overview = await p.client.call('vault.overview');
  assert.equal(overview.available, true);
  assert.equal(overview.items.length, 1);
  assert.equal(JSON.stringify(overview).includes('mobile-password-123'), false);

  const audit = await p.client.call('vault.audit', { itemId: saved.id, limit: 10 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'save');

  // 2. Explicit denylist: vault.reveal / vault.delete / vault.importSshKey MUST be rejected with remote.forbidden
  const untyped = p.client.call.bind(p.client) as unknown as (method: string, params?: unknown) => Promise<unknown>;
  for (const forbidden of [
    () => untyped('vault.reveal', { id: saved.id }),
    () => untyped('vault.delete', { id: saved.id }),
    () => untyped('vault.importSshKey'),
  ]) {
    await assert.rejects(forbidden, { code: 'remote.forbidden' });
  }
  assert.equal(vault.overview().items.length, 1);
  assert.equal(
    calls.some((c) => c.method === 'vaultReveal' || c.method === 'vaultDelete'),
    false,
  );

  // 3. Respond to vault_use (allow-run) and verify Web Push triggered
  const ac = new AbortController();
  const usePromise = interactions.requestVaultUse(
    {
      botId: store.data.bots[0].id,
      runId: 'run-r1',
      itemId: saved.id,
      itemTitle: saved.title,
      category: 'login',
      fields: ['password'],
      sink: 'vm_desktop',
      targetSummary: '工作电脑桌面输入',
      allowRunGrant: true,
    },
    ac.signal,
  );
  await until(() => interactions.snapshot().some((r) => r.kind === 'vault_use'));
  await until(() => pushes.length >= 1);
  const useReq = interactions
    .snapshot()
    .find((r): r is Extract<InteractionRequest, { kind: 'vault_use' }> => r.kind === 'vault_use')!;
  await p.client.call('request.respond', { id: useReq.id, action: 'allow-run' });
  assert.equal(await usePromise, 'allow-run');

  // 4. Respond to vault_input (submit) and verify plaintext encrypted in Vault & push triggered
  const pushesBeforeInput = pushes.length;
  const inputPromise = interactions.requestVaultInput(
    store.data.bots[0].id,
    'run-r2',
    {
      title: 'NPM Token',
      reason: 'Need token to publish',
      category: 'api_key',
      suggestedSlug: 'npm_tok',
      fields: [{ key: 'password', label: 'Token', kind: 'password', required: true }],
    },
    ac.signal,
  );
  await until(() => interactions.snapshot().some((r) => r.kind === 'vault_input'));
  await until(() => pushes.length > pushesBeforeInput);
  const inputReq = interactions
    .snapshot()
    .find((r): r is Extract<InteractionRequest, { kind: 'vault_input' }> => r.kind === 'vault_input')!;
  await p.client.call('request.respond', {
    id: inputReq.id,
    action: 'submit',
    vaultInput: {
      category: 'api_key',
      slug: 'npm_tok',
      title: 'NPM Token',
      fields: { password: 'npm_secret_remote_value' },
    },
  });
  const inputResult = await inputPromise;
  assert.equal(inputResult.saved, true);
  if (inputResult.saved) {
    assert.equal(inputResult.item.slug, 'npm_tok');
    assert.deepEqual(vault.decryptFields(inputResult.item.id), { password: 'npm_secret_remote_value' });
  }
});

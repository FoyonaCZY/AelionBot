// remote.json in the data directory: phone access settings, this computer's keys and the paired phones. Private keys
// and push subscriptions are stored encrypted with the system key store, like API keys.
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NOTIFY, type NotifyPrefs } from '../../../shared/remote/protocol';
import {
  exportPrivateKey,
  exportPublicKey,
  fromBase64Url,
  generateAgreementKey,
  generateSigningKey,
  importAgreementPrivateKey,
  importAgreementPublicKey,
  importSigningPrivateKey,
  importSigningPublicKey,
  toBase64Url,
  type Bytes,
} from '../../../shared/remote/crypto';
import type { SecretCodec } from '../connectors/connector-store';
import { atomicJson } from '../storage/store';

export interface StoredDevice {
  id: string;
  name: string;
  /** The phone's static key-agreement public key. */
  key: string;
  createdAt: string;
  lastSeenAt?: string;
  notify: NotifyPrefs;
  /** Encrypted JSON of the Web Push subscription. */
  push?: string;
  /** A passkey the phone asks for before it may do anything. */
  verify?: { credentialId: string; publicKey: string; rpId: string; origin: string; counter: number };
}
interface RemoteFile {
  version: 1;
  enabled: boolean;
  relayUrl?: string;
  appUrl?: string;
  name?: string;
  keepAwake: boolean;
  /** Encrypted JSON of the private keys; the public halves are kept in the clear. */
  keys?: { secret: string; agreement: string; signing: string; vapid: string };
  devices: StoredDevice[];
}
export interface RemoteKeys {
  agreement: CryptoKeyPair;
  agreementPublic: Bytes;
  signing: CryptoKeyPair;
  signingPublic: Bytes;
  /** The Web Push (VAPID) key. */
  vapid: CryptoKeyPair;
  vapidPublic: Bytes;
}

export class RemoteStore {
  readonly file: string;
  data: RemoteFile;
  private keys?: Promise<RemoteKeys>;

  constructor(
    dataDir: string,
    private readonly codec: SecretCodec,
  ) {
    this.file = join(dataDir, 'remote.json');
    let saved: Partial<RemoteFile> = {};
    try {
      if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8').trimStart());
    } catch {
      /* A damaged file starts empty rather than blocking the app; phones pair again. */
    }
    this.data = {
      version: 1,
      enabled: saved.enabled === true,
      ...(typeof saved.relayUrl === 'string' && saved.relayUrl ? { relayUrl: saved.relayUrl } : {}),
      ...(typeof saved.appUrl === 'string' && saved.appUrl ? { appUrl: saved.appUrl } : {}),
      ...(typeof saved.name === 'string' && saved.name.trim() ? { name: saved.name.trim() } : {}),
      keepAwake: saved.keepAwake !== false,
      ...(saved.keys && typeof saved.keys.secret === 'string' ? { keys: saved.keys } : {}),
      devices: Array.isArray(saved.devices)
        ? saved.devices
            .filter((device) => device && typeof device.id === 'string' && typeof device.key === 'string')
            .map((device) => ({ ...device, notify: { ...DEFAULT_NOTIFY, ...device.notify } }))
        : [],
    };
  }

  save() {
    atomicJson(this.file, this.data);
  }
  get name() {
    return this.data.name || hostname();
  }
  device(id: string) {
    return this.data.devices.find((device) => device.id === id);
  }
  deviceByKey(key: string) {
    return this.data.devices.find((device) => device.key === key);
  }
  pushSubscription(device: StoredDevice) {
    if (!device.push) return;
    try {
      return JSON.parse(this.codec.decrypt(device.push)) as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };
    } catch {
      return;
    }
  }
  setPushSubscription(device: StoredDevice, value: object | undefined) {
    if (value) device.push = this.codec.encrypt(JSON.stringify(value));
    else delete device.push;
  }

  /** This computer's keys, made on first use. A key file that cannot be read means making new ones. */
  loadKeys(): Promise<RemoteKeys> {
    return (this.keys ??= this.readKeys().catch(async () => this.createKeys()));
  }
  private async readKeys(): Promise<RemoteKeys> {
    const stored = this.data.keys;
    if (!stored) throw new Error('no keys');
    const secret = JSON.parse(this.codec.decrypt(stored.secret)) as Record<'agreement' | 'signing' | 'vapid', string>;
    const agreementPublic = fromBase64Url(stored.agreement),
      signingPublic = fromBase64Url(stored.signing),
      vapidPublic = fromBase64Url(stored.vapid);
    return {
      agreement: {
        privateKey: await importAgreementPrivateKey(fromBase64Url(secret.agreement)),
        publicKey: await importAgreementPublicKey(agreementPublic),
      },
      agreementPublic,
      signing: {
        privateKey: await importSigningPrivateKey(fromBase64Url(secret.signing)),
        publicKey: await importSigningPublicKey(signingPublic),
      },
      signingPublic,
      vapid: {
        privateKey: await importSigningPrivateKey(fromBase64Url(secret.vapid)),
        publicKey: await importSigningPublicKey(vapidPublic),
      },
      vapidPublic,
    };
  }
  private async createKeys(): Promise<RemoteKeys> {
    const agreement = await generateAgreementKey(true),
      signing = await generateSigningKey(true),
      vapid = await generateSigningKey(true);
    const keys = {
      agreement,
      agreementPublic: await exportPublicKey(agreement.publicKey),
      signing,
      signingPublic: await exportPublicKey(signing.publicKey),
      vapid,
      vapidPublic: await exportPublicKey(vapid.publicKey),
    };
    this.data.keys = {
      secret: this.codec.encrypt(
        JSON.stringify({
          agreement: toBase64Url(await exportPrivateKey(agreement.privateKey)),
          signing: toBase64Url(await exportPrivateKey(signing.privateKey)),
          vapid: toBase64Url(await exportPrivateKey(vapid.privateKey)),
        }),
      ),
      agreement: toBase64Url(keys.agreementPublic),
      signing: toBase64Url(keys.signingPublic),
      vapid: toBase64Url(keys.vapidPublic),
    };
    // New keys make the paired phones unreachable: they know the old key.
    this.data.devices = [];
    this.save();
    return keys;
  }
}

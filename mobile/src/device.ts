// Phone capabilities: push notifications, Face ID / fingerprint, the camera for scanning the pairing QR code.
import { fromBase64Url, toBase64Url } from '../../shared/remote/crypto';
import { readPairingUrl, type PairingLink } from '../../shared/remote/protocol';
import { translate } from '../../shared/i18n';
import { connection } from './connection';

export const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
/** Opened from the home screen (not a browser tab). iOS delivers web push only then. */
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

// ---------- Push ----------

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/**
 * Each computer signs its pushes with its own key, and a service worker registration holds one subscription, so each
 * computer gets a registration of its own (scope /p/<room>/). The worker script is the same.
 */
async function registration(room: string) {
  return navigator.serviceWorker.register('/sw.js', { scope: `/p/${room}/` });
}

export async function enablePush() {
  const room = connection.state.computer?.room;
  if (!room) throw new Error(translate('还没有连上电脑'));
  if (!pushSupported()) throw new Error(translate('这个浏览器不支持通知'));
  if (isIos() && !isStandalone()) throw new Error(translate('请先添加到主屏幕，再从主屏幕打开后开启通知'));
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(translate('没有获得通知权限，请在系统设置里允许'));
  const worker = await registration(room);
  await navigator.serviceWorker.ready;
  const { key } = await connection.call('push.key');
  let subscription = await worker.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  subscription = await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(key),
  });
  const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await connection.call('push.subscribe', { endpoint: json.endpoint, keys: json.keys });
}

export async function disablePush() {
  const room = connection.state.computer?.room;
  if (room && 'serviceWorker' in navigator) {
    const worker = await navigator.serviceWorker.getRegistration(`/p/${room}/`);
    await (await worker?.pushManager.getSubscription())?.unsubscribe();
  }
  await connection.call('push.unsubscribe');
}

// ---------- Face ID / fingerprint (WebAuthn) ----------

export const verifySupported = () => 'credentials' in navigator && typeof PublicKeyCredential !== 'undefined';

export async function enableVerify() {
  const options = await connection.call('verify.begin');
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64Url(options.challenge),
      rp: { id: location.hostname, name: 'AelionBot' },
      user: { id: fromBase64Url(options.userId), name: options.userName, displayName: options.userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'discouraged',
      },
      timeout: 60_000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error(translate('没有完成验证'));
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey?.();
  if (!publicKey) throw new Error(translate('这台手机不支持通行密钥'));
  await connection.call('verify.register', {
    credentialId: toBase64Url(new Uint8Array(credential.rawId)),
    publicKey: toBase64Url(new Uint8Array(publicKey)),
    clientData: toBase64Url(new Uint8Array(response.clientDataJSON)),
    rpId: location.hostname,
  });
}

/** Answers the computer's challenge when it asks this phone to verify before connecting. */
export async function unlock() {
  const verify = connection.state.welcome?.verify;
  if (!verify) return;
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64Url(verify.challenge),
      rpId: verify.rpId,
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(verify.credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error(translate('没有完成验证'));
  const response = credential.response as AuthenticatorAssertionResponse;
  await connection.call('verify.unlock', {
    authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
    clientData: toBase64Url(new Uint8Array(response.clientDataJSON)),
    signature: toBase64Url(new Uint8Array(response.signature)),
  });
}

// ---------- Pairing QR code ----------

/** A pairing link from a scanned or pasted text. */
export function pairingFrom(text: string): PairingLink | undefined {
  const hash = text.includes('#') ? text.slice(text.indexOf('#')) : text;
  return readPairingUrl(hash);
}

/** Scans the camera until a pairing QR code shows up. `stop` ends it early. */
export function scanPairing(video: HTMLVideoElement, found: (link: PairingLink) => void) {
  let stream: MediaStream | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false;
  const canvas = document.createElement('canvas'),
    context = canvas.getContext('2d', { willReadFrequently: true })!;
  let decode: typeof import('jsqr').default | undefined;
  const tick = () => {
    if (stopped || !decode) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const code = decode(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, {
        inversionAttempts: 'dontInvert',
      });
      const link = code?.data ? pairingFrom(code.data) : undefined;
      if (link) {
        stop();
        found(link);
        return;
      }
    }
    timer = setTimeout(tick, 250);
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream?.getTracks() || []) track.stop();
  };
  const started = navigator.mediaDevices
    .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then(async (media) => {
      if (stopped) return media.getTracks().forEach((track) => track.stop());
      stream = media;
      // The QR decoder loads with the camera, not with the app.
      decode = (await import('jsqr')).default;
      video.srcObject = media;
      await video.play();
      tick();
    });
  return { stop, started };
}

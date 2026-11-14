/** Settings → 手机访问: what the desktop shows about phone access. */
interface RemoteDeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
  online: boolean;
  push: boolean;
  verify: boolean;
}
export interface RemoteView {
  enabled: boolean;
  /** The relay and phone app in use; the official ones unless the user set their own. */
  relayUrl: string;
  appUrl: string;
  /** What the user typed, empty when the official addresses are used. */
  customRelayUrl: string;
  customAppUrl: string;
  status: 'off' | 'connecting' | 'online' | 'error';
  issue?: string;
  /** The computer's name on the phone. */
  name: string;
  /** Keep the computer from sleeping while phone access is on. */
  keepAwake: boolean;
  devices: RemoteDeviceView[];
  /** A pairing in progress: its QR code, and a phone waiting to be allowed. */
  pairing?: { url: string; qrSvg: string; expiresAt: string; request?: { name: string } };
}
export interface RemoteSettingsInput {
  enabled?: boolean;
  relayUrl?: string;
  appUrl?: string;
  name?: string;
  keepAwake?: boolean;
}

// A direct connection to the computer when the phone can reach it (the same Wi-Fi, or networks STUN can traverse):
// the phone offers a WebRTC data channel through the relayed channel; once it opens, both sides move their frames onto
// it. If it never opens the phone simply stays on the relay; if it breaks later, the phone reconnects through the relay.
import type { RemoteClient } from '../../shared/remote/client';
import type { RemoteMethod, RemoteParams, RemoteResult } from '../../shared/remote/protocol';

const OPEN_MS = 10_000;
/** Frames are up to about 192 KiB; a data channel that cannot carry them is not used. */
const FRAME_LIMIT = 200 * 1024;

export async function tryDirect(input: {
  client: RemoteClient;
  relay: string;
  /** The direct connection broke after it was in use. */
  broke(): void;
  call<M extends RemoteMethod>(method: M, params: RemoteParams<M>): Promise<RemoteResult<M>>;
  onCandidate(handler: (candidate: RTCIceCandidateInit) => void): () => void;
}) {
  if (typeof RTCPeerConnection === 'undefined') return;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${new URL(input.relay).hostname}:3478` }] });
  const channel = pc.createDataChannel('aelion', { ordered: true });
  channel.binaryType = 'arraybuffer';
  const off = input.onCandidate((candidate) => void pc.addIceCandidate(candidate).catch(() => {}));
  let opened = false,
    closing = false;
  // Closed on purpose (the connection ended): not a broken direct connection.
  const close = () => {
    closing = true;
    off();
    pc.close();
  };
  pc.onicecandidate = (event) => {
    if (event.candidate)
      void input.call('direct.candidate', event.candidate.toJSON() as { candidate: string }).catch(() => {});
  };
  channel.onopen = () => {
    if ((pc.sctp?.maxMessageSize ?? FRAME_LIMIT) < FRAME_LIMIT) return close();
    opened = true;
    input.client.attachDirect({ send: (frame) => channel.send(frame as Uint8Array<ArrayBuffer>), close });
  };
  channel.onmessage = (event) => input.client.receiveDirect(new Uint8Array(event.data as ArrayBuffer));
  channel.onclose = () => {
    off();
    if (!opened || closing) return;
    input.broke();
    input.client.directClosed();
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const { sdp } = await input.call('direct.offer', { sdp: offer.sdp || '' });
    await pc.setRemoteDescription({ type: 'answer', sdp });
  } catch {
    return close();
  }
  setTimeout(() => {
    if (!opened) close();
  }, OPEN_MS);
}

// The hidden window that answers phones' direct connections: WebRTC lives in Chromium, not in the main process. It only
// moves bytes between a data channel and the main process; the frames stay end-to-end encrypted.
import { ipcRenderer } from 'electron';

const peers = new Map<string, { pc: RTCPeerConnection; channel?: RTCDataChannel }>();
const closed = (id: string) => {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  peer.pc.close();
  ipcRenderer.send('remote-direct:close', { id });
};

ipcRenderer.on(
  'remote-direct:answer',
  async (_event, input: { id: string; sdp: string; iceServers: RTCIceServer[] }) => {
    const pc = new RTCPeerConnection({ iceServers: input.iceServers });
    peers.set(input.id, { pc });
    pc.onicecandidate = (event) => {
      if (event.candidate)
        ipcRenderer.send('remote-direct:candidate', { id: input.id, candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closed(input.id);
    };
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      const peer = peers.get(input.id);
      if (peer) peer.channel = channel;
      channel.onopen = () => ipcRenderer.send('remote-direct:open', { id: input.id });
      channel.onmessage = (message) =>
        ipcRenderer.send('remote-direct:frame', { id: input.id, data: new Uint8Array(message.data as ArrayBuffer) });
      channel.onclose = () => closed(input.id);
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: input.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ipcRenderer.send('remote-direct:answered', { id: input.id, sdp: answer.sdp });
    } catch (error) {
      ipcRenderer.send('remote-direct:answered', { id: input.id, error: (error as Error).message });
      closed(input.id);
    }
  },
);
ipcRenderer.on('remote-direct:candidate', (_event, input: { id: string; candidate: RTCIceCandidateInit }) => {
  void peers
    .get(input.id)
    ?.pc.addIceCandidate(input.candidate)
    .catch(() => {});
});
ipcRenderer.on('remote-direct:send', (_event, input: { id: string; data: Uint8Array }) => {
  const channel = peers.get(input.id)?.channel;
  if (channel?.readyState === 'open') channel.send(input.data as Uint8Array<ArrayBuffer>);
});
ipcRenderer.on('remote-direct:close', (_event, input: { id: string }) => closed(input.id));

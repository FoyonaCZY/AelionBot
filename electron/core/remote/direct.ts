// Direct connections to phones (WebRTC data channels), offered by a phone through the relayed channel. The main
// process has no WebRTC, so the app answers them in a hidden window (electron/windows/remote-direct.ts); tests pass
// in-memory pairs. Frames on a direct connection are the same end-to-end encrypted frames as through the relay.

export interface DirectCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}
export interface DirectHandlers {
  candidate(candidate: DirectCandidate): void;
  open(): void;
  frame(data: Uint8Array): void;
  close(): void;
}
export interface DirectPeers {
  /** Answers a phone's offer; returns the answer SDP. Candidates and channel events arrive through `handlers`. */
  answer(id: string, sdp: string, iceServers: Array<{ urls: string }>, handlers: DirectHandlers): Promise<string>;
  candidate(id: string, candidate: DirectCandidate): void;
  send(id: string, data: Uint8Array): void;
  close(id: string): void;
}

/** A STUN server on the relay's host (relay/deploy runs one), so phones outside the network can find a path too. */
export function stunFor(relayUrl: string) {
  try {
    return [{ urls: `stun:${new URL(relayUrl).hostname}:3478` }];
  } catch {
    return [];
  }
}

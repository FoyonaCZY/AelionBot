// Which way a connection's frames travel: through the relay, then, once both sides switched, over a direct
// connection on the same network. The channel's nonces are counters, so frames must stay in order across the switch:
// a side sends a `switch` marker as its last relayed frame, and the other side reads the relay up to that marker and
// the direct connection after it (holding direct frames that arrive early).
import type { Wire } from './wire';

export interface DirectLink {
  send(frame: Uint8Array): void;
  close(): void;
}

export class Paths {
  private output: (frame: Uint8Array) => void;
  private reading: 'relay' | 'direct' = 'relay';
  private readonly early: Uint8Array[] = [];
  private link?: DirectLink;
  private sending = false;

  constructor(
    relay: (frame: Uint8Array) => void,
    private readonly deliver: (frame: Uint8Array) => void,
  ) {
    this.output = relay;
  }

  /** Whether either direction already runs over the direct connection. */
  get direct() {
    return this.sending || this.reading === 'direct';
  }

  send = (frame: Uint8Array) => this.output(frame);

  fromRelay(frame: Uint8Array) {
    if (this.reading === 'relay') this.deliver(frame);
  }

  fromDirect(frame: Uint8Array) {
    if (this.reading === 'direct') this.deliver(frame);
    else this.early.push(frame.slice());
  }

  /** The other side's marker was read: its frames come over the direct connection from now on. */
  peerSwitched() {
    this.reading = 'direct';
    for (const frame of this.early.splice(0)) this.deliver(frame);
  }

  /** Sends this side's marker through the relay, then every later frame over `link`. */
  switchTo(wire: Wire, link: DirectLink) {
    this.link = link;
    wire.sendJson({ t: 'switch' }, () => {
      this.output = (frame) => link.send(frame);
      this.sending = true;
    });
  }

  close() {
    this.link?.close();
    this.link = undefined;
  }
}

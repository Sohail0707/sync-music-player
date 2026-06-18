// sync.ts — shared clock estimation for synchronized playback.
//
// Each device has its own wall clock (Date.now()) that may be off by hundreds of ms.
// To play in sync we need the listener to know the HOST's clock. We estimate the offset
// with a tiny NTP-style ping/pong and keep the sample from the lowest round-trip (the
// least network-jittered, most accurate one).

export class SyncClock {
  /** hostTime ≈ Date.now() + offset */
  offset = 0;
  private bestRtt = Infinity;
  synced = false;

  /** Feed one ping/pong round: c0 = ping sent, h = host clock at receipt, c2 = pong received. */
  sample(c0: number, h: number, c2: number) {
    const rtt = c2 - c0;
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = h - (c0 + rtt / 2); // assume symmetric latency
      this.synced = true;
    }
  }

  /** Best estimate of the host's clock right now. */
  hostNow() {
    return Date.now() + this.offset;
  }
}

// Transport state the host broadcasts; listeners reconstruct playback from it.
export interface SyncState {
  t: 'state';
  key: string | null; // current track key (null = nothing loaded)
  pos: number; // playback position in seconds when sampled
  playing: boolean;
  h: number; // host clock (Date.now()) when sampled
}

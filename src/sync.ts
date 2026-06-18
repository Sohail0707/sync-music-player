// sync.ts — shared clock estimation for synchronized playback.
//
// Each device has its own wall clock (Date.now()) that may be off by hundreds of ms.
// To play in sync we need the listener to know the HOST's clock. We estimate the offset
// with a tiny NTP-style ping/pong and keep the sample from the lowest round-trip (the
// least network-jittered, most accurate one).

interface Sample {
  rtt: number;
  offset: number;
  at: number;
}

export class SyncClock {
  /** hostTime ≈ Date.now() + offset */
  offset = 0;
  synced = false;

  // Keep a rolling window of recent ping/pong samples. We pick the offset from the
  // lowest-latency sample WITHIN the window — old samples age out, so the estimate
  // tracks clock drift over a long session instead of freezing to an all-time best.
  private samples: Sample[] = [];
  private readonly windowMs = 60_000;

  /** Feed one ping/pong round: c0 = ping sent, h = host clock at receipt, c2 = pong received. */
  sample(c0: number, h: number, c2: number) {
    const rtt = c2 - c0;
    const now = Date.now();
    this.samples.push({ rtt, offset: h - (c0 + rtt / 2), at: now }); // symmetric-latency assumption
    this.samples = this.samples.filter((s) => now - s.at <= this.windowMs);

    // Lowest-RTT recent sample = least network-jittered = most trustworthy.
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.synced = true;
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

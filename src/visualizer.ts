// visualizer.ts
// -----------------------------------------------------------------------------
// Real-time audio spectrum visualizer.
//
// Unlike the old CSS "bouncing bars" (which were faked with keyframes), this reads
// LIVE frequency data from a Web Audio AnalyserNode and paints it on a <canvas>:
//   • Host:     analyser is tapped off the playback graph (MediaElementSource).
//   • Listener: analyser is tapped off the incoming WebRTC MediaStream.
// So the bars actually move with the music — bass on the left, treble on the right.
// -----------------------------------------------------------------------------

export class Visualizer {
  private c2d: CanvasRenderingContext2D;
  private analyser: AnalyserNode | null = null;
  private freq = new Uint8Array(0);
  private raf = 0;
  private readonly BARS = 56;

  constructor(private canvas: HTMLCanvasElement) {
    this.c2d = canvas.getContext('2d', { alpha: true })!;
  }

  /** Wire the analyser whose data we'll draw. */
  connect(analyser: AnalyserNode) {
    analyser.fftSize = 256; // 128 frequency bins — plenty for a compact bar view
    analyser.smoothingTimeConstant = 0.8; // gentle smoothing so bars don't jitter
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
  }

  start() {
    if (!this.raf) this.raf = requestAnimationFrame(this.draw);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    this.c2d.clearRect(0, 0, w, h);
  }

  /** Keep the backing store matched to the CSS size (crisp on retina). */
  private fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private draw = () => {
    this.raf = requestAnimationFrame(this.draw);
    if (!this.analyser) return;

    this.fit();
    this.analyser.getByteFrequencyData(this.freq);

    const ctx = this.c2d;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    // Center-anchored mirrored bars (waveform look). Orange (bass) -> purple (treble).
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#ff6b2c');
    grad.addColorStop(0.6, '#ff8a3d');
    grad.addColorStop(1, '#a78bfa');
    ctx.fillStyle = grad;

    const gap = 3;
    const bw = (w - (this.BARS - 1) * gap) / this.BARS;
    // Use the lower ~70% of bins — the top bins are mostly empty for music.
    const usable = Math.floor(this.freq.length * 0.7);

    for (let i = 0; i < this.BARS; i++) {
      const v = this.freq[Math.floor((i / this.BARS) * usable)] / 255;
      const bh = Math.max(bw, v * v * h * 0.92); // square the value for punchier dynamics
      const x = i * (bw + gap);
      const r = bw / 2;
      roundRect(ctx, x, mid - bh / 2, bw, bh, r);
      ctx.fill();
    }
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

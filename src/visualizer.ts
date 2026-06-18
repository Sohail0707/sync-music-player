// visualizer.ts
// -----------------------------------------------------------------------------
// Platform-agnostic visualizer — NO Web Audio.
//
// Earlier this used an AnalyserNode, which forced audio through an AudioContext. That
// breaks background playback on iOS and makes mobile audio jittery. So instead we draw a
// lively equalizer from layered sine waves on a <canvas>: it animates while playing and
// eases to calm when paused. Not literally frequency-reactive, but smooth and identical on
// iPhone, Android and desktop — and it never touches the audio path.
// -----------------------------------------------------------------------------

export class Visualizer {
  private c2d: CanvasRenderingContext2D;
  private raf = 0;
  private t = 0;
  private intensity = 0; // eases toward `target`
  private target = 0; // 1 = playing, 0 = paused
  private readonly BARS = 48;

  constructor(private canvas: HTMLCanvasElement) {
    this.c2d = canvas.getContext('2d', { alpha: true })!;
  }

  start() {
    this.target = 1;
    if (!this.raf) this.raf = requestAnimationFrame(this.draw);
  }

  stop() {
    this.target = 0; // ease down to calm, the loop self-stops when fully settled
    if (!this.raf) this.raf = requestAnimationFrame(this.draw);
  }

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
    this.fit();
    const ctx = this.c2d;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    this.intensity += (this.target - this.intensity) * 0.08; // smooth ease
    this.t += 0.045;

    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#ff6b2c');
    grad.addColorStop(0.6, '#ff8a3d');
    grad.addColorStop(1, '#a78bfa');
    ctx.fillStyle = grad;

    const gap = 3;
    const bw = (w - (this.BARS - 1) * gap) / this.BARS;
    for (let i = 0; i < this.BARS; i++) {
      // Layered sines give an organic, non-repeating equalizer motion.
      const n =
        (Math.sin(this.t + i * 0.5) * 0.5 + 0.5) *
        (Math.sin(this.t * 0.7 + i * 0.23) * 0.4 + 0.6);
      const bh = Math.max(bw, n * h * 0.9 * this.intensity);
      roundRect(ctx, i * (bw + gap), mid - bh / 2, bw, bh, bw / 2);
      ctx.fill();
    }

    if (this.intensity < 0.01 && this.target === 0) {
      this.raf = 0;
      ctx.clearRect(0, 0, w, h);
      return;
    }
    this.raf = requestAnimationFrame(this.draw);
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

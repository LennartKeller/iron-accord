/**
 * Plays the game's sound effects through Web Audio.
 *
 * Files are fetched and decoded the first time they are asked for, then kept.
 * A browser will not start audio before the person has touched the page, so
 * `unlock()` is called from the first gesture and anything requested earlier
 * is simply not heard.
 */
export interface PlayOptions {
  /** Cut the sound off, with a short fade, after this long. Movement loops run for seconds. */
  maxSeconds?: number;
  /** 0..1, on top of the master volume. */
  gain?: number;
}

export class SoundPlayer {
  enabled = true;
  volume = 0.45;

  private readonly urlFor: (file: string) => string;
  private context: AudioContext | null = null;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  /** When each file last started, to keep a burst of the same sound from stacking. */
  private readonly lastStart = new Map<string, number>();

  constructor(urlFor: (file: string) => string) {
    this.urlFor = urlFor;
  }

  unlock(): void {
    if (!this.enabled) return;
    try {
      this.context ??= new AudioContext();
      if (this.context.state === 'suspended') void this.context.resume();
    } catch {
      // No audio on this device; stay silent.
    }
  }

  private load(file: string): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(file);
    if (!pending) {
      const context = this.context!;
      pending = fetch(this.urlFor(file))
        .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status))))
        .then(bytes => context.decodeAudioData(bytes))
        .catch(() => null);   // a missing sound is not worth a message
      this.buffers.set(file, pending);
    }
    return pending;
  }

  play(file: string, options: PlayOptions = {}): void {
    const context = this.context;
    if (!this.enabled || !context || context.state !== 'running') return;
    const now = context.currentTime;
    if (now - (this.lastStart.get(file) ?? -1) < 0.06) return;
    this.lastStart.set(file, now);

    void this.load(file).then(buffer => {
      if (!buffer || !this.enabled) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      const level = this.volume * (options.gain ?? 1);
      const start = context.currentTime;
      gain.gain.setValueAtTime(level, start);
      const length = Math.min(buffer.duration, options.maxSeconds ?? buffer.duration);
      if (length < buffer.duration) {
        const fade = Math.min(0.12, length / 2);
        gain.gain.setValueAtTime(level, start + length - fade);
        gain.gain.linearRampToValueAtTime(0, start + length);
      }
      source.connect(gain).connect(context.destination);
      source.start(start);
      source.stop(start + length);
    });
  }
}

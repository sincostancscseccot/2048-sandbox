import type { SoundKind } from './feedback';
import { slideDuration } from './motion';

type Tone = { frequency: number; end?: number; delay: number; duration: number; gain: number; wave?: OscillatorType };
const notes = (frequencies: number[], spacing = 0.06, duration = 0.16): Tone[] => frequencies.map((frequency, i) => ({ frequency, delay: i * spacing, duration, gain: 0.13 }));
export function soundNotes(kind: SoundKind): Tone[] {
  switch (kind) {
    case 'move': return [{ frequency: 190, end: 85, delay: 0, duration: 0.09, gain: 0.09, wave: 'triangle' }];
    case 'merge': return notes([440, 660]).map(tone => ({ ...tone, delay: tone.delay + slideDuration / 1000 }));
    case 'undo': return notes([440, 294], 0.07);
    case 'skill': return notes([392, 523], 0.04);
    case 'edit': return notes([330, 440], 0.04, 0.12);
    case 'start': return notes([330, 440, 554], 0.045, 0.12);
    case 'win': return notes([523, 659, 784, 1047], 0.07, 0.25);
    case 'loss': return notes([330, 262, 196], 0.09, 0.18);
    case 'blocked': return [{ frequency: 150, end: 110, delay: 0, duration: 0.05, gain: 0.05 }];
  }
}

/** Original synthesized effects: no downloads, autoplay, or game random draws. */
export class GameSound {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = false;
  private volume = 0;
  private active = new Set<{ oscillator: OscillatorNode; envelope: GainNode }>();
  constructor(private createContext: () => AudioContext = () => new AudioContext()) {}
  configure(enabled: boolean, volume: number) {
    this.enabled = enabled; this.volume = Math.max(0, Math.min(100, volume)) / 100;
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.015);
    if (!enabled || !this.volume) this.stop();
  }
  async unlock(): Promise<boolean> {
    if (!this.enabled || !this.volume) return false;
    try {
      if (!this.context) {
        this.context = this.createContext(); this.master = this.context.createGain();
        this.master.gain.value = this.volume; this.master.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context.state === 'running';
    } catch { return false; }
  }
  play(kind: SoundKind): boolean {
    const context = this.context;
    if (!this.enabled || !this.volume || !context || context.state !== 'running' || !this.master) return false;
    // Bound concurrent voices on rapid keys; muting stops scheduled notes too.
    if (this.active.size > 8) this.stop();
    for (const tone of soundNotes(kind)) {
      const oscillator = context.createOscillator(), envelope = context.createGain(), start = context.currentTime + tone.delay;
      oscillator.type = tone.wave ?? 'sine'; oscillator.frequency.setValueAtTime(tone.frequency, start);
      if (tone.end) oscillator.frequency.exponentialRampToValueAtTime(tone.end, start + tone.duration);
      envelope.gain.setValueAtTime(0, start); envelope.gain.linearRampToValueAtTime(tone.gain, start + 0.006);
      envelope.gain.exponentialRampToValueAtTime(0.001, start + tone.duration);
      oscillator.connect(envelope); envelope.connect(this.master);
      const entry = { oscillator, envelope }; this.active.add(entry);
      oscillator.onended = () => { this.active.delete(entry); oscillator.disconnect(); envelope.disconnect(); };
      oscillator.start(start); oscillator.stop(start + tone.duration + 0.02);
    }
    return true;
  }
  stop() { for (const entry of this.active) { try { entry.oscillator.stop(); } catch { /* already ended */ } entry.oscillator.disconnect(); entry.envelope.disconnect(); } this.active.clear(); }
  dispose() { this.stop(); this.master?.disconnect(); if (this.context) void this.context.close().catch(() => {}); this.context = null; this.master = null; }
}

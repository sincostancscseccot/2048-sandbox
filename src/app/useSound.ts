import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameFeedback } from '../presentation/feedback';
import { GameSound } from '../presentation/sound';

export function useSound(enabled: boolean, volume: number, feedback: GameFeedback | null) {
  const engine = useRef<GameSound | null>(null), delivered = useRef(0);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const sound = new GameSound(); engine.current = sound;
    const unlock = () => { if (document.visibilityState === 'visible') void sound.unlock(); };
    const visibility = () => { if (document.hidden) sound.stop(); };
    document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    document.addEventListener('keydown', unlock, { capture: true }); document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('pointerdown', unlock, true); document.removeEventListener('keydown', unlock, true); document.removeEventListener('visibilitychange', visibility); sound.dispose(); if (engine.current === sound) engine.current = null; };
  }, []);
  useEffect(() => { engine.current?.configure(enabled, volume); }, [enabled, volume]);
  useEffect(() => {
    if (!feedback || feedback.sequence <= delivered.current) return;
    delivered.current = feedback.sequence;
    if (!document.hidden) engine.current?.play(feedback.kind);
  }, [feedback]);
  const preview = useCallback(async () => {
    const sound = engine.current; if (!sound) return;
    const ready = await sound.unlock(); if (engine.current !== sound) return;
    setUnavailable(!ready); if (ready && !document.hidden) sound.play('merge');
  }, []);
  return { preview, unavailable };
}

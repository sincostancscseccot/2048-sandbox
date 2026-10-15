import { useEffect, useState } from 'react';
import { experienceKey, parseExperience, type ExperiencePreferences } from '../presentation/preferences';

export function useExperience() {
  const [preferences, setPreferences] = useState(() => { try { return parseExperience(localStorage.getItem(experienceKey)); } catch { return parseExperience(null); } });
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [persisted, setPersisted] = useState(true);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === experienceKey || event.key === null) setPreferences(parseExperience(event.newValue)); };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(experienceKey, JSON.stringify(preferences)); setPersisted(true); } catch { setPersisted(false); }
  }, [preferences]);
  function update(change: Partial<Omit<ExperiencePreferences, 'version'>>) {
    setPreferences(previous => parseExperience(JSON.stringify({ ...previous, ...change })));
  }
  return { preferences, update, reducedMotion, persisted, motion: preferences.motion && !reducedMotion };
}

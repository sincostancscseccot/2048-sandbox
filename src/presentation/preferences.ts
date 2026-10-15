export interface ExperiencePreferences { version: 1; motion: boolean; sound: boolean; decorations: boolean; volume: number }
export const experienceKey = '2048-sandbox:experience:v1';
export const defaultExperience: ExperiencePreferences = { version: 1, motion: true, sound: true, decorations: true, volume: 30 };

export function parseExperience(raw: string | null): ExperiencePreferences {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<ExperiencePreferences> | null;
    if (!value || value.version !== 1 || typeof value.motion !== 'boolean' || typeof value.sound !== 'boolean' || typeof value.decorations !== 'boolean' ||
      typeof value.volume !== 'number' || !Number.isInteger(value.volume) || value.volume < 0 || value.volume > 100) return { ...defaultExperience };
    return { version: 1, motion: value.motion, sound: value.sound, decorations: value.decorations, volume: value.volume };
  } catch { return { ...defaultExperience }; }
}

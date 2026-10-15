import type { ExperiencePreferences } from '../presentation/preferences';
import { Modal } from './Modal';

export function ExperienceSettings({ preferences, onChange, reducedMotion, persisted, unavailable, onPreview, onClose }: {
  preferences: ExperiencePreferences; onChange: (change: Partial<Omit<ExperiencePreferences, 'version'>>) => void;
  reducedMotion: boolean; persisted: boolean; unavailable: boolean; onPreview: () => Promise<void>; onClose: () => void;
}) {
  return <Modal title="动效、声音与外观" className="experience-modal" onClose={onClose}>
    <p className="muted">按自己的节奏玩。选择会记在当前浏览器，欢迎页和对局共用。</p>
    <div className="experience-options">{([
      ['motion', '滑动动画', '方块滑向目标，再显示合并与新数字；密集棋盘自动简化。'],
      ['sound', '游戏音效', '移动、合并、撤销、技能和胜负的轻量提示音。'],
      ['decorations', '氛围与光影', '纸色背景、棋盘柔光、方块质感和成绩变化提示。'],
    ] as const).map(([key, title, description]) => <div className="experience-option" key={key}><div><strong>{title}</strong><p>{description}</p></div>
      <button role="switch" aria-label={title} aria-checked={preferences[key]} className={`toggle-switch ${preferences[key] ? 'on' : ''}`} onClick={() => onChange({ [key]: !preferences[key] })}><span /><small>{preferences[key] ? '开' : '关'}</small></button></div>)}</div>
    <label className="experience-volume">音效音量 <output>{preferences.volume}%</output><input type="range" aria-label="音效音量" min="0" max="100" step="1" value={preferences.volume} disabled={!preferences.sound} onChange={event => onChange({ volume: Number(event.target.value) })} /></label>
    <div className="experience-preview"><button disabled={!preferences.sound || preferences.volume === 0} onClick={() => { void onPreview(); }}>♫ 试听合并音效</button><span className="muted">音效可离线使用，切到后台会停止播放。</span></div>
    {reducedMotion && <p className="muted" role="status">系统已启用“减少动态效果”，当前使用静态展示。</p>}
    {!persisted && <p className="muted" role="status">浏览器未能记住设置，本次使用仍然生效。</p>}
    {unavailable && <p className="muted" role="status">当前浏览器未能播放音效，游戏仍可正常操作。</p>}
    <p className="experience-note">这些开关只改变画面与声音，成绩、规则和历史记录保持原样。</p>
  </Modal>;
}

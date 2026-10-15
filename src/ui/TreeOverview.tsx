import { useEffect, useRef } from 'react';
import type { TreeLayout } from '../history/tree';

export function TreeOverview({ layout, camera, size, onCenter }: { layout: TreeLayout; camera: { x: number; y: number; zoom: number }; size: { width: number; height: number }; onCenter: (x: number, y: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d'); if (!ctx) return;
    const sx = 220 / layout.width, sy = 100 / layout.height;
    ctx.clearRect(0, 0, 220, 100); ctx.fillStyle = '#f7f9ef'; ctx.fillRect(0, 0, 220, 100); ctx.fillStyle = '#7f9a74';
    for (const point of layout.points) ctx.fillRect(point.x * sx, point.y * sy, Math.max(1, 128 * sx), Math.max(1.5, 54 * sy));
    ctx.strokeStyle = '#246747'; ctx.lineWidth = 2;
    ctx.strokeRect(camera.x * sx, camera.y * sy, Math.max(3, size.width / camera.zoom * sx), Math.max(3, size.height / camera.zoom * sy));
  }, [layout, camera, size]);
  return <canvas ref={canvas} className="tree-overview" data-testid="tree-overview" width={220} height={100} role="button" tabIndex={0} aria-label="历史树总览，点击定位，方向键移动视口"
    onPointerDown={event => { const rect = event.currentTarget.getBoundingClientRect(); onCenter(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * layout.width, Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * layout.height); }}
    onKeyDown={event => { const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const delta = offsets[event.key]; if (delta) { event.preventDefault(); onCenter(camera.x + size.width / camera.zoom * (.5 + delta[0] * .4), camera.y + size.height / camera.zoom * (.5 + delta[1] * .4)); } }} />;
}

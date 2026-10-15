import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react';
import type { Direction, GameState } from '../domain/types';
import type { CommittedTurn } from '../presentation/feedback';
import { maxAnimatedTiles, slideDuration, tileAppearance, traceSlide } from '../presentation/motion';

interface Props { state: GameState; nodeId: string; disabled: boolean; onMove: (direction: Direction) => void; onSelect?: ((index: number) => void) | undefined; selectedIndices?: number[];
  motion?: boolean; decorations?: boolean; turn?: CommittedTurn | null | undefined }

export function Board({ state, nodeId, disabled, onMove, onSelect, selectedIndices = [], motion = false, decorations = false, turn }: Props) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const board = useRef<HTMLDivElement>(null), ghosts = useRef<HTMLDivElement>(null);
  const cells = useRef<(HTMLElement | null)[]>([]), tiles = useRef(new Map<string, HTMLDivElement>());
  const animations = useRef(new Set<Animation>()), phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null), epoch = useRef(0);
  const previous = useRef<{ nodeId: string; state: GameState } | null>(null);
  const { rows, cols } = state.world.board, scrollable = cols > 8 || rows > 8;
  const stop = useCallback(() => {
    epoch.current++;
    if (phaseTimer.current !== null) clearTimeout(phaseTimer.current);
    for (const animation of animations.current) animation.cancel(); animations.current.clear();
    ghosts.current?.replaceChildren();
    if (board.current) board.current.dataset.animationPhase = 'idle';
  }, []);
  useEffect(() => {
    const element = board.current; if (!element) return;
    let width = element.clientWidth, height = element.clientHeight;
    const observer = new ResizeObserver(() => {
      if (width !== element.clientWidth || height !== element.clientHeight) { stop(); width = element.clientWidth; height = element.clientHeight; }
    }); observer.observe(element);
    return () => { observer.disconnect(); stop(); };
  }, [stop]);
  useLayoutEffect(() => {
    const old = previous.current; previous.current = { nodeId, state }; stop();
    if (!motion || !turn?.before || turn.toNodeId !== nodeId || old?.nodeId !== turn.fromNodeId || !board.current || !ghosts.current ||
      old.state.world.board.rows !== rows || old.state.world.board.cols !== cols ||
      turn.before.world.board.cells.filter(cell => cell.tile).length + state.world.board.cells.filter(cell => cell.tile).length > maxAnimatedTiles) return;
    const token = epoch.current, before = turn.before.world.board.cells;
    const oldPositions = new Map(before.flatMap((cell, index) => cell.tile ? [[cell.tile.id, index] as const] : []));
    const currentIds = new Set(state.world.board.cells.flatMap(cell => cell.tile ? [cell.tile.id] : []));
    const groups = turn.action?.type === 'move' ? traceSlide(turn.before, turn.rule.definition, turn.action.payload.direction) : [];
    const targets = new Map(groups.flatMap(group => group.sources.map(source => [source.tile.id, group.index] as const)));
    const merged = new Map(groups.filter(group => group.sources.length > 1).map(group => [group.index, group.value]));
    const bounds = ghosts.current.getBoundingClientRect(), rectangles = new Map<number, DOMRect>();
    const rect = (index: number) => { if (!rectangles.has(index)) { const cell = cells.current[index]; if (cell) rectangles.set(index, cell.getBoundingClientRect()); } return rectangles.get(index); };
    const run = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions, remove = false) => {
      const animation = element.animate(frames, options); animations.current.add(animation);
      void animation.finished.then(() => { animations.current.delete(animation); if (remove) element.remove(); }).catch(() => { animations.current.delete(animation); });
    };
    const sliding = turn.action?.type === 'move', delay = sliding ? slideDuration : 0;
    board.current.dataset.animationPhase = sliding ? 'sliding' : 'settling';
    // Retain consumed tiles just long enough to show both operands reaching the merge.
    for (const [id, from] of oldPositions) if (!currentIds.has(id)) {
      const source = rect(from), destination = rect(targets.get(id) ?? from), tile = before[from]!.tile!;
      if (!source || !destination) continue;
      const appearance = tileAppearance(tile.value), ghost = document.createElement('div'), number = document.createElement('span');
      ghost.className = `tile-visual tile-ghost level-${appearance.level} ${appearance.small ? 'small-value' : ''}`;
      ghost.dataset.tileId = id; ghost.dataset.fromIndex = String(from); ghost.dataset.toIndex = String(targets.get(id) ?? from);
      Object.assign(ghost.style, { position: 'absolute', left: `${source.left - bounds.left}px`, top: `${source.top - bounds.top}px`, width: `${source.width}px`, height: `${source.height}px` });
      number.className = 'tile-number'; number.textContent = appearance.text; ghost.append(number); ghosts.current.append(ghost);
      run(ghost, [{ transform:'translate(0, 0)', opacity:1 }, { transform:`translate(${destination.left - source.left}px, ${destination.top - source.top}px)`, opacity:sliding ? 1 : 0 }], { duration:slideDuration, easing:'cubic-bezier(.2,.75,.25,1)', fill:'forwards' }, true);
    }
    state.world.board.cells.forEach((cell, index) => {
      if (!cell.tile) return;
      const element = tiles.current.get(cell.tile.id), from = oldPositions.get(cell.tile.id), destination = rect(index);
      if (!element || !destination) return;
      element.dataset.fromIndex = String(from ?? index); element.dataset.toIndex = String(index);
      if (from !== undefined) {
        const source = rect(from); if (source && from !== index) run(element, [{ transform:`translate(${source.left - destination.left}px, ${source.top - destination.top}px)` }, { transform:'translate(0, 0)' }], { duration:slideDuration, easing:'cubic-bezier(.2,.75,.25,1)' });
      } else {
        const merge = merged.get(index) === cell.tile.value; element.dataset.appearance = merge ? 'merge' : 'spawn';
        run(element, [{ opacity:0, transform:`scale(${merge ? '.72' : '.4'})` }, { opacity:1, transform:`scale(${merge ? '1.14' : '1.04'})`, offset:.72 }, { opacity:1, transform:'scale(1)' }], { delay, duration:merge ? 180 : 145, easing:'ease-out', fill:'backwards' });
        if (merge && decorations) run(element, [{ boxShadow:'0 0 0 0 #92b86d00' }, { boxShadow:'0 0 0 7px #92b86d60', offset:.5 }, { boxShadow:'0 0 0 12px #92b86d00' }], { delay, duration:230 });
      }
    });
    if (sliding && animations.current.size) phaseTimer.current = setTimeout(() => { if (epoch.current === token && board.current) board.current.dataset.animationPhase = 'settling'; }, slideDuration);
    void Promise.allSettled([...animations.current].map(animation => animation.finished)).then(() => {
      if (epoch.current === token && board.current) { if (phaseTimer.current !== null) clearTimeout(phaseTimer.current); board.current.dataset.animationPhase = 'idle'; }
    });
    return stop;
  }, [state, nodeId, turn, motion, decorations, rows, cols, stop]);
  function down(event: PointerEvent<HTMLDivElement>) {
    if (disabled || onSelect || scrollable || !event.isPrimary || event.button !== 0) return;
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    const origin = start.current; start.current = null;
    if (!origin || disabled || origin.id !== event.pointerId) return;
    const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    onMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  }
  return <><div className="board-scroll"><div ref={board} className={`board visual-board ${onSelect ? 'selecting' : ''} ${cols > 6 || rows > 8 ? 'dense' : ''} ${scrollable ? 'scrollable' : ''}`} role="group" aria-label={`2048 棋盘，${rows} 行 ${cols} 列`} tabIndex={0}
    // Equal row tracks also keep the absolute tile layer aligned when some rows are empty.
    style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, aspectRatio:'auto', minWidth: cols > 8 ? `${cols * 42 + 20}px` : undefined }}
    aria-describedby="board-help" aria-disabled={disabled && !onSelect} data-testid="board" data-node-id={nodeId}
    onPointerDown={down} onPointerUp={up} onPointerCancel={() => { start.current = null; }}>
    {state.world.board.cells.map((cell, index) => {
      const value = cell.tile?.value;
      const CellElement = onSelect ? 'button' : 'div';
      return <CellElement key={index} ref={(element: HTMLElement | null) => { cells.current[index] = element; }} className={`cell ${selectedIndices.includes(index) ? 'target-selected' : ''}`}
        data-testid="cell" data-value={value ?? ''} aria-label={`第 ${Math.floor(index / cols) + 1} 行，第 ${index % cols + 1} 列：${value ?? '空'}`}
        type={onSelect ? 'button' : undefined} onClick={onSelect ? () => onSelect(index) : undefined} aria-pressed={onSelect ? selectedIndices.includes(index) : undefined} title={value ?? '空格'}>
      </CellElement>;
    })}
    <div className="tile-layer" aria-hidden="true">{state.world.board.cells.flatMap((cell, index) => {
      if (!cell.tile) return [];
      const tile = cell.tile, appearance = tileAppearance(tile.value);
      return [<div key={tile.id} ref={element => { if (element) tiles.current.set(tile.id, element); else tiles.current.delete(tile.id); }}
        className={`tile-visual level-${appearance.level} ${appearance.small ? 'small-value' : ''} ${selectedIndices.includes(index) ? 'target-selected' : ''}`}
        data-tile-id={tile.id} data-value={tile.value} style={{ gridColumn:index % cols + 1, gridRow:Math.floor(index / cols) + 1 }}><span className="tile-number">{appearance.text}</span></div>];
    })}</div>
    <div className="tile-ghosts" ref={ghosts} aria-hidden="true" />
  </div></div>{scrollable && <p className="board-scroll-hint">大棋盘可滚动查看；使用方向按钮或键盘移动。</p>}</>;
}

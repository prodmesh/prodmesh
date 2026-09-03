import { Activity } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { roomTopic, useTopic } from '../lib/stream';
import type { RtaState } from '../api';
import type { WidgetProps } from './types';

const tickHz = [20, 100, 1000, 10000, 20000];
const labelHz = (hz: number) => hz >= 1000 ? `${hz / 1000}k` : String(hz);
const logPosition = (hz: number) => (Math.log10(Math.max(20, Math.min(20000, hz))) - Math.log10(20)) / 3;

function Plot({ points, narrow }: { points: NonNullable<RtaState['points']>; narrow: boolean }) {
  const visible = points.filter((point) => point.hz >= 20 && point.hz <= 20000);
  if (!visible.length) return <p className="rta__empty">Waiting for spectrum data…</p>;
  const values = visible.map((point) => point.db);
  const low = Math.floor((Math.min(...values) - 2) / 10) * 10;
  const high = Math.max(low + 30, Math.ceil((Math.max(...values) + 2) / 10) * 10);
  const y = (db: number) => 92 - ((db - low) / (high - low)) * 78;
  const d = visible.map((point, index) => `${index ? 'L' : 'M'} ${(8 + logPosition(point.hz) * 88).toFixed(2)} ${y(point.db).toFixed(2)}`).join(' ');
  const horizontal = [low, (low + high) / 2, high];
  const labels = narrow ? [100, 1000, 10000] : tickHz;
  return (
    <svg className="rta__chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Live frequency spectrum from ${low} to ${high} dB`}>
      {horizontal.map((db) => <g key={db}><line className="rta__grid" x1="8" x2="96" y1={y(db)} y2={y(db)} /><text className="rta__db" x="0" y={y(db) + 2}>{Math.round(db)}</text></g>)}
      {labels.map((hz) => <g key={hz}><line className="rta__grid rta__grid--vertical" x1={8 + logPosition(hz) * 88} x2={8 + logPosition(hz) * 88} y1="8" y2="92" /><text className="rta__hz" x={8 + logPosition(hz) * 88} y="99">{labelHz(hz)}</text></g>)}
      <path className="rta__trace" d={d} />
    </svg>
  );
}

export function RtaWidget({ roomId, config }: WidgetProps) {
  const sourceRoomId = config.sourceRoomId ?? roomId;
  const rta = useTopic<RtaState | null>(roomTopic.rta(sourceRoomId));
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 300));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={root} className="wgt wgt--rta">
      <div className="wgt__head">
        <span className="wgt__icon"><Activity size={16} /></span>
        <span className="wgt__title">RTA spectrum</span>
        <span className={`rta__status ${rta?.connected ? 'rta__status--ok' : ''}`}>{rta?.connected ? 'Live' : 'Waiting'}</span>
      </div>
      {rta?.points ? <Plot points={rta.points} narrow={narrow} /> : <p className="rta__empty">Connect a ProdMesh RTA source to this room.</p>}
      <span className="rta__source">{rta ? `ProdMesh RTA · ${rta.source}` : sourceRoomId === roomId ? 'This room' : `Source room: ${sourceRoomId}`}</span>
    </div>
  );
}

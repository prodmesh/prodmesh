import { BarChart3 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { roomTopic, useTopic } from '../lib/stream';
import type { RtaState } from '../api';
import type { WidgetProps } from './types';

const ticks = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const providerName: Record<RtaState['provider'], string> = {
  'prodmesh-rta': 'ProdMesh RTA', smaart: 'Smaart', 'open-sound-meter': 'Open Sound Meter',
};
const labelHz = (hz: number) => hz >= 1000 ? `${hz / 1000}k` : String(hz);
const x = (hz: number) => 6 + ((Math.log2(Math.max(25, Math.min(20000, hz))) - Math.log2(25)) / (Math.log2(20000) - Math.log2(25))) * 92;

function Metric({ label, value }: { label: string; value: number | null }) {
  return <span className="rta__metric"><small>{label}</small><b>{value == null ? '—' : value.toFixed(1)}</b></span>;
}

function Plot({ points, narrow }: { points: RtaState['points']; narrow: boolean }) {
  const visible = points.filter((point) => point.hz >= 25 && point.hz <= 20000);
  const y = (db: number) => 91 - ((Math.max(60, Math.min(140, db)) - 60) / 80) * 78;
  const labels = narrow ? [125, 1000, 8000] : ticks;
  return (
    <svg className="rta__chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Live 1/3-octave frequency spectrum from 60 to 140 dB SPL">
      {[60, 80, 100, 120, 140].map((db) => <g key={db}><line className="rta__grid" x1="6" x2="98" y1={y(db)} y2={y(db)} /><text className="rta__db" x="0" y={y(db) + 2}>{db}</text></g>)}
      {labels.map((hz) => <g key={hz}><line className="rta__grid rta__grid--vertical" x1={x(hz)} x2={x(hz)} y1="13" y2="91" /><text className="rta__hz" x={x(hz)} y="98">{labelHz(hz)}</text></g>)}
      {visible.map((point) => {
        const width = Math.max(1, x(point.hz * 1.12) - x(point.hz / 1.12));
        return <rect className="rta__bar" key={point.hz} x={x(point.hz) - width / 2} y={y(point.db)} width={width} height={91 - y(point.db)} />;
      })}
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

  const name = rta ? providerName[rta.provider] : 'Audio analyzer';
  return (
    <div ref={root} className="wgt wgt--rta">
      <div className="wgt__head">
        <span className="wgt__icon"><BarChart3 size={16} /></span>
        <span className="wgt__title">{name} spectrum</span>
        <span className={`rta__status ${rta?.connected ? 'rta__status--ok' : ''}`}>{rta?.connected ? 'Live' : 'Waiting'}</span>
      </div>
      {rta?.metrics && <div className="rta__metrics"><Metric label="Fast" value={rta.metrics.fast} /><Metric label="Slow" value={rta.metrics.slow} /><Metric label="Leq" value={rta.metrics.leq} /></div>}
      {rta?.points.length ? <Plot points={rta.points} narrow={narrow} /> : <p className="rta__empty">{rta?.connected ? `${name} is connected, but it is not publishing spectrum bands.` : 'Waiting for the configured audio analyzer…'}</p>}
      <span className="rta__source">{rta ? `${name} · ${rta.source}${rta.metrics?.weighting ? ` · ${rta.metrics.weighting}-weighted` : ''}` : sourceRoomId === roomId ? 'This room’s analysis source' : `Source room: ${sourceRoomId}`}</span>
    </div>
  );
}

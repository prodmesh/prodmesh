import { useEffect, useRef, useState } from 'react';
import prodmeshRtaLogo from '../assets/integrations/prodmesh-rta.svg';
import { roomTopic, useTopic } from '../lib/stream';
import type { RtaState } from '../api';
import type { WidgetProps } from './types';

const ticks: Record<number, string> = { 31.5: '31', 63: '63', 125: '125', 250: '250', 500: '500', 1000: '1k', 2000: '2k', 4000: '4k', 8000: '8k', 16000: '16k' };
const providerName: Record<RtaState['provider'], string> = {
  'prodmesh-rta': 'ProdMesh RTA', smaart: 'Smaart', 'open-sound-meter': 'Open Sound Meter',
};
function Plot({ points, narrow, calibration }: { points: RtaState['points']; narrow: boolean; calibration: number | null | undefined }) {
  const visible = points.filter((point) => point.hz >= 25 && point.hz <= 20000);
  const max = calibration ?? 140;
  const min = max - 80;
  const y = (db: number) => 89 - ((Math.max(min, Math.min(max, db)) - min) / (max - min)) * 80;
  const grid = Array.from(
    { length: Math.floor((max - Math.ceil(min / 10) * 10) / 10) + 1 },
    (_, index) => Math.ceil(min / 10) * 10 + index * 10,
  );
  const slot = 90 / Math.max(visible.length, 1);
  return (
    <svg className="rta__chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Live 1/3-octave frequency spectrum from ${min} to ${max} dB SPL`}>
      <rect className="rta__frame" x="8" y="9" width="90" height="80" />
      {grid.map((db) => <g key={db}><line className="rta__grid" x1="8" x2="98" y1={y(db)} y2={y(db)} /><text className="rta__db" x="6" y={y(db) + 2}>{db}</text></g>)}
      {visible.map((point, index) => {
        const label = Object.entries(ticks).find(([hz]) => Math.abs(Number(hz) - point.hz) < 1)?.[1];
        const center = 8 + (index + .5) * slot;
        const barY = y(point.db);
        return <g key={point.hz}>
          {label && <line className="rta__grid rta__grid--vertical" x1={center} x2={center} y1="9" y2="89" />}
          <rect className="rta__bar" x={8 + index * slot + .35} y={barY} width={Math.max(.5, slot - .7)} height={89 - barY} />
          <rect className="rta__bar-top" x={8 + index * slot + .35} y={barY} width={Math.max(.5, slot - .7)} height=".7" />
          {point.peak != null && <rect className="rta__peak" x={8 + index * slot + .35} y={y(point.peak)} width={Math.max(.5, slot - .7)} height=".8" />}
          {label && (!narrow || ['125', '1k', '8k'].includes(label)) && <text className="rta__hz" x={center} y="97">{label}</text>}
        </g>;
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
        <img className="rta__logo" src={prodmeshRtaLogo} alt="ProdMesh RTA" />
        <span className="wgt__title">{name}</span>
        <span className={`rta__status ${rta?.connected ? 'rta__status--ok' : ''}`}>{rta?.connected ? 'Live' : 'Waiting'}</span>
      </div>
      {rta?.points.length ? <Plot points={rta.points} narrow={narrow} calibration={rta.metrics?.calibration} /> : <p className="rta__empty">{rta?.connected ? `${name} is connected, but it is not publishing spectrum bands.` : 'Waiting for the configured audio analyzer…'}</p>}
      <span className="rta__source">{rta ? `${name} · ${rta.source}${rta.metrics?.weighting ? ` · ${rta.metrics.weighting}-weighted` : ''}` : sourceRoomId === roomId ? 'This room’s analysis source' : `Source room: ${sourceRoomId}`}</span>
    </div>
  );
}

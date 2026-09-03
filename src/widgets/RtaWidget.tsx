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
  // These are the native RTA widget's canvas margins: 40/10/10/24 px.
  // The 500×280 coordinate plane keeps those proportions responsive here.
  const left = 40, right = 10, top = 10, bottom = 24;
  const width = 500 - left - right, height = 280 - top - bottom;
  const y = (db: number) => top + height * (1 - ((Math.max(min, Math.min(max, db)) - min) / (max - min)));
  const grid = Array.from(
    { length: Math.floor((max - Math.ceil(min / 10) * 10) / 10) + 1 },
    (_, index) => Math.ceil(min / 10) * 10 + index * 10,
  );
  const slot = width / Math.max(visible.length, 1);
  return (
    <svg className="rta__chart" viewBox="0 0 500 280" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Live 1/3-octave frequency spectrum from ${min} to ${max} dB SPL`}>
      <rect className="rta__frame" x={left} y={top} width={width} height={height} />
      {grid.map((db) => <g key={db}><line className="rta__grid" x1={left} x2={left + width} y1={y(db)} y2={y(db)} /><text className="rta__db" textAnchor="end" dominantBaseline="middle" x={left - 6} y={y(db)}>{db}</text></g>)}
      {visible.map((point, index) => {
        const label = Object.entries(ticks).find(([hz]) => Math.abs(Number(hz) - point.hz) < 1)?.[1];
        const center = left + (index + .5) * slot;
        const barY = y(point.db);
        return <g key={point.hz}>
          {label && <line className="rta__grid rta__grid--vertical" x1={center} x2={center} y1={top} y2={top + height} />}
          <rect className="rta__bar" x={left + index * slot + 1} y={barY} width={Math.max(1, slot - 2)} height={top + height - barY} />
          <rect className="rta__bar-top" x={left + index * slot + 1} y={barY} width={Math.max(1, slot - 2)} height="2" />
          {point.peak != null && <rect className="rta__peak" x={left + index * slot + 1} y={y(point.peak)} width={Math.max(1, slot - 2)} height="2" />}
          {label && (!narrow || ['125', '1k', '8k'].includes(label)) && <text className="rta__hz" dominantBaseline="hanging" x={center} y={top + height + 4}>{label}</text>}
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
      </div>
      {rta?.points.length ? <Plot points={rta.points} narrow={narrow} calibration={rta.metrics?.calibration} /> : <p className="rta__empty">{rta?.connected ? `${name} is connected, but it is not publishing spectrum bands.` : 'Waiting for the configured audio analyzer…'}</p>}
    </div>
  );
}

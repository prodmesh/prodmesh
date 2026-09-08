import { CircleAlert, CircleCheck, Mic, Radio, Video } from 'lucide-react';
import { roomTopic, useTopic } from '../lib/stream';
import type { ObsStatus } from '../api';
import type { WidgetProps } from './types';

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}` : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function Health({ state }: { state: ObsStatus }) {
  if (!state.connected) return <span className="wgt__status">Offline</span>;
  if (state.droppedFramesPercent >= (state.droppedFramesWarning ?? 0.5)) return <span className="wgt__status wgt__status--warn">Attention</span>;
  return <span className="wgt__status wgt__status--live">Healthy</span>;
}

export function ObsHealthWidget({ roomId, config }: WidgetProps) {
  const state = useTopic<ObsStatus>(roomTopic.obs(roomId));
  if (!state) return <p className="wgt__empty">Checking OBS Studio…</p>;
  if (state.disabled) return <p className="wgt__empty">OBS Studio is disabled in Admin → Integrations.</p>;
  const warning = state.droppedFramesPercent >= (state.droppedFramesWarning ?? 0.5);
  return <section className="wgt obs-health">
    <div className="obs-health__state"><Health state={state} /></div>
    {!state.connected ? <div className="obs-health__offline"><CircleAlert size={22} /><strong>OBS disconnected</strong><span>{state.error ?? 'Check the host, port, and WebSocket password in this room’s Campus setup.'}</span></div> : <>
      <div className="obs-health__modes">
        <div><Radio size={15} /><span>Stream</span><strong className={state.streaming ? 'obs-health__on' : ''}>{state.streaming ? state.streamReconnecting ? 'Reconnecting' : duration(state.streamDurationMs) : 'Off'}</strong></div>
        <div><Video size={15} /><span>Record</span><strong className={state.recording ? 'obs-health__on' : ''}>{state.recording ? `${duration(state.recordDurationMs)}${state.recordingPaused ? ' · paused' : ''}` : 'Off'}</strong></div>
      </div>
      {config.obsPreview !== false && state.previewImageUrl && <img className="obs-health__preview" src={state.previewImageUrl} alt="OBS program preview" referrerPolicy="no-referrer" />}
      <div className="obs-health__primary">
        <div><span>Program scene</span><strong>{state.programScene ?? '—'}</strong></div>
        <div><span>FPS</span><strong>{state.activeFps == null ? '—' : state.activeFps.toFixed(1)}</strong></div>
        <div><span>Bitrate</span><strong>{state.bitrateKbps == null ? '—' : `${state.bitrateKbps.toLocaleString()} kbps`}</strong></div>
      </div>
      <div className="obs-health__telemetry">
        <div className={`obs-health__audio obs-health__audio--${state.audioStatus}`}><Mic size={15} /><span>{state.primaryAudioInput ?? 'Program audio'}</span><strong>{state.audioDb == null ? 'No signal' : `${state.audioDb.toFixed(1)} dB`}</strong></div>
        <div className={`obs-health__frames${warning ? ' obs-health__frames--warn' : ''}`}>{warning ? <CircleAlert size={14} /> : <CircleCheck size={14} />}<span>Dropped frames</span><strong>{state.droppedFrames.toLocaleString()} · {state.droppedFramesPercent.toFixed(2)}%</strong></div>
      </div>
      {config.obsDetails && <div className="obs-health__details"><span>CPU {state.cpuUsage == null ? '—' : `${state.cpuUsage.toFixed(1)}%`}</span><span>Disk {state.diskFreeGb == null ? '—' : `${state.diskFreeGb.toFixed(1)} GB free`}</span>{state.programSources.length > 0 && <span>{state.programSources.length} program sources</span>}</div>}
    </>}
  </section>;
}

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ObsHealthWidget } from './ObsHealthWidget';
import { emitTopic } from '../test/fakeEventSource';

const online = {
  configured: true, connected: true, streaming: true, recording: true,
  recordingPaused: false, streamDurationMs: 65_000, recordDurationMs: 125_000,
  activeFps: 59.94, bitrateKbps: 6_000, droppedFrames: 4,
  droppedFramesPercent: 0.02, droppedFramesWarning: 0.5,
  programScene: 'Sermon', programSources: ['Camera 1', 'Lower thirds'],
  audioDb: -18.2, audioStatus: 'active' as const, primaryAudioInput: 'Program',
  sourceOptions: ['Program'], cpuUsage: 7.2, diskFreeGb: 114.8,
  previewImageUrl: 'https://example.test/preview.jpg',
};

function show(config = {}) {
  return render(<ObsHealthWidget roomId="north-main" config={config} />);
}

describe('ObsHealthWidget', () => {
  it('renders operational telemetry without exposing any controls', async () => {
    const { container } = show({ obsDetails: true });
    emitTopic({ 'room:north-main:obs': online });
    expect(await screen.findByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Sermon')).toBeInTheDocument();
    expect(screen.getByText('6,000 kbps')).toBeInTheDocument();
    expect(screen.getByText('-18.2 dB')).toBeInTheDocument();
    expect(screen.getByText('CPU 7.2%')).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('makes an unavailable OBS connection understandable', async () => {
    show();
    emitTopic({ 'room:north-main:obs': { ...online, connected: false, error: 'OBS Studio could not be reached. Reconnecting…' } });
    expect(await screen.findByText('OBS disconnected')).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it('lets a dashboard hide the optional program preview', async () => {
    const { container } = show({ obsPreview: false });
    emitTopic({ 'room:north-main:obs': online });
    await screen.findByText('Sermon');
    expect(container.querySelector('.obs-health__preview')).toBeNull();
  });
});

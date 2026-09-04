import { CompanionSurface } from '../components/CompanionSurface';
import type { WidgetProps } from './types';

export function CompanionEmulatorWidget({ roomId }: WidgetProps) {
  return <CompanionSurface roomId={roomId} className="companion-surface--widget" />;
}

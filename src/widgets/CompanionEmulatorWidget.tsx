import { CompanionSurface } from '../components/CompanionSurface';
import { useCan } from '../lib/identity';
import type { WidgetProps } from './types';

// Pressing a Companion button through this surface does everything a room-mode
// change does and reports none of it, so the widget asks for the same authority
// rather than none. `rooms.mode.change` instead of a new permission: "may change
// this room" is the question being asked, and one more entry in Admin -> Users
// that every church has to understand is a worse answer than reusing it.
export function CompanionEmulatorWidget({ roomId }: WidgetProps) {
  if (!useCan('rooms.mode.change')) {
    return (
      <div className="companion-surface companion-surface--empty companion-surface--widget">
        <span>You do not have permission to operate this room&apos;s Companion.</span>
      </div>
    );
  }
  return <CompanionSurface roomId={roomId} className="companion-surface--widget" />;
}

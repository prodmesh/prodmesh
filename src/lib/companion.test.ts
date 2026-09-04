import { describe, expect, it } from 'vitest';
import { companionEmulatorUrl } from './companion';

describe('companionEmulatorUrl', () => {
  it('builds the documented emulator path from the room connection', () => {
    expect(companionEmulatorUrl('10.0.0.25', 8000, 'foh')?.href)
      .toBe('http://10.0.0.25:8000/emulator/foh');
  });

  it('uses Companion’s emulator picker when a room has not selected one', () => {
    expect(companionEmulatorUrl('companion.local')?.pathname).toBe('/emulator');
  });

  it('refuses malformed surface identifiers', () => {
    expect(companionEmulatorUrl('10.0.0.25', 8000, '../admin')).toBeNull();
  });
});

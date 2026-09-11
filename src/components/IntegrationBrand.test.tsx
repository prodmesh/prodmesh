import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationBrand, IntegrationTitle } from './IntegrationBrand';

// Beta means "not yet verified against real hardware or a real account by
// anyone here" (docs/STATE.md). The mark is the only thing on screen that says
// so, which is what makes it worth pinning.
describe('Beta integrations', () => {
  it.each(['resi', 'obs'] as const)('%s is marked Beta wherever it is titled', (integration) => {
    const { unmount } = render(<IntegrationTitle integration={integration}>Widgets</IntegrationTitle>);
    expect(screen.getByText('Beta')).toBeInTheDocument();
    unmount();

    render(<IntegrationBrand integration={integration} label />);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('a verified integration carries no mark', () => {
    render(<IntegrationTitle integration="propresenter">Widgets</IntegrationTitle>);
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });
});

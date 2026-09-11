import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollWithin } from './scrollWithin';

// jsdom has no layout, so geometry is stubbed: a container at `top` showing
// `height` px, scrolled to `scrollTop`, and a row at a viewport position.
function container(top: number, height: number, scrollTop = 0) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { value: height });
  Object.defineProperty(el, 'clientTop', { value: 0 });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true });
  el.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect;
  const scrollTo = vi.fn();
  el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
  return { el, scrollTo };
}

function row(top: number, height: number) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect;
  el.scrollIntoView = vi.fn();
  return el;
}

describe('scrollWithin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('moves only its own container, never the page (#36)', () => {
    const page = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const box = container(100, 200);
    const target = row(400, 40); // below the visible part
    scrollWithin(box.el, target);
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 140, behavior: 'auto' }); // bottom-aligned
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });

  it('leaves a row that is already fully visible where it is', () => {
    const box = container(100, 200);
    scrollWithin(box.el, row(150, 40));
    expect(box.scrollTo).not.toHaveBeenCalled();
  });

  it('brings a row above the view to the top edge', () => {
    const box = container(100, 200, 200);
    scrollWithin(box.el, row(60, 40));
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 160, behavior: 'auto' });
  });

  it('centres on request, and never scrolls above the start', () => {
    const box = container(100, 200);
    scrollWithin(box.el, row(400, 40), { block: 'center', behavior: 'smooth' });
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 220, behavior: 'smooth' });
    scrollWithin(box.el, row(110, 40), { block: 'center' });
    expect(box.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' });
  });
});

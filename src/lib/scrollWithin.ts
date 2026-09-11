// Scroll an element into view inside ONE scroll container, and nothing else.
//
// Element.scrollIntoView scrolls every scrollable ancestor, the page included.
// Widgets that follow ProPresenter's live slide called it on every advance, so
// with the widget scrolled off-screen each slide change dragged the whole
// dashboard back to it (#36). A widget owns its scroll box; the page belongs
// to the operator.

export type ScrollBlock = 'nearest' | 'center';

export function scrollWithin(
  container: HTMLElement,
  el: HTMLElement,
  { block = 'nearest', behavior = 'auto' }: { block?: ScrollBlock; behavior?: ScrollBehavior } = {},
): void {
  const box = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const viewTop = box.top + container.clientTop; // inside the border
  const viewBottom = viewTop + container.clientHeight;
  const offset = r.top - viewTop + container.scrollTop; // where it sits in the scrolled content

  let top: number | null;
  if (block === 'center') top = offset - (container.clientHeight - r.height) / 2;
  else if (r.top < viewTop) top = offset; // above: align with the top edge
  else if (r.bottom > viewBottom) top = offset - container.clientHeight + r.height; // below: the bottom edge
  else top = null; // already fully visible — leave it where the operator put it

  // Optional call: jsdom has no layout and may not implement scrollTo.
  if (top != null) container.scrollTo?.({ top: Math.max(0, top), behavior });
}

# UI text principles

How prodmesh writes on-screen words. Adopted 2026-07-15 after the Admin panels
accumulated explanatory paragraphs that age badly.

1. **Labels name; they don't explain.** If a control needs a sentence to be
   usable, the fix is a better label, not more prose.
2. **No intro paragraphs under panel titles.** The section label + title carry
   the context. Screens should read like a control surface, not a manual.
   Same for page-header subtitles: they carry data (campus name, service
   dates), never a description of what the page shows.
3. **Supplementary knowledge goes in a HelpTip** (`src/components/HelpTip.tsx`
   — the circular "?"). Good tooltip content: where to find an ID, what a term
   means, a non-obvious consequence. It must be *optional* reading.
4. **Must-know information is never tooltip-only.** Destructive consequences
   belong in the confirm dialog; errors and empty-state guidance stay inline.
5. **Write timeless.** No lists that grow stale ("configure its Quick Access
   tiles"), no "new"/"now", no feature inventories. Referencing implementation
   (file names, tables) is allowed only for clearly transitional dev notes that
   will be deleted with the migration they describe.
6. **Empty and loading states are short noun phrases.** "No rooms yet." /
   "Loading…" — not apologies or instructions.
7. **Status feedback is one word where possible.** "Saved." Present tense,
   no exclamation points.

## The one exception: first-run setup

`src/pages/Setup.tsx` is a guided flow, not a control surface, and it is the
only screen whose reader has never seen the app before. It may open a step with
a sentence of orientation (rules 1–2 are relaxed there). Everything else still
holds — supplementary knowledge goes in a HelpTip, must-know consequences stay
inline (the admin PIN's "resetting it means editing a file on the server"), and
the copy stays timeless. Note the step-title tips pass `place="below"`: a
tooltip above a title that near the top of the window is clipped by the
viewport.

## Words for places and boxes

Two things that are easy to blur, so the screen keeps them apart:

- **Campus**: a place with rooms. Admin → Campuses edits them; the sidebar
  filters by them. The code and stored config call this a `site`
  (`Church.sites`, a room's `site`) and keep doing so, because the name is in
  backups and API payloads; on screen it is always "campus".
- **Server**: one ProdMesh install. Pairing links servers (Admin → Linked
  servers), and the identity row says "this server". One server can run
  several campuses, so never say "campus" where the thing meant is the box.

Never write "site" on screen for either.

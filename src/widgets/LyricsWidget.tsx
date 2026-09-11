import { useEffect, useRef } from 'react';
import { Music } from 'lucide-react';
import { useTopic, roomTopic } from '../lib/stream';
import { scrollWithin } from '../lib/scrollWithin';
import type { RoomLyrics } from '../api';
import type { WidgetProps } from './types';

// The song ProPresenter has open, scrolled to where it is now.
//
// The reader is anybody who needs the line BEFORE it lands: a director calling
// a camera, a volunteer who has never heard the song, a musician whose stage
// screen shows only the slide already up. ProPresenter's own stage display
// answers "what is on screen"; the thing it cannot do is show you what is two
// lines away, which is the entire reason to build this.
//
// Sectioning is ProPresenter's own — the group names and the colours the
// operator assigned in the presentation everyone else in the room is looking
// at. Inventing a palette here would mean the dashboard and the projector
// disagree about which block is the chorus.
//
// Newest-at-bottom does NOT apply here the way it does to comms: a song is not
// a feed, it has a known length and a known end, and the useful frame is the
// current line centred with what is coming underneath it. That means a real
// scroll effect rather than column-reverse, and the price is that it fights
// anyone who scrolls back to reread. Accepted: unlike a transcript, scrolling
// back through a song you are currently in is not a thing people do.

/** Where the fade should sit. Section headers repeat per PLAY, not per section,
 *  so four back-to-back bridges each get their own "2 of 4" marker instead of
 *  one heading over twelve identical-looking lines. */
const opensRun = (s: RoomLyrics['slides'][number], prev?: RoomLyrics['slides'][number]) =>
  !prev || prev.section !== s.section || (prev.rep?.at ?? null) !== (s.rep?.at ?? null);

/** Within this many cues of the end, the end marker stops being a full stop
 *  and starts being a warning — which is the thing a director actually wants. */
const ENDGAME = 3;

export function LyricsWidget({ roomId }: WidgetProps) {
  const lyrics = useTopic<RoomLyrics>(roomTopic.lyrics(roomId));
  const active = useRef<HTMLLIElement | null>(null);
  const list = useRef<HTMLOListElement | null>(null);

  const slides = lyrics?.slides ?? [];
  // A position past the end means the arrangement we expanded is not the one
  // ProPresenter is playing. Better to show the song with nothing highlighted
  // than to highlight the wrong line with total confidence.
  const raw = lyrics?.index;
  const at = raw != null && raw >= 0 && raw < slides.length ? raw : null;

  useEffect(() => {
    if (at == null || !list.current || !active.current) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // The list, not the page: see scrollWithin (#36).
    scrollWithin(list.current, active.current, { block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [at]);

  // Nothing open in ProPresenter, or a presentation with no cues — an empty
  // cell beats a card explaining that there is no song. The grid holds the
  // space either way; the layout positions the cell, not the widget.
  if (!slides.length) return null;

  const left = at == null ? null : slides.length - 1 - at;

  return (
    <div className="wgt wgt--lyrics">
      <div className="wgt__head">
        <span className="wgt__icon"><Music size={16} /></span>
        <span className="wgt__title">{lyrics?.name ?? 'Lyrics'}</span>
        {at != null && (
          <span className="lyr__pos mono">{at + 1}/{slides.length}</span>
        )}
      </div>

      <div className="lyr">
        <ol className="lyr__list" ref={list}>
          {slides.map((s, i) => {
            const blank = s.text.trim() === '';
            const state = at == null ? '' : i < at ? ' lyr__row--past' : i === at ? ' lyr__row--now' : '';
            return (
              <li
                // Index-keyed on purpose: a repeated section is genuinely the
                // same text at several positions, and position IS the identity
                // here. Nothing reorders — the list is replaced wholesale when
                // the song changes.
                key={i}
                ref={i === at ? active : undefined}
                aria-current={i === at ? 'true' : undefined}
                className={`lyr__row${state}${blank ? ' lyr__row--blank' : ''}`}
                style={s.color ? ({ '--sec': s.color } as React.CSSProperties) : undefined}
              >
                {opensRun(s, slides[i - 1]) && (
                  <p className="lyr__section">
                    <span className="lyr__dot" aria-hidden />
                    {s.section}
                    {s.rep && <span className="lyr__rep"> {s.rep.at} of {s.rep.of}</span>}
                  </p>
                )}

                {blank ? (
                  // Not a gap to be skipped — an instrumental, a held chord, a
                  // deliberate black. Rendering nothing here makes the scroll
                  // look like ProPresenter has hung. The operator's note is
                  // usually the best available description of what it is.
                  // The section chip above already names it — an "Intro" cue
                  // labelled NO TEXT says the same thing twice and adds noise
                  // to a widget being read at a glance. The rule alone is the
                  // beat; the note, when there is one, is the only new
                  // information. Screen readers get the words either way.
                  <p className="lyr__blank">
                    {s.note ?? <span className="sr-only">No text</span>}
                  </p>
                ) : (
                  <p className="lyr__text">
                    {s.text.split('\n').map((line, k) => (
                      <span className="lyr__line" key={k}>{line}</span>
                    ))}
                  </p>
                )}

                {!blank && s.note && <p className="lyr__note">{s.note}</p>}
              </li>
            );
          })}

          {/* Always rendered, so it scrolls into view under the last line the
              way another verse would. It changes character rather than
              appearing: "the song ends eventually" is not news, "the song ends
              in two" is. */}
          <li className={`lyr__end${left != null && left <= ENDGAME ? ' lyr__end--near' : ''}`}>
            {left == null || left > ENDGAME
              ? 'End of song'
              : left === 0
                ? 'Last slide'
                : `${left} to go`}
          </li>
        </ol>
      </div>
    </div>
  );
}

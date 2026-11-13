import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Circle, ListChecks, StickyNote, Zap } from 'lucide-react';
import {
  getEventDetail,
  setChecklistItem,
  type ChecklistItem,
  type EventDetail as EventDetailData,
  type PlanTime,
} from '../api';
import { Widget, WidgetGrid } from '../components/Widget';
import { ShowConfigWidget } from '../components/ShowConfigWidget';

function fmtTime(t: PlanTime) {
  if (!t.startsAt) return t.name ?? '';
  const d = new Date(t.startsAt);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return t.type === 'rehearsal' && t.name ? `${time} · ${t.name}` : time;
}

export function EventDetail() {
  const { roomId = '', planId = '' } = useParams();
  const [data, setData] = useState<EventDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    getEventDetail(roomId, planId)
      .then((d) => on && setData(d))
      .catch(() => on && setError('Event not found'));
    return () => {
      on = false;
    };
  }, [roomId, planId]);

  const toggle = async (item: ChecklistItem) => {
    setBusyItem(item.id);
    setItemError(null);
    try {
      const r = await setChecklistItem(roomId, planId, item.id, !item.done);
      setData((d) => (d ? { ...d, checklist: r.checklist } : d));
    } catch {
      setItemError(
        item.action
          ? `Couldn't run "${item.label}" — the room may be locked or Companion unreachable.`
          : 'Could not save — try again.',
      );
    } finally {
      setBusyItem(null);
    }
  };

  if (error) {
    return (
      <div className="pagemsg">
        <p>{error}</p>
        <Link className="backlink" to={`/room/${roomId}`}>← Back to room</Link>
      </div>
    );
  }
  if (!data) return <div className="pagemsg">Loading…</div>;

  const { plan, detail, checklist } = data;
  const services = plan.times.filter((t) => t.type === 'service');
  const rehearsals = plan.times.filter((t) => t.type === 'rehearsal');
  const doneCount = checklist.filter((i) => i.done).length;

  return (
    <div className="event">
      <div className="pagehead">
        <div className="event__head">
          {detail.artwork && <img className="event__art" src={detail.artwork} alt="" />}
          <div>
            <h1 className="pagehead__title">{plan.title}</h1>
            <p className="pagehead__sub">
              {[plan.serviceTypeName, plan.seriesTitle, plan.dates].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
      </div>

      <WidgetGrid>
        <Widget span="third" title="Times">
          {services.length > 0 && (
            <div>
              <p className="widget__hint">Services — open a Run of Show:</p>
              <div className="event__times">
                {services.map((t) => (
                  <Link
                    key={t.id}
                    className="svc__time svc__time--service svc__time--link"
                    to={`/room/${roomId}/run/${planId}?time=${t.id}`}
                  >
                    {fmtTime(t)}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {rehearsals.length > 0 && (
            <div>
              <p className="widget__hint">Rehearsals:</p>
              <div className="event__times">
                {rehearsals.map((t) => (
                  <span key={t.id} className="svc__time svc__time--rehearsal">{fmtTime(t)}</span>
                ))}
              </div>
            </div>
          )}
          {plan.times.length === 0 && <p className="svc__muted">No times scheduled.</p>}
        </Widget>

        <Widget
          span="two-thirds"
          title="Startup Checklist"
          meta={
            checklist.length > 0 && (
              <span className={`svc__badge ${doneCount === checklist.length ? 'svc__badge--live' : 'svc__badge--mock'}`}>
                <ListChecks size={12} /> {doneCount} / {checklist.length}
              </span>
            )
          }
        >
          {checklist.length === 0 ? (
            <p className="svc__muted">
              No checklist template for this event type yet — add one in Admin → Checklists.
            </p>
          ) : (
            <>
              <div className="chk__progress">
                <div className="chk__progress-fill" style={{ width: `${(doneCount / checklist.length) * 100}%` }} />
              </div>
              {itemError && <p className="chk__error">{itemError}</p>}
              <ul className="chk">
                {checklist.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`chk__item${item.done ? ' chk__item--done' : ''}`}
                      disabled={busyItem === item.id}
                      onClick={() => toggle(item)}
                    >
                      <span className="chk__check">
                        {item.done ? <CheckCircle2 size={19} /> : <Circle size={19} />}
                      </span>
                      <span className="chk__label">{item.label}</span>
                      {item.action && (
                        <span className="chk__auto" title="Runs automatically when checked">
                          <Zap size={12} /> auto
                        </span>
                      )}
                      {item.done && item.doneAt && (
                        <span className="chk__at">
                          {new Date(item.doneAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Widget>

        <ShowConfigWidget
          times={plan.times}
          roomId={roomId}
          planId={planId}
          items={plan.items}
          saved={data.showConfig}
          serviceType={{ id: plan.serviceTypeId, name: plan.serviceTypeName }}
          automationDefault={data.automationDefault ?? null}
        />

        {detail.notes.length > 0 && (
          <Widget title="Plan Notes">
            <ul className="notes">
              {detail.notes.map((n, i) => (
                <li key={i} className="notes__item">
                  <span className="notes__cat">
                    <StickyNote size={12} /> {n.category ?? 'Note'}
                  </span>
                  <span className="notes__content">{n.content}</span>
                </li>
              ))}
            </ul>
          </Widget>
        )}
      </WidgetGrid>
    </div>
  );
}

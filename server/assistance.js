// ─────────────────────────────────────────────────────────────────────────────
//  ASSISTANCE REQUESTS  —  the Lowe's aisle button.
//
//  A station (any volunteer, no login needed — the station IS the identity)
//  requests help; the tech team channel gets a Slack message; a red bar on
//  that station reminds everyone help is on the way. Whoever responds (or the
//  requester) presses Dismiss at the station, which ✅s the original Slack
//  message so the channel reads as a live open/closed board.
//
//  In-memory by design: an assistance request shouldn't outlive a server
//  restart — a stale "help is coming" bar is worse than asking again.
// ─────────────────────────────────────────────────────────────────────────────

import * as slack from './integrations/slack.js';

const requests = new Map(); // stationId → { stationId, stationName, userName, requestedAt, slack, ack }

// A tech reacting 👀 to the Slack message = "seen it, on my way". While any
// un-acked request is open we poll that message's reactions; the first 👀
// becomes the acknowledgment shown on the station's bar. Polling stops when
// nothing is waiting.
const ACK_EMOJI = 'eyes';
const ACK_POLL_MS = Number(process.env.PRODMESH_ASSIST_POLL_MS ?? 10_000);
let ackTimer = null;

async function pollAcks() {
  for (const entry of requests.values()) {
    if (!entry.slack || entry.ack) continue;
    try {
      const reactions = await slack.getMessageReactions(entry.slack.channel, entry.slack.ts);
      const eyes = reactions.find((r) => r.name === ACK_EMOJI);
      if (eyes?.users?.length) {
        entry.ack = {
          userId: eyes.users[0],
          name: await slack.userName(eyes.users[0]),
          at: Date.now(),
        };
        console.log(
          `[assistance] ${entry.stationName}: acknowledged by ${entry.ack.name ?? entry.ack.userId}`,
        );
      }
    } catch {
      /* recorded in health by the slack client; retry next tick */
    }
  }
  if (![...requests.values()].some((e) => e.slack && !e.ack)) stopAckPolling();
}

function startAckPolling() {
  if (ackTimer) return;
  ackTimer = setInterval(pollAcks, ACK_POLL_MS);
  ackTimer.unref?.();
}

function stopAckPolling() {
  if (ackTimer) clearInterval(ackTimer);
  ackTimer = null;
}

export function getForStation(stationId) {
  return requests.get(stationId) ?? null;
}

/**
 * Open a request for a station (idempotent — a pending request is returned,
 * not re-posted, so a nervous double-tap can't spam the channel). Throws if
 * Slack is configured but unreachable: a silent failure would leave the
 * volunteer believing help was coming.
 */
export async function request(station, userName = null, message = null) {
  const existing = requests.get(station.id);
  if (existing) return existing;

  // Everything interpolated here is attacker-supplied: station registration
  // is unauthenticated. slack.escapeText says why that matters.
  const clean = slack.escapeText;

  const escaped = message ? clean(message) : null;
  const text =
    `:red_circle: ${
      userName ? `*${clean(userName)}* has requested` : 'Someone has requested'
    } technical assistance at *${clean(station.name)}*` +
    (escaped ? `\n${escaped.split('\n').map((l) => `> ${l}`).join('\n')}` : '');

  let posted = null;
  if (slack.isConfigured()) {
    posted = await slack.postMessage(text);
  } else {
    console.log(`[assistance] (slack not configured) ${text}`);
  }

  const entry = {
    stationId: station.id,
    stationName: station.name,
    userName,
    message,
    requestedAt: Date.now(),
    slack: posted,
    ack: null,
  };
  requests.set(station.id, entry);
  if (posted) startAckPolling();
  return entry;
}

/**
 * Close a station's request. The ✅ reaction is best-effort — the local state
 * always clears (the responder is standing at the station; a Slack hiccup
 * shouldn't trap the red bar on screen), and failures land in health.
 */
export async function dismiss(stationId) {
  const entry = requests.get(stationId);
  if (!entry) return null;
  requests.delete(stationId);
  if (entry.slack) {
    await slack.addReaction(entry.slack.channel, entry.slack.ts).catch(() => {});
  }
  return entry;
}

/** Tests only. */
export function reset() {
  requests.clear();
  stopAckPolling();
}

// EventSource cannot set bearer headers. Mint a short-lived opaque ticket;
// the session credential itself never goes into a URL. Revalidate on delivery.
import { randomBytes } from 'node:crypto';
import { resolveSession } from './authStore.js';
const tickets = new Map();
export function issueStreamTicket(token) {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expires <= now || !resolveSession(ticket.token)) tickets.delete(id);
  if (tickets.size >= 1000) throw new Error('Too many stream connections');
  const id = randomBytes(24).toString('hex');
  tickets.set(id, { token, expires: now + 60_000 });
  return id;
}
export function consumeStreamTicket(id) {
  const ticket = tickets.get(id); tickets.delete(id);
  return ticket && ticket.expires > Date.now() ? ticket.token : null;
}
export const privateTopicAllowed = (topic, session) => !topic.startsWith('sunday:') || Boolean(session && topic === `sunday:${session.user.id}`);

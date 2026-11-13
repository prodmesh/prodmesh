// A room's upcoming Planning Center plans. Shared by the service routes and
// the federation digest, which both want "what is next in this room" and must
// agree on it.

import * as pco from './integrations/planningCenter.js';

export const stOf = (plan) => ({ id: plan.serviceTypeId, name: plan.serviceTypeName });

/** Upcoming plans across ALL of a room's service types, soonest first. */
export async function upcomingForRoom(pc, limit) {
  const types = pc.serviceTypes ?? [];
  const lists = await Promise.all(
    types.map((st) => pco.getUpcomingPlans(st, limit).catch(() => [])),
  );
  return lists
    .flat()
    .sort((a, b) => new Date(a.sortDate) - new Date(b.sortDate))
    .slice(0, limit);
}

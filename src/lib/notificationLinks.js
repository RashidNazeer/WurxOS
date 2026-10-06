// Where a notification should take the user. Report notifications carry
// entity_type='report' + entity_id (reports_notify_on_status, mig 221/302),
// so they resolve to the type-agnostic /r/:reportId route, which opens the
// exact report once F2 deep links land (until then it opens the right
// cadence list). Everything else keeps its stored link.
export function resolveNotificationLink(n) {
  if (!n) return null;
  const type = n.entity_type ?? n.entityType;
  const id = n.entity_id ?? n.entityId;
  if (type === 'report' && id) return `/r/${id}`;
  return n.link || null;
}

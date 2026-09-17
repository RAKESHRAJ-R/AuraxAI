// The console's pages, in sidebar order. `perm` is the permission that opens the page —
// the same key the server checks, so a page is only listed when its API would answer.
export const SECTIONS = [
  { id: 'monitor', label: 'Monitor', icon: '📊', title: 'Monitoring Dashboard', perm: 'monitor.view', live: true },
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬', title: 'WhatsApp Connection', perm: 'whatsapp.view' },
  { id: 'knowledge', label: 'Knowledge Hub', icon: '🧠', title: 'Knowledge Hub', perm: 'knowledge.view' },
  { id: 'tickets', label: 'Support Tickets', icon: '🎫', title: 'Support Tickets', perm: 'tickets.view' },
  { id: 'users', label: 'Users & Roles', icon: '👥', title: 'Users & Roles', perm: 'users.manage' },
  { id: 'activity', label: 'Activity Log', icon: '📜', title: 'Activity Log', perm: 'activity.view' },
];

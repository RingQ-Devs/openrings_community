import { avatarColor, initials, memberPath } from './format.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The OpenRings dot-ring mark (same artwork as openrings.org).
const RING_DOTS = [
  [30.0, 16.0], [27.78, 23.57], [25.17, 26.58], [21.82, 28.73], [17.99, 29.86], [14.01, 29.86], [6.83, 26.58], [4.22, 23.57],
  [2.0, 16.0], [2.57, 12.06], [4.22, 8.43], [6.83, 5.42], [10.18, 3.27], [14.01, 2.14], [25.17, 5.42], [27.78, 8.43],
  [29.43, 12.06], [22.43, 24.43], [18.95, 26.18], [11.32, 25.51], [8.2, 23.18], [6.13, 19.88], [5.4, 16.05], [6.1, 12.22],
  [8.13, 8.9], [11.23, 6.53], [14.97, 5.45], [18.85, 5.79], [22.35, 7.51],
];
let markId = 0;
export function brandMark(size = 28, cls = 'brand-mark') {
  const id = `orgrad${++markId}`;
  const dots = RING_DOTS.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.35"/>`).join('');
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="30" y2="30"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#818cf8"/></linearGradient></defs><g fill="url(#${id})">${dots}</g><circle cx="16" cy="16" r="4.6" fill="none" stroke="url(#${id})" stroke-width="2.6"/></svg>`;
}

/** Avatar circle. u needs { username, role }. */
export function avatar(u, size = 40) {
  if (!u) return '';
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  if (u.role === 'ai') {
    return `<span class="avatar avatar--bot" style="${style}" title="Automated answers">${brandMark(Math.round(size * 0.7), '')}</span>`;
  }
  const cls = u.role === 'support' || u.role === 'admin' ? ' avatar--staff' : '';
  return `<span class="avatar${cls}" style="${style};--avatar-bg:${avatarColor(u.username)}" aria-hidden="true">${esc(initials(u.username))}</span>`;
}

/**
 * Role badges. Support engineers and admins carry the support team badge.
 * disclose=true labels sample (persona) accounts.
 */
export function badges(u, disclose = false, team = 'RingQ Support') {
  if (!u) return '';
  switch (u.role) {
    case 'admin':
    case 'support':
      return `<span class="badge badge--staff">${esc(team)}</span>`;
    case 'ai':
      return '<span class="badge badge--bot">Automated</span>';
    case 'persona':
      return disclose
        ? '<span class="badge badge--persona" title="Sample question written to cover a common topic.">Sample question</span>'
        : '';
    default:
      return '';
  }
}

export function userLink(base, u, cls = 'username') {
  if (!u?.username) return '<span class="username">deleted</span>';
  const roleCls = u.role === 'support' || u.role === 'admin' ? ' username--staff' : u.role === 'ai' ? ' username--bot' : '';
  return `<a class="${cls}${roleCls}" href="${base}${memberPath(u)}">${esc(u.username)}</a>`;
}

export { esc };

// Default texts from earlier versions, updated only where they were never edited.
const TEXT_UPDATES = [
  {
    "table": "forums",
    "slug": "announcements",
    "column": "description",
    "from": "Official news, new versions and release notes from the RingQ team.",
    "to": "Official news, new versions and release notes for OpenRings."
  },
  {
    "table": "forums",
    "slug": "general-discussion",
    "column": "description",
    "from": "Anything about Open Rings, business telephony and VoIP.",
    "to": "Anything about OpenRings, business telephony and VoIP."
  },
  {
    "table": "forums",
    "slug": "getting-started",
    "column": "description",
    "from": "New to Open Rings? Ask beginner questions about planning, installing and first steps.",
    "to": "New to OpenRings? Ask beginner questions about planning, installing and your first call."
  },
  {
    "table": "forums",
    "slug": "installation-upgrades",
    "column": "description",
    "from": "Installing on bare metal, VMs and cloud servers; backups, restores and upgrades.",
    "to": "Installing the binary, container or source build; servers, VMs and cloud; upgrades and backups."
  },
  {
    "table": "forums",
    "slug": "call-routing-ivr",
    "column": "title",
    "from": "Call Routing & IVR",
    "to": "Dialplan, Routing & IVR"
  },
  {
    "table": "forums",
    "slug": "call-routing-ivr",
    "column": "description",
    "from": "Inbound and outbound rules, IVR menus, office hours and holidays.",
    "to": "XML dialplan, inbound and outbound routing, IVR menus, office hours and holidays."
  },
  {
    "table": "forums",
    "slug": "queues-call-center",
    "column": "description",
    "from": "Call queues, ring groups, agents, wallboards and reporting.",
    "to": "Queues, ring strategies, tiers, AUX codes, wallboards and reports."
  },
  {
    "table": "forums",
    "slug": "voicemail-recording",
    "column": "title",
    "from": "Voicemail, Recording & Reports",
    "to": "Voicemail, Recording, Fax & Reports"
  },
  {
    "table": "forums",
    "slug": "voicemail-recording",
    "column": "description",
    "from": "Voicemail to email, call recording, CDRs and analytics.",
    "to": "Voicemail, call recording, fax, transcription and CDRs."
  },
  {
    "table": "forums",
    "slug": "softphones-webrtc",
    "column": "description",
    "from": "Mobile apps, desktop softphones and browser calling.",
    "to": "Browser dialer, WebRTC, video meetings and softphones."
  },
  {
    "table": "forums",
    "slug": "integrations-api",
    "column": "description",
    "from": "CRM integrations, webhooks, REST API and custom development.",
    "to": "Event socket, JSON API, live events, CRM integrations and custom development."
  },
  {
    "table": "forums",
    "slug": "feature-requests",
    "column": "description",
    "from": "Suggest and vote on features for future Open Rings releases.",
    "to": "Suggest features for future OpenRings releases."
  },
  {
    "table": "categories",
    "slug": null,
    "column": "title",
    "from": "Open Rings Community",
    "to": "OpenRings Community"
  },
  {
    "table": "categories",
    "slug": null,
    "column": "description",
    "from": "Deploying Open Rings and connecting it to the world",
    "to": "Deploying OpenRings and connecting it to the world"
  }
];

import { run } from './db.js';

/** Bring default forum texts in line with the current names; text an admin changed is left alone. */
export async function applySeedTextUpdates() {
  for (const u of TEXT_UPDATES) {
    if (u.table === 'forums') {
      await run(`UPDATE forums SET ${u.column} = $1 WHERE slug = $2 AND ${u.column} = $3`, u.to, u.slug, u.from);
    } else {
      await run(`UPDATE categories SET ${u.column} = $1 WHERE ${u.column} = $2`, u.to, u.from);
    }
  }
}

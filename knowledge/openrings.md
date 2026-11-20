# OpenRings knowledge base

> Note for the answer writer: lines marked [TO FILL] are not known yet. Treat that topic as
> not covered by the knowledge base. Never repeat "[TO FILL]" in an answer.
>
> Note for the team: this is the only source of product facts for drafted answers. The facts
> below come from the openrings.org home page (November 2026). Check them, and add detail from
> the docs: config file names, portal menu paths, defaults and FAQs. Edit in Admin → Knowledge base.

## What OpenRings is
- OpenRings is an open-source telephony switch written in Go: a complete SIP switch, PBX and contact-centre engine in one static binary. Calls, media, dialplan, queues, WebRTC and a web portal run in a single process, with no C libraries and nothing extra to install.
- The SIP stack, media engine, dialplan and applications are written from scratch in Go. The web portal is one part of it, not the product.
- Current version: 0.10, a **developer preview** (first released 2026). Calls, queues, voicemail, conferences, the portal, the browser dialer, fax, transcription and voice AI agents work end to end and are covered by automated tests. Recommend a field test with your own phones and carriers before production.
- Website: https://openrings.org/ · Documentation and quick start: https://openrings.org/docs/ · Contact: https://openrings.org/contact/
- Source code: https://github.com/ringq-devs/orswitch (the binary and service are called `orswitch`).

## Licence
- Free and open source under the GNU AGPL v3. You can run it unchanged for any purpose. If you change it and offer it to users over a network, you must share your changed source with them.
- To keep changes private or ship OpenRings inside a closed product, a commercial licence is available. Ask through https://openrings.org/contact/.

## Requirements
- 64-bit Linux on x86-64 or ARM64. Pure Go, CGO off, cross-compiles for ARM64.
- 1 CPU and 512 MB of memory to start. 2 CPUs and 2 GB for 100+ concurrent calls. 4 CPUs and 4 GB with on-server call transcription.
- A database is not needed to make calls: OpenRings runs from XML files alone. PostgreSQL is used for the web portal's configuration pages, multi-tenant management and call records (CDRs).
- Analogue and E1/T1 telephony cards are not supported. OpenRings is SIP only.

## Installation
Binary release:
```
tar xzf orswitch-0.10.1-linux-bin.tar.gz
cd orswitch-0.10.1-linux
sudo bash packaging/install.sh
sudo systemctl enable --now orswitch
sudo -u orswitch orswitch -conf /etc/orswitch -check
```
- The installer creates the service user, config and a hardened systemd unit.
- `orswitch -conf <dir> -check` validates the configuration (prints e.g. "configuration OK : 1 domain(s), 5 users").
- Web portal: https://your-server:8443

Container:
```
make container
podman run --network host -v $PWD/conf:/etc/orswitch orswitch:0.10.1
```

From source (every dependency is vendored; no network or C compiler needed):
```
git clone https://github.com/ringq-devs/orswitch
cd orswitch
GOFLAGS=-mod=vendor GOPROXY=off make build
bin/orswitch -version
bin/orswitch -conf conf -check
```

Sample data and first call:
- `sudo bash packaging/setup-test-db.sh` creates a test database with extensions 1000 to 1004, a ring group, an IVR and feature codes, with the portal switched on.
- Register a phone or open the browser dialer, then dial **9196** for the echo test.
- Check registrations from the console: `or_cli -x "show registrations"`.
- Upgrades, backup and restore: [TO FILL]

## Network ports
- SIP: 5060 UDP and TCP. SIP over WebSocket (WSS) for browsers.
- RTP media: 16384–32768 UDP.
- Web portal: 8443 (HTTPS).
- Event socket: 8021.

## SIP and media
- RFC 3261 transactions over UDP and TCP. Registrar with digest auth and signed nonces. B2BUA with separate dialogs per leg. Hold, blind and attended transfer (REFER/Replaces), rport, DNS SRV, several SIP profiles at once.
- RTP and RTCP relay with symmetric latching (helps with NAT). SRTP.
- Codecs: G.711 (µ-law and A-law) is transcoded. G.722, Opus and other codecs are relayed untouched between legs, with payload-type remapping. There is no transcoding beyond G.711.
- DTMF by RFC 4733 and SIP INFO.
- Stereo call recording, tones, playback and conference mixing.

## Dialplan and compatibility
- Familiar FreeSWITCH-style XML dialplan: contexts, extensions, regex conditions with captures, anti-actions, time-of-day rules in each company's time zone, parallel and failover bridging, and 30+ built-in applications (e.g. `bridge`, `ivr`, `play_and_get_digits`, `callcenter`, `answer`, voicemail, conference, `ai_agent`).
- Example: route a DID to a queue during office hours, otherwise to an after-hours IVR:
```xml
<context name="public">
  <extension name="sales_line">
    <condition field="destination_number" expression="^\+?6531234567$"/>
    <condition wday="2-6" time-of-day="09:00-18:00">
      <action application="answer"/>
      <action application="callcenter" data="sales@acme"/>
      <anti-action application="ivr" data="after_hours"/>
    </condition>
  </extension>
</context>
```
- No scripting languages (Lua, JavaScript) yet.
- `orswitch -compat` reports which parts of an existing FreeSWITCH-style dialplan are covered before you switch.
- Configuration from the database reloads automatically when it changes. No restarts.
- Event socket on port 8021: common ESL client libraries connect, send API commands and receive channel and call-centre events. There is also a JSON API with live WebSocket updates.

## Multi-tenancy
- Built in from day one: every company is a domain with its own extensions, dialplan, time zone, office hours, language and security rules. The same extension number can exist in many domains. Suited to hosted PBX providers running hundreds of companies on one server.

## Contact centre
- Queues with nine ring strategies (including longest-idle), tiers, wrap-up and AUX codes, live wallboard, listen, whisper and barge, plus agent and queue reports.
- Ring groups: [TO FILL: how they are configured]

## WebRTC, video and softphones
- Built-in WebRTC gateway, browser softphone (browser dialer), SIP over WebSocket, and an SFU for video meetings with screen sharing, whiteboard and live captions, all served by the same process.
- Mobile app / desk phone auto-provisioning: [TO FILL]

## Fax
- Native fax engine in Go: T.30 over G.711 audio with V.21 and V.29 modems, and T.38 when the carrier switches to it. Send and receive faxes from the portal (applications `rxfax`/`txfax`).

## Voicemail, recording, reports
- Voicemail works end to end. Voicemail to email: [TO FILL]
- Call recording (stereo). CDRs stored in PostgreSQL.

## Transcription and voice AI agents
- On-server speech recognition with per-speaker sentiment and live transcripts during calls.
- Voice AI agents (`ai_agent` application) answer numbers, speak the caller's language and hand off to people. They use a cloud AI service with your own key.

## Security
- SIP Guard automatically bans scanners and brute-force attempts.
- Country restrictions and PIN dialing to stop toll fraud.
- Address rules (ACLs) for SIP and the web, and HTTPS for the portal.

## Compared with FreeSWITCH and Asterisk
- FreeSWITCH (2008) and Asterisk (1999) are mature, with large communities. OpenRings is new (2026) and its community is just starting. Be fair and factual.
- OpenRings differences: written in Go (memory-safe, no C libraries); one static binary plus an installer script; web admin portal, multi-tenancy, browser dialer, SFU video and contact-centre reports built in; on-server transcription.
- Current limits versus them: no scripting languages yet, no telephony cards, transcoding only for G.711.
- FreeSWITCH and Asterisk are trademarks of their respective owners.

## Support channels
- This community forum, answered by the RingQ Support team.
- Documentation: https://openrings.org/docs/
- Contact and commercial licensing: https://openrings.org/contact/
- Report security issues privately through the contact page, not in public threads.

## Frequently asked questions
<!-- Add verified Q&A pairs here; drafted answers reuse them. -->

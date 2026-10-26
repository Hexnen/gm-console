# gm-console relay

A dependency-free bridge that lets a tablet drive macros in a running Foundry world.

## Why a relay is needed

Foundry has no server-side extension point — module code only ever runs in a browser
client, and nothing happens in a world without a client connected. So the GM's own
Foundry tab is the executor. A browser tab can only be a WebSocket/SSE *client*, never a
listener, which means something in the middle has to accept the tablet's request and hand
it to the GM tab. That is all this relay does.

```
tablet  --POST /api/fire-->    relay  --SSE 'fire'-->    GM tab -> macro.execute()
GM tab  --POST /api/result->   relay  --SSE 'result'->   the tablet that asked
GM tab  --POST /api/state->    relay  --SSE 'state'->    every tablet
tablet  --POST /api/layout->   relay  --SSE 'layout'->   GM tab -> saved to a user flag
```

No Foundry login on the tablet. No second seat. Plain HTTP + SSE, no WebSockets, so it
passes cleanly through Cloudflare. Node 18+, no `npm install`.

## Run it

```bash
node server.mjs
```

On a first start with no master token it prints a **one-time bootstrap code**:

```
  No master token yet. In Foundry open GM Console settings and enter:

      HL66Q5
```

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8765` | Listen port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `TRUST_PROXY` | unset | Honour `cf-connecting-ip` **for the pairing rate limit only** — nothing else has ever trusted a header, and nothing grants access based on where a request appears to come from. Set it only behind a proxy that overwrites the header, or the rate limit can be bypassed by forging it. |
| `GMC_TOKEN` | unset | Optional: pin the master token instead of generating one. Rotation is refused while it is set. |
| `GMC_OPEN_CLAIM` | unset | Let `GET /api/master/code` hand the bootstrap code to **any** caller that can reach the port, so claiming needs no typing. **Only for a relay on a trusted LAN.** Off by default, and then the printed code is always required. The relay logs a warning at startup while it is on. |

The relay refuses to start if `secrets.json` or `devices.json` exists but cannot be read or
parsed. That is deliberate: coming up with an empty master token would silently revert it to
"unclaimed" and let anyone claim it, and an unreadable device list would be overwritten by
the next pairing. Fix or delete the file.

## Wire up the GM side

Enable **GM Console (Tablet Hotbar)** in Foundry, then in its settings (client-scoped, so
set them in the browser you actually GM from):

- **Relay URL** — e.g. `https://console.snieg.ovh` or `http://192.168.0.102:8765`
- **Enable console link** — on

Then open **Pair a tablet** and enter the bootstrap code. The relay hands back a generated
master token which the module stores by itself — there is no token field to fill in, and
nothing long is ever copied. The same window rotates it later with one button.

The module only activates for GM users.

## Pair a tablet

Foundry → module settings → **Pair a tablet**. A window shows a QR code and a six-character
code, both good for three minutes and single use. Scan it, or open the relay URL on the
tablet and type the code.

The tablet gets its **own** long-lived token, stored in `localStorage` and listed in the
pairing window so it can be revoked individually. The master token stays in the GM's
browser. Paired devices persist in `devices.json` next to `server.mjs`.

### Roles

A pairing code carries a **role**, chosen when the code is minted, and the device keeps it:

| Role | May | Use it for |
| --- | --- | --- |
| `console` | Everything a tablet has ever been able to do: fire, probe, save the layout. | The GM's own second screen. |
| `viewer` | Connect, receive `state` and `presence` — and nothing else. | A tablet handed to a player, so they can watch the board without touching it. |

The role belongs to the code, not to the claim: the tablet cannot ask to be promoted. A
`viewer` that tries to fire gets a `403` naming its role, not a silent no-op, and the
attempt lands in the action log.

**It fails closed by construction.** Roles are an allowlist of capabilities, and every
device-reachable path has to be named in the relay's route table with the capability it
needs. A path that is not in that table is refused to *every* device token, whatever its
role — so an endpoint added later is master-only until someone deliberately grants it.
Forgetting the table locks a tablet out; it can never let one in.

Change a role afterwards with `POST /api/devices/role` (master only) — handing a tablet to
a player, or taking it back, should not cost a re-pairing. It takes effect on the very next
request, and the tablet is told over its own stream (`role` event).

`devices.json` entries written before roles existed have none, and keep full `console`
rights. A role the relay does not recognise (a typo, a hand edit) is **not** fatal — that
would strand every other tablet over one bad word — it drops to `viewer` with a warning.

## The console

The board is the GM's own arrangement — it starts as a copy of the hotbar and then
diverges. It lives in a flag on the GM user, so it follows them between browsers and is
edited **from the tablet**:

- **✏️** enters edit mode. Each tile gets size (`1x1` → `2x1` → `2x2`), delete, a lock
  toggle, and a drag handle. Groups can be renamed, added, and deleted.
- **+ makro** opens a searchable picker over every macro the GM can execute — not just
  what is pinned to the hotbar.
- **💾** pushes the layout back through the relay to Foundry.

Tiles show the macro's artwork full-bleed with the name on a frosted band. All groups are
visible at once — roughly 6 tiles per row on a tablet in portrait, 8–11 in landscape.

### Guarded macros

A tile marked with the lock (🔒) will not fire on a tap. It needs a deliberate 650 ms hold,
with a progress bar along the bottom edge; a stray tap only explains itself. Use it for
anything you would hate to trigger by brushing the screen.

### What came back

A tap is not fire-and-forget. The tile pulses amber while the request is in flight, then
lands green or red, and the toast reports what the macro actually did — roll totals, chat
output, or the error message. The header shows the real round-trip latency, refreshed by a
silent probe every 20 seconds.

### When the GM drops

The board dims. Taps are queued rather than lost, the header shows `⏳ n`, and the queue
flushes automatically when the GM's tab reconnects. Tap the badge to discard it instead.

## The action log

Every fire and every result is recorded, so "who fired that?" has an answer: when, which
device (id *and* name, since names get reused), which macro, whether it succeeded, and the
real round trip in milliseconds. Pairing, revocation, role changes and refused requests go
in too. A fire that never came back is logged as a `timeout` when its pending entry
expires, so a hung macro does not look like one that was never fired; one whose GM stream
was dropped out from under it is a `dropped`, which is the same fact known sooner.

Every row names an actor, and it is the actor that was actually authorised. A token the
relay does not recognise — revoked while its request was still arriving, or a master that
has since been rotated — is written down as `unknown`, never as the GM. The fallback used
to be `{"deviceId":"master","device":"GM","role":"master"}`, which meant a revoked tablet's
last call was recorded as the GM's own.

Read it with `GET /api/log?token=&limit=` (master only, newest first).

```bash
curl -s "http://127.0.0.1:8765/api/log?token=$MASTER&limit=20" | jq '.entries[]'
{"at":"2026-08-16T20:14:02.881Z","event":"fire","deviceId":"a1b2c3d4","device":"Player iPad","role":"console","macroId":"Qk1..."}
{"at":"2026-08-16T20:14:03.402Z","event":"result","deviceId":"a1b2c3d4","device":"Player iPad","role":"console","macroId":"Qk1...","ok":true,"ms":521,"text":"Rolled 17"}
```

What it deliberately does **not** contain:

- **No tokens.** The log is readable by anyone holding the machine; a credential in it
  would outlive every rotation.
- **No verbatim result text.** Macro output is arbitrary and unbounded, so it is clipped to
  200 characters.
- **No probes.** Every tablet probes latency every 20 seconds. Logging that — successes or
  refusals — would push every real fire out of the ring within minutes.

### How it stays bounded

`action-log.jsonl`, next to `server.mjs`, is one JSON object per line, and it is **capped at
the newest 300 entries** — tens of kilobytes, forever. The ring in memory is the whole
retention policy: the file is only ever a dump of it, written through the same serialised
atomic `rename` the device list uses (coalesced to at most one write per 250 ms, so a burst
of taps does not rewrite it once per tap).

That is why it is not appended to. An append is a second writer racing the save chain, and
it needs a rotation scheme bolted on to stay bounded; rewriting a few hundred short lines
costs nothing at human tap rates and is truncated by construction. The cost is that entries
from the last quarter second can be lost in a hard kill, which for a log of what already
happened is the right trade.

Unlike `secrets.json` and `devices.json`, a damaged log **never** stops the relay: it grants
nothing and protects nothing, so an unparseable line (a crash mid-write) is skipped and the
rest is kept. JSON Lines is chosen precisely so one bad line can be.

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | tablet | The console page. |
| `GET` | `/api/ping?token=` | both | Token probe — 200 or 401. Lets the page tell a revoked device apart from a dropped stream. Also answers `{level, role}`, so a page can grey out its fire buttons instead of learning by `403`. |
| `GET` | `/api/events?role=gm\|pad&token=` | both | SSE stream. `role=gm` requires the master token. Optional `&gen=` names the tab's publishing session; see *One GM publishes*. |
| `POST` | `/api/state?token=` | GM | Publish the layout + macro library. Optional `{seq, gen}` orders overlapping pushes and identifies the publishing tab — `200 {accepted:true}` when it became the served snapshot, `409 {accepted:false, error, publisher}` when it did not. |
| `POST` | `/api/fire?token=` | tablet | `{reqId, macroId}` → routed to **one** GM stream. 503 if none connected. |
| `POST` | `/api/probe?token=` | tablet | Same round trip, runs nothing. Latency only. |
| `POST` | `/api/result?token=` | GM | `{reqId, ok, macro, text}` → routed back to the one tablet that asked. |
| `POST` | `/api/layout?token=` | tablet | `{groups:[…]}` → forwarded to one GM to persist. |
| `GET` | `/api/master/code` | GM | The bootstrap code, but only while `GMC_OPEN_CLAIM` is set; 403 otherwise, 409 once claimed. No CORS headers, so it cannot be read cross-origin. |
| `POST` | `/api/master/claim` | GM | `{code}` → the generated master token. Exists only while the relay is unclaimed; single use. Answers cross-origin, because the Foundry tab is on a different origin than the relay and has to read the token — knowledge of the one-time code is the credential here, and withholding the header would not stop a hostile POST anyway, only the legitimate reply. |
| `POST` | `/api/master/rotate?token=` | GM | Issue a new master token and drop open GM streams. 409 while `GMC_TOKEN` is set. |
| `POST` | `/api/pair/new?token=` | GM | Mint a tablet pairing code. Optional `{role}` — `console` (default) or `viewer`; an unknown one is `400`. |
| `POST` | `/api/pair/claim` | tablet | `{code, name}` → `{token, id, name, role}`. Unauthenticated by necessity; see below. The role comes from the code, never from this body. |
| `GET` | `/api/devices?token=` | GM | List paired devices, each with its `role`. |
| `POST` | `/api/devices/role?token=` | GM | `{id, role}` → change a device's role. `400` without a valid role, `404` for an unknown id. |
| `POST` | `/api/devices/revoke?token=` | GM | `{id}` → drop a paired device. |
| `GET` | `/api/log?token=&limit=` | GM | Recent action-log entries, newest first. `limit` defaults to 100 and is capped at 300; anything that is not a whole number ≥ 1 (`0.5`, `-4`, `abc`) falls back to the default. |

Notes on the traffic itself:

- **`reqId` belongs to the caller, not to the wire.** The relay hands the GM an opaque id of
  its own and maps the answer back, so two tablets may use the same `reqId` and neither can
  read the other's result by guessing one. A tablet always sees the id it sent.
- **One GM executes.** With two Foundry tabs open, `fire`, `probe` and `layout` go to the
  most recently connected stream only — otherwise every macro ran twice. The other tabs stay
  connected and keep receiving `state`, `devices` and `presence`.
- **One GM publishes.** The mirror image of the above, and for the same reason. Two tabs are
  two writers whose `seq` counters mean nothing to each other, and each publishes a whole
  snapshot including the parts that differ per tab (the scene being viewed, client-scoped
  volumes) — so accepting both made the tablets flip between two consoles indefinitely, with
  both writers told `accepted:true`. The relay therefore elects a single publisher:

  - The post changes hands **only when the set of GM streams changes** — a tab opening,
    closing, reloading or crashing. There is no timer: a reloaded tab is asked for a
    snapshot the moment its new stream connects and has the post back within a round trip,
    and when a tab leaves, whoever is left is asked to resync at once.
  - A writer is always allowed to go on being the publisher it already is, so a flapping
    stream cannot lock its own tab out.
  - Everyone else gets `409 {accepted:false, error:"not-publisher", publisher:"<gen>"}`.
    That is the point: silently discarding a second tab's pushes while answering "accepted"
    is what made the original fault invisible.
  - A GM stream may name its session with `&gen=` on `/api/events`. When it does, the
    election is exact rather than first-come: the publisher is the session of the stream
    `fire` goes to, so the tab that runs the macros is the tab that publishes the board.
    Omitting it is fine — the claim rule above runs instead.
- **A body with no `seq` means an unordered push, not a reset.** It is accepted (last one
  wins, as it always was) but it never moves the watermark, and it can never displace a
  publisher that *does* name itself: a body carrying no `gen` names no session, and letting
  it take the post would reset the ordering marks and let a replayed `seq 2` be served over
  a `seq 9`. A module that sends neither field still works exactly as before when it is the
  only writer.
- **`state` before the GM has published anything** is `{"pending": true}` — no `groups` and
  no `library`. It means "no snapshot yet", which is not the same as an empty board: a page
  that treated it as one could save that emptiness back over the real layout.
- **A pending call lives 5 minutes**, so a macro that waits on a Dialog still delivers its
  result. A page should show "still running" rather than failing after a few seconds. It can
  end sooner: if the GM stream it was routed to is dropped, the tablet is answered
  immediately with `{ok: false}` instead of waiting the five minutes out.
- **At most 4 concurrent SSE streams per token**; opening a fifth closes the oldest.
- **A stream that stops reading is dropped**, once about 1 MB is owed to it. `write()` never
  refuses data, so a wedged tab or a slept laptop is otherwise stored in the relay's memory:
  200 fires carrying 500 KB of `args` at one such stream took the process from 46 MB to
  146 MB. Authenticated routes are not rate-limited, so this is the bound. A healthy stream
  is never affected — the cap is well above the largest single frame.
- **Authorisation is checked twice**: once when the headers arrive and again once the body
  has been read. A body may take up to 60 seconds to finish arriving, and a client that
  trickles one across a revoke was otherwise executed and logged with a token that no longer
  existed. A request whose rights or identity changed in between is refused (`401`/`403`),
  and the request is never attributed to the GM — an unknown token resolves to `unknown` in
  the action log, never to `master`.
- **A GM stream is sent `sync` when it connects**, the same way a tablet's arrival asks every
  GM for one. The module's own push on connect is a single un-retried request; this is the
  relay's own way of asking again.
- Bodies over 512 KB are answered `413`.
- **`role` is additive everywhere it appears** — on `ping`, on `pair/claim`, on each entry of
  `devices`, and as a `role` SSE event when the GM changes it. A page that has never heard of
  roles behaves exactly as before; nothing was renamed and no endpoint was removed.

Because `/api/fire` is a plain POST, anything that can make an HTTP request works as a
controller — Touch Portal, a Shortcuts widget, a physical button on an ESP32:

```bash
curl -X POST "https://console.snieg.ovh/api/fire?token=$DEVICE_TOKEN" \
  -H "Content-Type: application/json" -d '{"reqId":"1","macroId":"abc123"}'
```

## Look — liquid glass

`public/liquid-glass.css` is vendored verbatim from
[stormaref/LiquidGlassSkill](https://github.com/stormaref/LiquidGlassSkill) (MIT). The page
keys off `data-theme="dark"`, set statically on `<html>` — the console is dark-only, so
there is no boot script and no flash.

| Element | Tier | Why |
| --- | --- | --- |
| `<body>` | `liquid-glass-backdrop` | Required, not decoration — glass over a flat fill renders as a gray box. Five fixed radial glows give it something to show. |
| Topbar, tiles | `liquid-glass` | The mesh glows through wherever the macro art is transparent (most Foundry icons are line-art SVG). |
| Tile label band | menu tier recipe | It floats over arbitrary artwork, so its text cannot depend on what is underneath. Borderless, so it draws no hard edge across the tile rim. |
| Toast, picker | `liquid-glass-menu` / `--modal` | The popover and dialog cases verbatim. |

**Refraction is not shipped.** The skill's second layer is a per-element SVG displacement
map applied as `backdrop-filter: url(#…)`, delivered as an Angular directive, and it renders
in Chromium only — Safari parses it and paints nothing. Every surface here uses the
stylesheet's documented `blur() saturate()` fallback, which is also what that skill
prescribes for elements repeated in bulk. Tiles are exactly that.

## Installing the module

There is no release host, so `module.json` carries no `url`/`manifest`/`download` and
Foundry's "Install Module" dialog cannot fetch it. Deploy by copying the folder:

```bash
# on the machine running Foundry
<FoundryData>/modules/gm-console/
```

Everything the module needs is in that folder. Restart Foundry, or reload the world, and
enable it under **Manage Modules**. To update, replace the folder and hard-reload the GM's
browser (Ctrl+Shift+R) — client-side module code is cached per browser, so a plain reload
can leave the old scripts running against a new relay.

The relay does **not** have to live on the same machine as Foundry. It has to be reachable
from both the GM's browser and the tablet.

## Running the relay on Windows

The systemd unit below is for a Linux host. On Windows, three things bite, in this order:

**The firewall prompt.** The first time `node.exe` binds the port, Windows asks whether to
allow it. If that dialog is dismissed — or never appears because it opened behind a
full-screen Foundry — the relay runs happily, answers on `127.0.0.1`, and is invisible to
the tablet. The symptom is a tablet that cannot load the page at all while everything looks
fine on the PC. To allow it deliberately, in an elevated PowerShell:

```powershell
New-NetFirewallRule -DisplayName "gm-console relay" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow -Profile Private
```

Keep it to the `Private` profile. If Windows has classified your home network as `Public`,
fix the network's category rather than widening the rule.

**Sleep.** A PC that sleeps takes the relay with it, and the tablet shows a dead console
with no explanation beyond "rozłączono". For a session, either keep the machine awake or
run the relay on something that stays up.

**Autostart.** The simplest reliable option is Task Scheduler: trigger *At log on*, action
`node.exe` with argument `server.mjs`, "Start in" set to this directory. A shortcut in
`shell:startup` also works but leaves a console window open, which at least makes it
obvious when it has died.

Check it is actually listening, and on which addresses:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen
```

A relay bound only to `127.0.0.1` will never serve a tablet — the default `HOST` is
`0.0.0.0`, so this should show the wildcard address.

## Deploying next to Foundry (systemd)

```ini
# /etc/systemd/system/gm-console.service
[Unit]
Description=gm-console relay
After=network.target

[Service]
Environment=GMC_TOKEN=CHANGE_ME
Environment=PORT=8765
WorkingDirectory=/opt/gm-console/relay
ExecStart=/usr/bin/node server.mjs
Restart=always
User=foundry

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now gm-console
```

Then point a Cloudflare Tunnel hostname (e.g. `console.snieg.ovh`) at
`http://localhost:8765`. Cloudflare passes `text/event-stream` through fine; the relay
already sends `X-Accel-Buffering: no` and a 15-second heartbeat so idle streams stay up.

Serving it over HTTPS also unlocks the things a secure context requires — see below.

## HTTPS

Over plain `http://192.168.0.102:8765` the browser withholds every API this console wants,
because none of them are available outside a **secure context**:

| Capability | What it buys | Without it |
|---|---|---|
| Service worker | The shell (`/`, CSS, `haptics.mjs`, manifest, icon) is cached, so the app opens to its own UI when the relay is briefly down. | `navigator.serviceWorker` is `undefined`; registration is skipped silently. |
| `manifest.webmanifest` + install | "Install app" — fullscreen, own icon, no browser chrome eating tablet rows. | Chrome never fires `beforeinstallprompt`, so the header's install button never appears. |
| `navigator.wakeLock` | The tablet stops auto-locking mid-session. This is the big one. | The glyph never lights and the screen sleeps as before. |
| `navigator.clipboard` | Copy-to-clipboard, if it is ever wanted. | Unavailable. |

`http://localhost` and `http://127.0.0.1` *are* secure contexts, which is how the above can
be tested locally — but a tablet reaching the relay by LAN IP is not, and no browser flag
worth setting changes that on the tablet side. A real certificate is the only answer, and
this machine already runs Tailscale, which can issue one for its own MagicDNS name.

### Fronting the relay with Tailscale Serve

**This has not been run for you** — it publishes a service on your tailnet, which is your
call, not the relay's. Run it yourself when you want it:

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:8765
```

That maps `https://bestia.korat-egret.ts.net/` onto the relay, with a genuine Let's Encrypt
certificate that Tailscale fetches and renews. `--bg` makes it a persistent background
config that survives reboots; drop it and the proxy lives only as long as the foreground
command. `--https=443` is the default mode and is spelled out only so the URL is obvious.

Verify it took:

```powershell
tailscale serve status
```

Before anything is configured this prints `No serve config`; afterwards it prints the
mapping from `https://bestia.korat-egret.ts.net:443` to `http://127.0.0.1:8765`. Then load
that URL on the tablet — the padlock should be clean, and `isSecureContext` true in the
console. Re-pair the tablet at the new origin: device tokens live in `localStorage`, which
is per-origin, so the tablet arrives unpaired.

Undo it:

```powershell
tailscale serve reset
```

`reset` clears **all** serve configuration on this node, which is what you want here since
the relay is the only thing being served.

Prerequisites, both already satisfied on this machine: MagicDNS, and HTTPS Certificates
enabled for the tailnet (admin console → DNS). `tailscale status --json` confirms the
second — `CertDomains` lists `bestia.korat-egret.ts.net` when it is on.

### Funnel is deliberately not used

`tailscale funnel` takes the same arguments and would publish the relay to the **entire
public internet**. That is not wanted. Everything here is `tailscale serve`: reachable only
by devices signed into this tailnet, which is the security model the relay's `Security`
section assumes. If `tailscale funnel status` ever reports something, that is a mistake —
`tailscale funnel reset` removes it.

### What this does to `clientIp()` and the pairing rate limit

Behind the proxy **every request arrives from tailscaled on the loopback**, so
`req.socket.remoteAddress` is `127.0.0.1` for every tablet on the tailnet.
`clientIp()` returns exactly that unless `TRUST_PROXY` is set, so the per-IP cap on
`/api/pair/claim` and `/api/master/claim` (10 failures per 5 minutes) collapses into one
shared bucket: one person fumbling a pairing code briefly locks out every other device.
Annoying, but it fails closed and is the right default.

**Do not set `TRUST_PROXY=1` behind Tailscale Serve.** `clientIp()` reads
`cf-connecting-ip`, which is a Cloudflare header — Tailscale does not set it and does not
strip it, so turning it on hands any tailnet client a header it fully controls, and it can
mint itself a fresh rate-limit quota on every request. That is strictly worse than the
shared bucket. `TRUST_PROXY` is for the Cloudflare Tunnel deployment above and nothing else.

What Tailscale Serve *does* set, and how far each can be trusted:

- `X-Forwarded-For` — the tailnet source IP, appended by tailscaled. Trustworthy only as
  the **last** entry in the list: a client may send its own `X-Forwarded-For` and the
  proxy appends to it rather than replacing it, so the first entry is attacker-chosen.
  Reading it would restore per-device rate limiting, but it is not wired up today.
- `Tailscale-User-Login` — the tailnet identity of the calling node's owner, asserted by
  Tailscale itself. Genuinely authenticated, and the honest basis for per-user limits or
  logging.
- Neither is a substitute for the relay's tokens. Serve does not restrict *which* tailnet
  member may connect (that is a tailnet ACL question), so pairing and the master token
  still gate everything.

**Both headers are only trustworthy if the relay cannot be reached except through the
proxy.** As shipped it binds `0.0.0.0:8765`, so the LAN port stays open alongside the
HTTPS one and anyone on the LAN can set either header by hand. Once Serve is the intended
front door, bind loopback only:

```powershell
$env:HOST = "127.0.0.1"; node server.mjs
```

### PWA notes

- The icon is `icon.svg`, declared `"purpose": "any maskable"`. The relay has no
  dependencies and no build step, so there is no way to emit PNGs here and none are
  faked. **Consequence on iOS:** Safari ignores the manifest's icons entirely and reads
  `<link rel="apple-touch-icon">`, where it accepts PNG only — so "Add to Home Screen" on
  an iPad produces Safari's generated letter tile rather than this icon. Everything else
  (standalone display, theme colour) still works. Android/Chromium takes the SVG happily.
  Drop a 512×512 `icon.png` next to it, add it to `STATIC` and to the manifest's `icons`
  if that tile ever matters.
- `orientation` is `"any"`, not `portrait-primary`: the console is used on a stand in
  landscape and flat on the table in portrait, and pinning either one is wrong.
- The service worker caches the shell and **never** touches `/api/*` — SSE, pairing and
  auth always hit the network. See the comment block at the top of `public/sw.js`.
- Static files go out with `Cache-Control: no-store`, so the browser re-fetches `sw.js`
  for real on every update check and a bumped `CACHE` constant in it lands on the next
  visit rather than up to 24 hours later.
- Wake lock is requested when the SSE stream is up and re-taken on `visibilitychange`
  (the UA drops it whenever the page hides). A `☀` appears in the header status run while
  it is actually held.

## Security

- The master token grants full control: macros run arbitrary JS in the GM's session. It is
  generated by the relay, stored in `secrets.json` and in the GM's client settings, and
  never typed anywhere. Rotate it from the pairing window if you suspect it leaked.
- The bootstrap code is only minted while no master token exists, so a claimed relay
  cannot be taken over by someone who reads the console later.
- **There is no "local caller" shortcut, because there cannot be one.** The relay used to
  hand its bootstrap code to anyone whose socket looked local. Any proxy that terminates on
  the same host — `cloudflared`, nginx, `ssh -R`, a two-line TCP forwarder — makes every
  request in the world look local, and that was a complete takeover of the relay and of the
  GM's Foundry session with it. The shortcut is now an explicit, off-by-default opt-in
  (`GMC_OPEN_CLAIM=1`) and should only be set on a LAN you trust, since it hands the code to
  anything that can reach the port.
- **No CORS headers on the unauthenticated routes** (`/api/master/code`, `/api/master/claim`,
  `/api/pair/claim`). The relay used to reflect whatever `Origin` it was given, which let any
  page the operator happened to visit read the bootstrap code and claim master in the
  background. Requests that carry a valid token still get CORS, since holding the token is
  the thing an attacking page cannot do. **Consequence:** a browser on a different origin
  (the Foundry tab) can no longer read those responses, so the module's one-click claim only
  works when the relay and Foundry share an origin — otherwise enter the printed code.
- A revoked device's event stream is closed immediately; a revoked tablet does not keep
  receiving the world name and macro library over an SSE stream that no longer authenticates.
- Device tokens are per-tablet and revocable. A `console` device can fire **any** macro on
  the board — the board is the whole permission boundary — so hand a player a `viewer`
  instead, and revoke a lost tablet from the pairing window.
- Roles are enforced in one gate ahead of every handler, off an allowlist of capabilities
  keyed by path. A path nobody has listed is refused to all device tokens, so the way to get
  a role check wrong here is to lock a tablet out, not to let one in.
- **That gate runs a second time, after the body has been read.** Deciding once, when the
  headers land, authorises the wrong moment: the body may take another sixty seconds
  (`requestTimeout`), and a client that trickles one across a revoke was answered
  `202 queued`, had its macro executed by the GM tab, and was written into the log as the GM.
  Pre-opening sockets to spend later is cheap, so the window was the whole exposure. The
  second check lives inside the body reader rather than in the handlers — every route with a
  side effect reads a body, and reading one is the only pause between the gate and the
  effect, so a route added later inherits the check instead of having to remember it.
- A dropped or wedged SSE stream is closed rather than buffered. `write()` never refuses
  data, so a consumer that stops reading is stored in the relay's memory until it is not:
  past roughly 1 MB owed, the stream goes. Anything in flight to a dropped GM stream is
  failed back to the tablet that asked, instead of waiting out the five-minute pending TTL.
- The action log never contains a token and clips macro output to 200 characters, but it
  does name devices and macros: `/api/log` is master-only, and `action-log.jsonl` on disk
  deserves the same care as the rest of the directory.
- `/api/pair/claim` is necessarily unauthenticated — it is how a fresh tablet gets its
  first credential. It is guarded by a single-use code that expires in three minutes plus a
  cap of 10 failed attempts per IP per five minutes.
- Tokens travel in the query string, because SSE cannot set headers. They will appear in
  reverse-proxy access logs. Serve over HTTPS and treat the URLs as passwords.
- Do not expose this publicly without Cloudflare Access or equivalent in front.

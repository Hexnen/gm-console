/**
 * gm-console relay — a dependency-free bridge between a tablet and a GM's
 * Foundry browser tab.
 *
 *   tablet  --POST /api/fire-->    relay  --SSE 'fire'-->    GM tab -> macro.execute()
 *   GM tab  --POST /api/result->   relay  --SSE 'result'->   the tablet that asked
 *   GM tab  --POST /api/state->    relay  --SSE 'state'->    every tablet
 *   tablet  --POST /api/layout->   relay  --SSE 'layout'->   GM tab -> saved to a user flag
 *
 * Foundry has no server-side extension point, so the GM's browser tab is the
 * executor and a relay hop is unavoidable. Everything here is plain HTTP + SSE:
 * no WebSockets, no npm install, and it passes cleanly through Cloudflare.
 *
 * Run:  node server.mjs
 *
 * Paired tablets carry a role (full "console", or "viewer" which may watch the
 * board but not fire), and every fire lands in a bounded action log next to this
 * file so "who fired that?" has an answer after the fact.
 *
 * On first start it prints a one-time bootstrap code; enter that once in the
 * Foundry module and the relay hands back a generated master token which it
 * remembers in secrets.json. Nothing long ever has to be typed or copied.
 *
 * Env:  PORT (8765), HOST (0.0.0.0), TRUST_PROXY (honour cf-connecting-ip),
 *       GMC_TOKEN (optional: pin the master token and disable rotation),
 *       GMC_OPEN_CLAIM (hand the bootstrap code to any caller — trusted LAN only)
 */

import http from "node:http";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8765);
const HOST = process.env.HOST ?? "0.0.0.0";
const DEVICES_FILE = join(HERE, "devices.json");
const LOG_FILE = join(HERE, "action-log.jsonl");
/** Set only when a proxy in front of us rewrites the client-IP header. */
const TRUST_PROXY = ["1", "true", "yes"].includes(String(process.env.TRUST_PROXY ?? "").toLowerCase());
/**
 * Hand /api/master/code to anyone who asks, instead of requiring the printed
 * code. There is no sound way to *infer* that a caller is local — a proxy that
 * terminates on this host (cloudflared, nginx, `ssh -R`, any TCP forwarder)
 * makes every request look like it came from the machine itself, which turned
 * the old "is the caller local?" check into a full relay takeover. So it is an
 * explicit, off-by-default operator decision instead.
 */
const OPEN_CLAIM = ["1", "true", "yes"].includes(String(process.env.GMC_OPEN_CLAIM ?? "").toLowerCase());

const PAIR_TTL_MS = 3 * 60 * 1000;
/**
 * A macro that opens a Dialog only finishes when the GM answers it, which is
 * easily minutes. At 30 s the relay dropped the pending entry and discarded the
 * late result, so every long macro reported a failure it had not had.
 */
const PENDING_TTL_MS = 5 * 60 * 1000;
const CLAIM_MAX_ATTEMPTS = 10;
const CLAIM_WINDOW_MS = 5 * 60 * 1000;
/** Bound the brute-force table so unique source IPs cannot grow it forever. */
const CLAIM_MAX_IPS = 5000;
/**
 * One token, one tablet — but a reconnect loop or a hostile client can open
 * hundreds of streams on the same token, and every `state` push is then
 * amplified by that factor. A handful covers the legitimate cases (a stale
 * stream the network has not torn down yet, a second tab).
 */
const MAX_STREAMS_PER_TOKEN = 4;
const MAX_BODY_BYTES = 512_000;
/**
 * How many unsent bytes may pile up on one SSE stream before we give up on it.
 *
 * A consumer that has stopped reading cannot refuse data: res.write() accepts it
 * regardless and Node holds it in memory until the socket drains, which for a
 * wedged tab or a slept laptop is never. Authenticated routes carry no rate
 * limit, so 200 fires with 500 KB of `args` each were enough to take the process
 * from 46 MB to 146 MB. The bound therefore has to live at the write: past this
 * much owed to one stream, that stream is the problem and it is dropped.
 *
 * Sized above the largest single frame (a body is capped at MAX_BODY_BYTES) so a
 * healthy stream is never dropped for one big legitimate push, and small enough
 * that the worst case — every allowed stream wedged at once — is a few megabytes.
 */
const MAX_STREAM_BACKLOG = 1_000_000;

/**
 * How many action-log entries are kept, in memory and on disk alike. A GM's
 * laptop is not a log server: the ring is the whole storage policy, so the file
 * cannot grow past roughly this many lines however long the relay runs.
 */
const LOG_MAX = 300;
/** Hard cap on `GET /api/log?limit=`, and its default when the caller omits it. */
const LOG_LIMIT_DEFAULT = 100;
/** Result text is arbitrary macro output; keep a useful prefix, never the whole thing. */
const LOG_TEXT_MAX = 200;
/**
 * Coalesce persists. A burst of taps would otherwise rewrite the file once per
 * entry; the ring in memory is the live copy, and the file only has to catch up.
 */
const LOG_FLUSH_MS = 250;

const SECRETS_FILE = join(HERE, "secrets.json");
/** When GMC_TOKEN is set it wins and rotation is refused — the env is the source of truth. */
const ENV_PINNED = !!process.env.GMC_TOKEN;

/**
 * Refuse to start rather than come up in a weaker state than the one on disk.
 * A secrets.json that exists but cannot be read or parsed used to leave TOKEN
 * empty, which silently reverts the relay to "unclaimed" and re-opens claiming
 * to whoever gets there first.
 * @param {string} why
 * @returns {never}
 */
function fatal(why) {
  console.error(`[gm-console] ${why}`);
  process.exit(1);
}

/**
 * Read a JSON state file. Missing is fine (fresh install); anything else is not.
 * @param {string} file
 * @returns {unknown|undefined} undefined when the file does not exist.
 */
function loadStateFile(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch ( err ) {
    if ( err.code === "ENOENT" ) return undefined;
    return fatal(`cannot read ${file}: ${err.message} — refusing to start with unknown state`);
  }
  try {
    return JSON.parse(raw);
  } catch ( err ) {
    return fatal(`${file} is not valid JSON (${err.message}) — refusing to start; fix or delete it`);
  }
}

let TOKEN = process.env.GMC_TOKEN ?? "";
if ( !TOKEN ) {
  const secrets = loadStateFile(SECRETS_FILE);
  if ( secrets !== undefined ) {
    const master = secrets?.master;
    if ( (typeof master !== "string") || !master ) {
      fatal(`${SECRETS_FILE} has no usable "master" token — refusing to start unclaimed; fix or delete it`);
    }
    TOKEN = master;
  }
}

/**
 * One-time code that trades for the master token. Only minted when no master
 * exists, so a claimed relay cannot be hijacked by someone reading the console.
 */
const CODE_FILE = join(HERE, "bootstrap-code.txt");

let bootstrapCode = "";
if ( !TOKEN ) {
  bootstrapCode = mintCode();
  // Console output is the wrong place to keep a credential the operator needs
  // later: under systemd or a background launcher there may be no terminal to
  // read at all. Drop it on disk next to the server so it can always be found.
  try {
    writeFileSync(CODE_FILE, `${bootstrapCode}\n`);
  } catch ( err ) {
    console.warn("[gm-console] could not write bootstrap-code.txt:", err.message);
  }
}

function mintCode() {
  // Ambiguous glyphs (0/O, 1/I) left out: these get read off a screen.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for ( const b of randomBytes(6) ) code += alphabet[b % alphabet.length];
  return code;
}

function announceCode() {
  console.log(`\n  No master token yet. In Foundry: module settings -> Pair a tablet, and enter\n\n      ${bootstrapCode}\n\n  Also saved to ${CODE_FILE}\n`);
}

/**
 * Serialised, atomic state writes.
 *
 * Two concurrent pairings used to have both handlers truncate the same file and
 * interleave their writes, and a crash mid-write left a half file behind — which
 * now, correctly, refuses to start. Write a temp file and rename it into place
 * (atomic on POSIX and on Windows), one save at a time.
 */
let saveChain = Promise.resolve();

/**
 * @param {string} file
 * @param {string} data
 * @param {string} what  Human label for the warning if it fails.
 * @returns {Promise<void>}
 */
function saveAtomic(file, data, what) {
  saveChain = saveChain.then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch ( err ) {
      console.warn(`[gm-console] could not persist ${what}:`, err.message);
      await unlink(tmp).catch(() => {});
    }
  });
  return saveChain;
}

function saveSecrets() {
  return saveAtomic(SECRETS_FILE, `${JSON.stringify({ master: TOKEN }, null, 2)}\n`, "the master token");
}

/** @type {Set<http.ServerResponse>} */ const gms = new Set();
/**
 * The publishing session a GM stream named on its way in, for the streams whose
 * module names one (`GET /api/events?role=gm&gen=…`). Optional and additive: a
 * module that omits it is elected by the claim rule in electPublisher instead.
 *
 * A WeakMap, so a stream that goes away takes its entry with it — several paths
 * drop a GM stream (close, cap, backpressure) and none of them has to remember
 * to clean up here.
 * @type {WeakMap<http.ServerResponse, string>}
 */
const gmGens = new WeakMap();
/** @type {Map<http.ServerResponse, {id: string, name: string, token: string}>} */ const pads = new Map();

/** Paired tablets: deviceToken -> {id, name, created}. Survives restarts. */
const devices = new Map();
/** Live pairing codes: code -> {expires}. Single use. */
const pairings = new Map();
/** In-flight macro calls: internalId -> {clientReqId, token, at}. Routes the result to one tablet. */
const pending = new Map();
/** Brute-force guard for the unauthenticated claim routes: ip -> {count, until}. */
const claimAttempts = new Map();

/** Last snapshot published by a GM, replayed to tablets on connect. */
let state = null;
/**
 * Who is publishing, and how far their counter has got.
 *
 * `state = body` is ordered by when a body *finishes arriving*, not by when it
 * was sent, and the two differ whenever two pushes overlap: sending S1 then S2
 * left the relay serving S1, and it stayed wrong until the next push. So the
 * module stamps each body with a `seq` that only ever increases, plus a `gen`
 * string identifying the GM session it counts within — `seq` restarts when the
 * tab reloads, and comparing across that restart would reject everything the new
 * tab sent.
 *
 * A `seq` only orders bodies from the *same* writer, though, and there is
 * routinely more than one: a GM who pops a second Foundry window out has two
 * tabs, each with its own `gen`, each publishing a whole snapshot including the
 * values that differ per tab (the scene being viewed, client-scoped volumes).
 * Accepting both meant the tablets flipped between two consoles forever. So the
 * relay elects one publisher and turns the others away — `gen` is the identity
 * it elects, which is why the two live in one record: the watermark belongs to
 * the publisher and is meaningless without it.
 *
 * `null` means the post is open. `gen: null` inside it means the post is held by
 * a writer that did not name itself (a module older than the contract).
 * @type {{gen: string|null, seq: number|null, epoch: number}|null}
 */
let publisher = null;
/**
 * Bumped every time a GM stream arrives or leaves.
 *
 * This is what makes the post change hands *promptly* rather than on a timer: a
 * tab that reloads, closes or crashes drops its stream, and a tab that opens
 * adds one, so every event that can change who ought to be publishing shows up
 * here within a round trip. A lease minted before the latest change is stale and
 * anyone may take it; a lease minted after it is nobody else's to take.
 */
let gmEpoch = 0;
/**
 * What a pad is told while no GM has published yet. It must not look like an
 * empty board: a tablet in edit mode would adopt `{groups: []}` as its model and
 * save that back over the real layout after a relay restart.
 */
const NO_SNAPSHOT = { pending: true };

/* -------------------------------------------- */
/*  Device roles                                */
/* -------------------------------------------- */

/**
 * What each role may do, as a set of granted capabilities.
 *
 * Deliberately an allowlist rather than a list of things a role is denied: an
 * endpoint added later carries a capability nobody has been granted yet, so it
 * is refused to every device until someone opens it here on purpose. The
 * failure mode of forgetting this table is "the restricted tablet cannot do the
 * new thing", never "the restricted tablet can do the new thing".
 */
const ROLE_CAPS = {
  console: new Set(["connect", "fire", "layout"]),
  viewer: new Set(["connect"])
};

/**
 * Which capability each device-reachable route needs. A path that is missing
 * from this map is not reachable by a device token at all — that is the second
 * half of failing closed, and it is why the check lives in one place instead of
 * being sprinkled through the handlers where a new one could forget it.
 */
const DEVICE_ROUTES = new Map([
  ["/api/ping", "connect"],
  ["/api/events", "connect"],
  ["/api/fire", "fire"],
  ["/api/probe", "fire"],
  ["/api/layout", "layout"]
]);

/** Devices paired before roles existed, and pairing codes minted without one. */
const DEFAULT_ROLE = "console";
/** Where an unrecognised role on disk lands: the least privilege we have. */
const FALLBACK_ROLE = "viewer";

/**
 * Normalise a role read from disk or from a request body.
 * @param {unknown} raw
 * @returns {string|null} null when it is a non-empty value that names no role.
 */
function parseRole(raw) {
  if ( (raw === undefined) || (raw === null) || (raw === "") ) return DEFAULT_ROLE;
  const role = String(raw);
  return Object.hasOwn(ROLE_CAPS, role) ? role : null;
}

/**
 * The role a token acts with. Unknown tokens never reach this (auth runs first);
 * the master token is not a device and is not subject to roles.
 * @param {string} token
 */
function roleOf(token) {
  return devices.get(token)?.role ?? DEFAULT_ROLE;
}

/* -------------------------------------------- */
/*  Device persistence                          */
/* -------------------------------------------- */

const storedDevices = loadStateFile(DEVICES_FILE);
if ( storedDevices !== undefined ) {
  // Starting empty on a malformed file is not the safe default: the next pairing
  // saves the (empty) map back and every paired tablet is silently forgotten.
  if ( !Array.isArray(storedDevices) ) fatal(`${DEVICES_FILE} is not an array — refusing to start; fix or delete it`);
  for ( const d of storedDevices ) {
    if ( !d || (typeof d.token !== "string") || !d.token ) fatal(`${DEVICES_FILE} has an entry without a token — refusing to start`);
    // A role-less entry is a device paired before roles existed and keeps the
    // rights it has always had. A role we do not recognise is a different thing
    // — a typo or a downgrade — and is *not* fatal, because refusing to start
    // over one bad word would strand every other tablet; it drops to the least
    // privilege instead, loudly.
    let role = parseRole(d.role);
    if ( role === null ) {
      console.warn(`[gm-console] device ${d.id} has unknown role "${d.role}" — treating it as ${FALLBACK_ROLE}`);
      role = FALLBACK_ROLE;
    }
    devices.set(d.token, { id: d.id, name: d.name, created: d.created, role });
  }
  console.log(`[gm-console] loaded ${devices.size} paired device(s)`);
}

function saveDevices() {
  const list = [...devices].map(([token, d]) => ({ token, ...d }));
  return saveAtomic(DEVICES_FILE, `${JSON.stringify(list, null, 2)}\n`, "devices");
}

/* -------------------------------------------- */
/*  Action log                                  */
/* -------------------------------------------- */

/**
 * "Who fired that?" — the newest LOG_MAX entries, oldest first.
 * @type {Array<object>}
 */
const actionLog = [];
let logTimer = null;

/**
 * Bound a string that came from somewhere we do not control.
 * @param {unknown} v
 * @param {number} n
 */
function clip(v, n) {
  const s = String(v ?? "");
  return (s.length > n) ? `${s.slice(0, n)}…` : s;
}

/**
 * Who a request is acting as, for the log. Never the token itself — the log is
 * meant to be readable by the GM and, on disk, by anyone who has the machine,
 * so a credential must not pass through here.
 * @param {string} token
 */
function actorOf(token) {
  const d = devices.get(token);
  if ( d ) return { deviceId: d.id, device: d.name, role: d.role };
  // The master token is not a paired device; it is the GM's own tab firing. But
  // "not a device" and "the GM" are not the same claim, and treating the second
  // as the default of the first is how a revoked tablet's in-flight call came to
  // be written down as the GM's: the token had already been deleted from
  // `devices` by the time the row was built, so it fell through to here. Prove
  // the master token instead. Anything left — revoked mid-request, rotated out
  // from under a caller — is nobody, and says so. A log that names the wrong
  // actor is worse than one that admits it does not know.
  if ( TOKEN && token && sameSecret(token, TOKEN) ) return { deviceId: "master", device: "GM", role: "master" };
  return { deviceId: "unknown", device: "unknown", role: "unknown" };
}

/**
 * Record one entry and schedule the file catch-up.
 * @param {object} entry
 * @returns {object} the stored row, so a caller can keep reading it.
 */
function logEvent(entry) {
  const row = { at: new Date().toISOString(), ...entry };
  actionLog.push(row);
  // The ring *is* the retention policy: trimming here is what keeps the file
  // bounded too, since the file is only ever a dump of this array.
  while ( actionLog.length > LOG_MAX ) actionLog.shift();
  if ( !logTimer ) {
    logTimer = setTimeout(() => {
      logTimer = null;
      saveLog();
    }, LOG_FLUSH_MS);
    logTimer.unref();
  }
  return row;
}

/**
 * Rewrite the log file from the ring, through the same serialised atomic write
 * the device list uses.
 *
 * A plain append would be the obvious thing and is the wrong thing here: it is a
 * second write mechanism racing the save chain, and it needs a rotation scheme
 * bolted on to stay bounded. Rewriting a few hundred JSON lines costs nothing at
 * human tap rates, is truncated by construction, and can never interleave with a
 * devices.json write.
 */
function saveLog() {
  const body = actionLog.map(e => JSON.stringify(e)).join("\n");
  return saveAtomic(LOG_FILE, body ? `${body}\n` : "", "the action log");
}

/**
 * Read the log back at startup.
 *
 * Unlike secrets.json and devices.json this is never fatal: the log grants
 * nothing and protects nothing, so a truncated last line (a crash mid-write on a
 * filesystem where rename is not quite atomic) must not stop the relay. Bad
 * lines are skipped, and JSON Lines is chosen precisely so one of them can be.
 */
function loadLog() {
  let raw;
  try {
    raw = readFileSync(LOG_FILE, "utf8");
  } catch ( err ) {
    if ( err.code !== "ENOENT" ) console.warn(`[gm-console] could not read the action log: ${err.message}`);
    return;
  }
  let skipped = 0;
  for ( const line of raw.split("\n") ) {
    if ( !line.trim() ) continue;
    try {
      actionLog.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  // A file written by an older, larger LOG_MAX must not stay oversized forever.
  while ( actionLog.length > LOG_MAX ) actionLog.shift();
  if ( actionLog.length || skipped ) {
    console.log(`[gm-console] action log: ${actionLog.length} entr(ies)${skipped ? `, ${skipped} unreadable line(s) skipped` : ""}`);
  }
}

loadLog();

/* -------------------------------------------- */
/*  Auth                                        */
/* -------------------------------------------- */

/** Constant-time compare so a token cannot be guessed a character at a time. */
function sameSecret(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if ( bufA.length !== bufB.length ) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * @param {string|null} token
 * @returns {"master"|"device"|null}
 */
function authLevel(token) {
  if ( !token ) return null;
  // Guard the unclaimed state: without this, an empty TOKEN would make an empty
  // string compare equal to itself and hand out master.
  if ( TOKEN && sameSecret(token, TOKEN) ) return "master";
  return devices.has(token) ? "device" : null;
}

/**
 * The routes that answer without a token at all.
 *
 * An allowlist, for the same reason DEVICE_ROUTES is one: authorize() refuses
 * anything under /api/ that is not in it and holds no token, so a route added
 * later is unreachable-without-a-token by default and has to be named here on
 * purpose. Getting it wrong breaks the new route loudly; it never opens one.
 */
const OPEN_ROUTES = new Set(["/api/master/code", "/api/master/claim", "/api/pair/claim"]);

/**
 * The complete authorisation verdict for a request, computed from the tables as
 * they stand *right now*.
 *
 * Deliberately a pure function of live state rather than something a request
 * carries with it: authorisation is not a fact established once at the top of a
 * handler, it is a fact about a moment — and the moment that has to be
 * authorised is the one the side effect happens in, not the one the headers
 * arrived in. See readBody, which is where the second call lives.
 * @param {URL} url
 * @returns {{token: string|null, level: "master"|"device"|null, role: string|null,
 *            need: string|null, ok: boolean, status: number, body: unknown}}
 */
function authorize(url) {
  // An open route grants nothing and reads nothing from the token, so it reports
  // none — otherwise a token that merely rode along on the query string could
  // change its grant mid-body and fail a claim that never depended on it.
  if ( OPEN_ROUTES.has(url.pathname) ) {
    return { token: null, level: null, role: null, need: null, ok: true, status: 200, body: null };
  }
  const token = url.searchParams.get("token");
  const level = authLevel(token);
  const verdict = { token, level, role: null, need: null, ok: true, status: 200, body: null };
  if ( !url.pathname.startsWith("/api/") ) return verdict;
  if ( !level ) return { ...verdict, ok: false, status: 401, body: "bad token" };
  verdict.role = (level === "master") ? "master" : roleOf(token);
  if ( level !== "device" ) return verdict;

  // What this device's role allows. A path missing from DEVICE_ROUTES is refused
  // outright, so adding an endpoint cannot silently hand it to a restricted
  // tablet.
  verdict.need = DEVICE_ROUTES.get(url.pathname) ?? null;
  if ( verdict.need && ROLE_CAPS[verdict.role]?.has(verdict.need) ) return verdict;
  return {
    ...verdict,
    ok: false,
    status: 403,
    body: {
      error: `this device is paired as "${verdict.role}" and may not use ${url.pathname}`,
      role: verdict.role,
      need: verdict.need
    }
  };
}

/**
 * Everything a verdict grants, as one comparable string.
 *
 * Compared across the body read so that a change of *identity* is caught, not
 * only a change of rights: re-authorising alone would accept a request whose
 * token stopped being one device and started being another.
 * @param {ReturnType<typeof authorize>} verdict
 */
function grantOf(verdict) {
  return `${verdict.level ?? "-"}/${verdict.role ?? "-"}/${devices.get(verdict.token)?.id ?? "-"}`;
}

/**
 * Answer a request its verdict refused, and record it where that is useful.
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @param {ReturnType<typeof authorize>} verdict
 */
function refuse(res, url, verdict) {
  // 401 is not logged: an unauthenticated caller can produce it at will, and the
  // ring bounds entries, so logging it would hand anyone an eraser for the audit
  // trail. A 403 had to present a real token to get that far.
  if ( verdict.status === 401 ) return send(res, 401, "bad token");
  // Probes run every 20 s on every tablet; logging their refusals would bury the
  // interesting entries under a metronome.
  if ( url.pathname !== "/api/probe" ) {
    // Clip: this is the one logged field a caller fully controls, and the ring
    // bounds entry *count*, not bytes. Unclipped, any device could post a few
    // hundred multi-kilobyte paths, evict every real entry and inflate the file —
    // destroying the audit trail on demand.
    logEvent({ event: "denied", ...actorOf(verdict.token), path: clip(url.pathname, 120), need: verdict.need });
  }
  return sendJson(res, verdict.status, verdict.body);
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Reflecting the caller's Origin is only ever done for a request that already
 * proved it holds a token. On the unauthenticated routes (/api/master/code,
 * /api/master/claim, /api/pair/claim) we send no Access-Control-Allow-Origin at
 * all, so the browser's same-origin policy stops any page the operator happens
 * to visit from reading the bootstrap code or a freshly minted device token.
 */
function cors(res, req) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
}

/**
 * May this unauthenticated bootstrap route answer cross-origin?
 *
 * The Foundry tab lives on a different origin than the relay, so without CORS
 * the pairing window cannot read the token it just claimed — the flow simply
 * stops working. Allowing it back is safe for `claim` because knowledge of the
 * one-time code *is* the credential there, and withholding the header would not
 * have prevented a hostile page from POSTing anyway (a simple request needs no
 * preflight); it only ever stopped the legitimate caller reading the reply.
 *
 * `code` is different: it hands out the credential itself, so it stays
 * unreadable cross-origin unless the operator has already declared, via
 * GMC_OPEN_CLAIM, that anyone who can reach the port may have it.
 * @param {string} pathname
 * @returns {boolean}
 */
function bootstrapAllowsCors(pathname) {
  if ( pathname === "/api/master/claim" ) return true;
  if ( pathname === "/api/master/code" ) return OPEN_CLAIM;
  return false;
}

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

/**
 * Answer every in-flight call that was routed at a stream we have just given up
 * on.
 *
 * A dropped GM stream is not a pause: the tab behind it either never received
 * the frame or can no longer report back, and it will reconnect as a fresh
 * stream that knows nothing about these ids. Without this the tablet sits on a
 * spinner for the whole PENDING_TTL_MS — five minutes — before the sweep calls
 * it a timeout. Tell it now, through the same route a real result takes.
 * @param {http.ServerResponse} gmRes
 * @param {string} why
 */
function failPendingFor(gmRes, why) {
  const now = Date.now();
  for ( const [id, p] of pending ) {
    if ( p.gm !== gmRes ) continue;
    pending.delete(id);
    // Same rule as the timeout sweep: a probe's failure is noise, a fire's is the
    // difference between "the macro did nothing" and "the macro never ran".
    if ( !p.probe ) logEvent({ event: "dropped", ...p.actor, macroId: p.macroId, ok: false, ms: now - p.at });
    const targets = [...pads].filter(([, q]) => q.token === p.token).map(([r]) => r);
    emit(targets, "result", { reqId: p.clientReqId, ok: false, error: `the GM stream was dropped: ${why}` });
  }
}

/**
 * Forget one stream and close it now.
 * @param {http.ServerResponse} res
 * @param {string} why
 */
function dropStream(res, why) {
  const wasGm = gms.delete(res);
  pads.delete(res);
  console.warn(`[gm-console] dropped a ${wasGm ? "gm" : "pad"} stream: ${why}`);
  // destroy(), not end(): end() would queue a few more bytes behind the ones this
  // socket has already proved it cannot take, and freeing that buffer is the
  // entire point of being here.
  res.destroy();
  if ( wasGm ) failPendingFor(res, why);
}

/**
 * Is this stream still worth writing to?
 * @param {http.ServerResponse} res
 * @returns {boolean}
 */
function streamWritable(res) {
  // write() on a finished response returns false rather than throwing, so a
  // try/catch would never fire: check explicitly or dead streams pile up.
  if ( res.writableEnded || res.destroyed ) {
    gms.delete(res);
    pads.delete(res);
    return false;
  }
  // writableLength is what Node has accepted from us and not yet handed to the
  // OS. Checking it *before* the write is what bounds the growth: the most one
  // stream can hold is this cap plus the single frame that crossed it.
  if ( res.writableLength > MAX_STREAM_BACKLOG ) {
    dropStream(res, `${res.writableLength} bytes unsent`);
    return false;
  }
  return true;
}

/**
 * Emit one SSE message, dropping clients that have gone away or stopped reading.
 * @param {Iterable<http.ServerResponse>} clients
 * @param {string} event
 * @param {unknown} data
 */
function emit(clients, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  // Snapshot: dropStream() can delete from gms/pads while we iterate, and a
  // caller passing pads.keys() would otherwise be walking the collection being
  // mutated underneath it.
  for ( const res of [...clients] ) {
    if ( !streamWritable(res) ) continue;
    res.write(frame);
  }
}

/**
 * The one GM stream a macro should go to.
 *
 * Fanning out to every GM stream meant two open Foundry tabs each executed the
 * macro — the same roll twice, the same token moved twice. Newest wins: it is
 * the tab the GM is most likely sitting in front of. Older ones stay connected
 * for state pushes and are used only if the newest has gone away.
 * @returns {http.ServerResponse|null}
 */
function pickGm() {
  const open = [...gms];
  for ( let i = open.length - 1; i >= 0; i-- ) {
    const res = open[i];
    if ( res.writableEnded || res.destroyed ) {
      gms.delete(res);
      continue;
    }
    return res;
  }
  return null;
}

/**
 * The publishing session declared by the stream pickGm() would send a macro to.
 *
 * When the module names its session on the stream, publishing can follow macro
 * delivery exactly: the tab that runs the fires is the tab that publishes the
 * board, decided by the same "newest stream wins" rule and not by which of two
 * tabs happened to POST first.
 * @returns {string|undefined} undefined when the newest GM stream named no
 *   session, or when there is no GM stream at all — then there is nothing to
 *   pin the post to and electPublisher falls back to the claim rule.
 */
function boundGen() {
  const gm = pickGm();
  return gm ? gmGens.get(gm) : undefined;
}

/**
 * A GM stream arrived or left, so who ought to be publishing may have changed.
 * @see gmEpoch
 */
function noteGmChurn() {
  gmEpoch++;
}

/** Body over the cap; the promise resolves with this instead of a parsed object. */
const TOO_LARGE = Symbol("too-large");

/**
 * Read and JSON-parse a body, capped so a bad client cannot exhaust memory.
 * @param {http.IncomingMessage} req
 * @returns {Promise<object|null|typeof TOO_LARGE>}
 */
function readJson(req) {
  return new Promise(resolve => {
    /** @type {Buffer[]} */ const chunks = [];
    let size = 0;
    let settled = false;
    const done = value => {
      if ( settled ) return;
      settled = true;
      resolve(value);
    };
    req.on("data", chunk => {
      if ( settled ) return;
      size += chunk.length;
      if ( size > MAX_BODY_BYTES ) return done(TOO_LARGE);
      chunks.push(chunk);
    });
    req.on("end", () => {
      // Decode once over the whole body. Decoding each chunk on its own turned
      // any multi-byte character that straddled a TCP packet boundary into
      // U+FFFD — reproducible with a macro name containing "ó" in a large body.
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        done(null);
      }
    });
    req.on("error", () => done(null));
    req.on("aborted", () => done(null));
  });
}

/**
 * Read a body, then re-authorise before any handler is allowed to act on it.
 *
 * This is the second half of the authorisation check, and it is here rather than
 * in the handlers on purpose.
 *
 * The gate at the top of the request runs the instant the headers land, and the
 * body may take up to requestTimeout — sixty seconds — to arrive after that. A
 * client that trickles its body across a revoke was authorised as a device,
 * answered "202 queued", and had its macro executed and written into the log,
 * all with a token that no longer existed; an attacker can pre-open as many such
 * sockets as they like and spend them later. Nothing about that is specific to
 * /api/fire.
 *
 * Every route with a side effect reads a body, and this is the only await
 * between the gate and a handler's first effect — a route that reads no body has
 * no window to lose. So the check belongs at the one point they all pass
 * through: a route added below cannot skip it without also giving up its body,
 * and it does not have to know the hazard exists. The reply shape is the one
 * callers already handle — undefined means "answered, return now".
 *
 * The 413 path is unchanged, and still replies itself: the old code called
 * req.destroy() on an oversize body, after which neither 'end' nor 'error' ever
 * fires — the promise never settled and the handler never replied, so the caller
 * hung until it gave up.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 * @returns {Promise<object|null|undefined>} undefined once a reply has been sent.
 */
async function readBody(req, res, url) {
  const before = authorize(url);
  const body = await readJson(req);
  if ( body === TOO_LARGE ) {
    // Reply first, drop the socket after: destroying it now would lose the reply,
    // and we do not want to keep reading the rest of an oversize upload.
    res.setHeader("Connection", "close");
    res.on("finish", () => req.destroy());
    send(res, 413, "body too large");
    return undefined;
  }

  const after = authorize(url);
  if ( after.ok && (grantOf(after) === grantOf(before)) ) return body;
  // Worth saying out loud, and safe to say: reaching here needs a token that was
  // valid when the request started, so it cannot be produced at will the way a
  // bad-token 401 can.
  console.warn(`[gm-console] refusing ${url.pathname}: authorisation changed while the body arrived (${grantOf(before)} -> ${grantOf(after)})`);
  // Rights unchanged but identity changed is still a refusal, and 403 is the
  // honest code for it: the token is live, it is simply not the caller we
  // authorised.
  return void refuse(res, url, after.ok
    ? { ...after, status: 403, body: { error: "authorisation changed while the request body was arriving" } }
    : after);
}

/**
 * The pairing rate limit is keyed on this, so an attacker who can set the header
 * could hand themselves a fresh quota per request. Only believe it when the
 * deployment actually sits behind a proxy that overwrites it.
 */
function clientIp(req) {
  const forwarded = TRUST_PROXY ? req.headers["cf-connecting-ip"] : null;
  return (forwarded ?? req.socket.remoteAddress ?? "?").toString();
}

/**
 * Is this IP currently locked out of the unauthenticated claim routes?
 * @param {string} ip
 * @param {number} now
 */
function claimBlocked(ip, now) {
  const rec = claimAttempts.get(ip);
  return !!rec && (rec.until > now) && (rec.count >= CLAIM_MAX_ATTEMPTS);
}

/**
 * Count one failed claim against an IP.
 * @param {string} ip
 * @param {number} now
 */
function noteClaimFailure(ip, now) {
  const rec = claimAttempts.get(ip);
  const next = (rec && (rec.until > now)) ? rec : { count: 0, until: now + CLAIM_WINDOW_MS };
  next.count++;
  claimAttempts.set(ip, next);
  // Map keeps insertion order, so the front is the oldest window. Dropping it is
  // no worse than the sweep doing it a few seconds later.
  while ( claimAttempts.size > CLAIM_MAX_IPS ) claimAttempts.delete(claimAttempts.keys().next().value);
}

/**
 * Close the surplus streams of one token, oldest first.
 * @param {string} token
 */
function capStreams(token) {
  const mine = [...pads].filter(([, p]) => p.token === token).map(([r]) => r);
  while ( mine.length > MAX_STREAMS_PER_TOKEN ) {
    const oldest = mine.shift();
    pads.delete(oldest);
    oldest.end();
  }
}

/** Every GM stream carries the master token, so cap the pool as a whole. */
function capGmStreams() {
  while ( gms.size > MAX_STREAMS_PER_TOKEN ) {
    const oldest = gms.values().next().value;
    gms.delete(oldest);
    oldest.end();
  }
}

/**
 * End every stream belonging to a token that is no longer valid.
 *
 * Deleting the token alone left the SSE response open, and the 15-second
 * keepalive meant it never closed by itself — a revoked tablet went on
 * receiving every `state` push (world name and the full macro library) forever.
 * @param {Set<string>} tokens
 */
function dropStreamsFor(tokens) {
  for ( const [res, p] of [...pads] ) {
    if ( !tokens.has(p.token) ) continue;
    pads.delete(res);
    res.end();
  }
}

function presence() {
  return { gm: gms.size > 0, pads: pads.size };
}

/** Refusal reasons, as the `error` of the 409 answer to POST /api/state. */
const REFUSE_SUPERSEDED = "superseded";
const REFUSE_NOT_PUBLISHER = "not-publisher";

/**
 * The last refusal logged, so a second GM tab pushing on every world change does
 * not write a line per push for hours. The situation is what is worth knowing,
 * not each repetition of it; a line is written again as soon as anything about it
 * changes, which is exactly when the GM's picture of what is happening changes.
 */
let lastRefusal = "";

/**
 * Say once, in the relay's own log, that a push was turned away.
 *
 * Silence is what made the two-tab case impossible to diagnose: both writers were
 * told "accepted", the tablets flipped between two boards, and nothing anywhere
 * recorded that there were two publishers at all.
 * @param {string} reason
 */
function logRefusal(reason) {
  const key = `${reason}/${publisher?.gen ?? ""}/${publisher?.seq ?? ""}`;
  if ( key === lastRefusal ) return;
  lastRefusal = key;
  console.warn(`[gm-console] state push refused (${reason}); publisher=${publisher?.gen ?? "unnamed"} seq=${publisher?.seq ?? "-"}`);
}

/**
 * Decide whether this writer may hold the publishing post, and hand it over when
 * it may. Records the holder, so it is called exactly once per body.
 *
 * The post changes hands only when the set of GM streams changes — never on a
 * timer, and never merely because someone else asked. That single rule covers
 * every case there is:
 *
 *  - One tab. It claims the open post on its first push and renews on every push
 *    after, because a writer is always allowed to go on being the publisher it
 *    already is. Its stream flapping cannot lock it out.
 *  - A tab reloads. Its stream drops and the new one connects, two churns, and
 *    the relay asks the new stream for a snapshot the moment it arrives — so the
 *    reloaded tab takes over within a round trip rather than after a timeout.
 *  - A second tab opens. Churn opens the post, the newcomer publishes on connect
 *    and takes it, and from then on the loser is refused for as long as the
 *    winner keeps its stream. At most one handover per churn, so the two can
 *    never take turns: that flip-flop is the whole defect.
 *  - The winner's tab closes. Churn again, and the relay asks whoever is left to
 *    resync, so the survivor has the post back immediately.
 *
 * A renewal deliberately does *not* refresh the lease's epoch. Otherwise a push
 * still in flight from a tab that has already gone would renew the dead tab's
 * lease after the reload's churn, and the live tab — pushing a moment later —
 * would be locked out of a post whose holder no longer exists.
 *
 * A body with no `gen` names no session, so it can only ever hold a post nobody
 * identified holds: an anonymous writer must never be able to displace an
 * identified one, because taking the post resets the watermark and that is
 * exactly how a replayed body used to win (see acceptState).
 * @param {string|null} gen
 * @returns {string} "" when this writer may publish, else the refusal reason.
 */
function electPublisher(gen) {
  const bound = boundGen();
  if ( bound !== undefined ) {
    // The newest GM stream named its session, so there is nothing to infer.
    if ( gen !== bound ) return REFUSE_NOT_PUBLISHER;
    if ( !publisher || (publisher.gen !== gen) ) publisher = { gen, seq: null, epoch: gmEpoch };
    return "";
  }
  if ( !publisher ) {
    publisher = { gen, seq: null, epoch: gmEpoch };
    return "";
  }
  if ( publisher.gen === gen ) return "";              // renewal; epoch left alone on purpose
  if ( gen === null ) return REFUSE_NOT_PUBLISHER;     // anonymous: may not displace anyone
  if ( publisher.epoch >= gmEpoch ) return REFUSE_NOT_PUBLISHER;  // lease minted since the last churn
  publisher = { gen, seq: null, epoch: gmEpoch };
  return "";
}

/**
 * May this snapshot replace the one we are serving? Records the new marks when
 * it may, so it is called exactly once per body, immediately before `state` is
 * replaced.
 *
 * Two questions in order — may this writer publish at all (electPublisher), and
 * is this body newer than the one we hold — because a `seq` from a writer that
 * is not the publisher is not a number we can compare with anything.
 *
 * Within the publisher:
 *  - no integer `seq`: a module older than the contract, which says nothing about
 *    order. Accept it, last body wins exactly as it always did, but leave the
 *    watermark where it is. Clearing it was the bug: one unversioned body, and
 *    the next replayed `seq 2` was measured against nothing and served over a
 *    `seq 9`. "I cannot tell you the order" is not "the order no longer matters",
 *    and a writer that does number its pushes must not be weakened by one that
 *    does not.
 *  - an integer `seq`: accept only a strictly greater one. Equal is a duplicate,
 *    lower is a body that lost the race, and both would serve a stale board.
 * @param {object} body
 * @returns {string} "" when the body is accepted, else the refusal reason.
 */
function acceptState(body) {
  // An empty string is not an identity: treat it as unnamed rather than as a
  // session every anonymous writer would share.
  const gen = ((typeof body.gen === "string") && body.gen) ? body.gen : null;
  const refusal = electPublisher(gen);
  if ( refusal ) return refusal;
  if ( !Number.isInteger(body.seq) ) return "";
  if ( (publisher.seq !== null) && (body.seq <= publisher.seq) ) return REFUSE_SUPERSEDED;
  publisher.seq = body.seq;
  return "";
}

/* -------------------------------------------- */
/*  Server                                      */
/* -------------------------------------------- */

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/liquid-glass.css": ["liquid-glass.css", "text/css; charset=utf-8"],
  "/haptics.mjs": ["haptics.mjs", "text/javascript; charset=utf-8"],
  // PWA. The worker must be served from the root to take "/" as its scope, which
  // is exactly why it is a top-level entry here rather than under an assets path.
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml; charset=utf-8"]
};

const server = http.createServer(async (req, res) => {
  // The Host header is attacker-controlled and llhttp forwards plenty that URL
  // rejects — "[", "a b", "%", empty. new URL then throws synchronously, and an
  // uncaught throw in a request handler takes the whole process down: one
  // unauthenticated TCP connection would drop every tablet and the GM tab
  // mid-session. The host is never used for anything but parsing, so a fixed
  // placeholder is both safe and sufficient.
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  } catch {
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, "bad request line");
    }
  }

  if ( req.method === "OPTIONS" ) {
    // A preflight carries the same query string as the call it precedes (tokens
    // travel there because SSE cannot set headers), so it can be authorised the
    // same way. Unauthenticated routes answer without CORS headers on purpose.
    if ( authLevel(url.searchParams.get("token")) || bootstrapAllowsCors(url.pathname) ) cors(res, req);
    return send(res, 204, "");
  }

  // --- static assets ----------------------------------------------------
  const asset = STATIC[url.pathname];
  if ( (req.method === "GET") && asset ) {
    const [file, type] = asset;
    try {
      const buf = await readFile(join(HERE, "public", file));
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      return res.end(buf);
    } catch {
      return send(res, 500, `${file} missing from public/`);
    }
  }

  // --- pairing: claim is deliberately unauthenticated -------------------
  // It is the only way a fresh tablet can obtain a token, so it is guarded by
  // a short-lived single-use code plus a per-IP attempt cap instead. The tablet
  // page is served from this origin, so it needs no CORS headers — and without
  // them no other page can read the token out of the response.
  if ( (req.method === "POST") && (url.pathname === "/api/pair/claim") ) {
    const ip = clientIp(req);
    const now = Date.now();
    if ( claimBlocked(ip, now) ) return sendJson(res, 429, { error: "too many attempts" });

    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    const code = String(body?.code ?? "").trim().toUpperCase();
    const pairing = pairings.get(code);

    if ( !pairing || (pairing.expires < now) ) {
      pairings.delete(code);
      noteClaimFailure(ip, now);
      return sendJson(res, 403, { error: "invalid or expired code" });
    }

    pairings.delete(code);              // single use
    claimAttempts.delete(ip);

    const token = randomBytes(24).toString("hex");
    const id = randomBytes(4).toString("hex");
    const name = String(body?.name ?? "Tablet").slice(0, 40);
    // Whatever the GM chose when the code was minted; a code from before roles
    // existed (or one minted without a choice) still means a full console.
    const role = pairing.role ?? DEFAULT_ROLE;
    devices.set(token, { id, name, created: new Date(now).toISOString(), role });
    await saveDevices();
    console.log(`[gm-console] paired ${role} device "${name}" (${id}) from ${ip}`);
    logEvent({ event: "pair", deviceId: id, device: name, role });
    emit(gms, "devices", { devices: [...devices.values()] });
    return sendJson(res, 200, { token, id, name, role });
  }

  // --- hand out the bootstrap code, if the operator opted in ------------
  // Locality cannot be inferred: any proxy that terminates on this host makes
  // every caller look local, which made this a takeover. GMC_OPEN_CLAIM is the
  // operator saying "this relay is only reachable from a network I trust".
  // Default off, and then the printed code is always required.
  if ( (req.method === "GET") && (url.pathname === "/api/master/code") ) {
    if ( bootstrapAllowsCors(url.pathname) ) cors(res, req);
    if ( TOKEN ) return sendJson(res, 409, { error: "already claimed" });
    if ( !OPEN_CLAIM ) {
      return sendJson(res, 403, { error: "use the printed code (set GMC_OPEN_CLAIM=1 on a trusted LAN to skip it)" });
    }
    return sendJson(res, 200, { code: bootstrapCode });
  }

  // --- master bootstrap: trade the one-time code for the master token ---
  // Unauthenticated by necessity, the same way pair/claim is: it exists only
  // while the relay has no master, and it is single use.
  if ( (req.method === "POST") && (url.pathname === "/api/master/claim") ) {
    cors(res, req);
    if ( TOKEN ) return sendJson(res, 409, { error: "already claimed" });
    const ip = clientIp(req);
    const now = Date.now();
    if ( claimBlocked(ip, now) ) return sendJson(res, 429, { error: "too many attempts" });
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    const code = String(body?.code ?? "").trim().toUpperCase();
    // Constant-time, like every other secret comparison here: a plain !== leaks
    // how much of the code was right through its timing.
    if ( !bootstrapCode || !sameSecret(code, bootstrapCode) ) {
      noteClaimFailure(ip, now);
      return sendJson(res, 403, { error: "invalid code" });
    }
    TOKEN = randomBytes(24).toString("hex");
    bootstrapCode = "";
    claimAttempts.delete(ip);
    await saveSecrets();
    await unlink(CODE_FILE).catch(() => {});   // spent; do not leave it lying around
    console.log("[gm-console] master token claimed");
    return sendJson(res, 200, { token: TOKEN });
  }

  // --- everything below needs a token -----------------------------------
  // One gate for every authenticated route, checked before any handler runs —
  // and run a second time, by readBody, once the body is in. Both calls go
  // through authorize() so the two can never drift apart.
  const authz = authorize(url);
  const token = authz.token;
  const level = authz.level;
  if ( authz.status === 401 ) return send(res, 401, "bad token");
  // Only now, having proved it holds a token, does the caller get CORS headers.
  cors(res, req);
  if ( !authz.ok ) return refuse(res, url, authz);
  const masterOnly = () => level === "master";

  // --- token probe ------------------------------------------------------
  if ( (req.method === "GET") && (url.pathname === "/api/ping") ) {
    // `role` is additive: a page that does not know about roles ignores it, and
    // one that does can grey out its fire buttons instead of learning by 403.
    return sendJson(res, 200, { ok: true, level, role: (level === "master") ? "master" : roleOf(token), ...presence() });
  }

  // --- SSE stream -------------------------------------------------------
  if ( (req.method === "GET") && (url.pathname === "/api/events") ) {
    const wantsGm = url.searchParams.get("role") === "gm";
    if ( wantsGm && !masterOnly() ) return send(res, 403, "gm role needs the master token");

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");

    if ( wantsGm ) {
      gms.add(res);
      // Optional and additive. A module that names its publishing session here
      // gets an exact election — the tab macros go to is the tab that publishes
      // — instead of the claim rule's "first to push after the post opened".
      const declared = url.searchParams.get("gen");
      if ( declared ) gmGens.set(res, declared);
      noteGmChurn();
      capGmStreams();
      if ( gms.size > 1 ) {
        console.warn(`[gm-console] ${gms.size} GM streams connected; macros go to the most recent one only`);
      }
      emit([res], "devices", { devices: [...devices.values()] });
      // Ask this GM for a snapshot, exactly as a pad's arrival asks every GM.
      // Whatever the relay is holding was published by some earlier tab and may
      // be a reload, a world change or a restart out of date, and the module's
      // own push on connect is a single un-retried fetch — if it loses, nothing
      // else ever asks and every tablet keeps the stale board. Costing one extra
      // push per GM connect buys a recovery path the relay owns.
      emit([res], "sync", {});
    } else {
      const dev = devices.get(token) ?? { id: "master", name: "Master" };
      // Keep the token: results are routed back by device, since the POST that
      // asked for them is a different response object entirely.
      pads.set(res, { ...dev, token });
      capStreams(token);
      emit([res], "state", state ?? NO_SNAPSHOT);
      // Every GM, not just the publisher: the relay cannot address the publisher's
      // stream unless its module declared a gen on it, and asking only the newest
      // would leave the pad holding a stale board whenever the publisher is some
      // other tab. Asking all of them costs the non-publishers a 409 they already
      // understand, and exactly one answer is stored.
      emit(gms, "sync", {});                // ask the GM for a fresh snapshot
    }
    console.log(`[gm-console] ${wantsGm ? "gm" : "pad"} connected (gm=${gms.size} pad=${pads.size})`);
    emit(pads.keys(), "presence", presence());
    emit(gms, "presence", presence());

    req.on("close", () => {
      gms.delete(res);
      pads.delete(res);
      if ( wantsGm ) {
        noteGmChurn();
        // The tab that left may have been the publisher — a reload, a closed
        // pop-out, a crash — and nothing else would ask the survivors for a
        // snapshot until the next world change, so the post would sit open and
        // the tablets would hold a board belonging to a tab that is gone. Every
        // remaining GM is asked; exactly one of their answers is accepted.
        emit(gms, "sync", {});
      }
      console.log(`[gm-console] ${wantsGm ? "gm" : "pad"} left (gm=${gms.size} pad=${pads.size})`);
      emit(pads.keys(), "presence", presence());
      emit(gms, "presence", presence());
    });
    return;
  }

  // --- GM publishes layout + macro library ------------------------------
  if ( (req.method === "POST") && (url.pathname === "/api/state") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    if ( !body ) return send(res, 400, "bad json");
    // Two pushes in flight at once finish in whatever order their last packet
    // lands, so "the body that arrived last" is not "the newest snapshot"; and
    // two GM tabs are two writers whose numbers mean nothing to each other, so
    // one of them has to be told it is not the one publishing.
    const refusal = acceptState(body);
    if ( refusal ) {
      // 409 with accepted:false either way — a module that only knows the old
      // vocabulary already reads that as "refused, do not record this push".
      // `error` says which of the two it was, and `publisher` names the session
      // that does hold the post so a second tab can say so instead of looking
      // broken.
      logRefusal(refusal);
      return sendJson(res, 409, {
        ok: false, accepted: false, error: refusal,
        publisher: publisher?.gen ?? null, gen: publisher?.gen ?? null, seq: publisher?.seq ?? null
      });
    }
    state = body;
    emit(pads.keys(), "state", state);
    // A distinguishable answer either way, so the sender can tell "the relay is
    // serving what I sent" from "something newer got there first" — the second is
    // not a failure and must not be retried into a loop. Additive: the status
    // code and the JSON are both new, and an older module that reads neither sees
    // the 200 it always saw.
    return sendJson(res, 200, {
      ok: true, accepted: true,
      publisher: publisher.gen, gen: publisher.gen, seq: publisher.seq
    });
  }

  // --- GM rotates the master token --------------------------------------
  if ( (req.method === "POST") && (url.pathname === "/api/master/rotate") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    if ( ENV_PINNED ) {
      return sendJson(res, 409, { error: "GMC_TOKEN is set in the environment; rotate it there instead" });
    }
    TOKEN = randomBytes(24).toString("hex");
    await saveSecrets();
    console.log("[gm-console] master token rotated");
    // Every GM stream still open is authenticated with the old value; drop them
    // so the module reconnects with the new one instead of lingering half-valid.
    for ( const gmRes of [...gms] ) {
      gms.delete(gmRes);
      gmRes.end();
    }
    return sendJson(res, 200, { token: TOKEN });
  }

  // --- GM issues a pairing code ----------------------------------------
  if ( (req.method === "POST") && (url.pathname === "/api/pair/new") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    // The role rides on the code, not on the claim: the tablet must not get to
    // choose what it is being handed. An omitted role is the old behaviour.
    const role = parseRole(body?.role);
    if ( role === null ) return sendJson(res, 400, { error: `unknown role; expected one of ${Object.keys(ROLE_CAPS).join(", ")}` });
    const code = mintCode();
    pairings.set(code, { expires: Date.now() + PAIR_TTL_MS, role });
    return sendJson(res, 200, { code, expiresIn: PAIR_TTL_MS, role });
  }

  // --- GM lists paired tablets ------------------------------------------
  // The list is otherwise only pushed over the GM stream (on gm connect, pair
  // and revoke), so a pairing window opened at any other moment had no way to
  // learn about existing devices and its revoke UI stayed unreachable.
  if ( (req.method === "GET") && (url.pathname === "/api/devices") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    return sendJson(res, 200, { devices: [...devices.values()] });
  }

  // --- GM changes a paired tablet's role --------------------------------
  // Separate from revoke on purpose: handing a tablet to a player should not
  // cost them a re-pairing, and taking the rights back should not either.
  if ( (req.method === "POST") && (url.pathname === "/api/devices/role") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    const id = String(body?.id ?? "");
    // No default here, unlike pairing: an absent role in a *change* request is a
    // caller bug, and silently promoting a viewer to console would be the worst
    // possible reading of it.
    const role = (body?.role === undefined) ? null : parseRole(body.role);
    if ( !role ) return sendJson(res, 400, { error: `unknown role; expected one of ${Object.keys(ROLE_CAPS).join(", ")}` });

    let changed = 0;
    for ( const [tok, d] of devices ) {
      if ( d.id !== id ) continue;
      d.role = role;
      changed++;
      // Tell the tablet itself, so it can re-render without waiting for its next
      // refused tap. Unknown events are ignored by EventSource listeners that
      // never registered for them, so this is safe for the page as it is today.
      const mine = [...pads].filter(([, p]) => p.token === tok).map(([r]) => r);
      emit(mine, "role", { role });
    }
    if ( !changed ) return sendJson(res, 404, { error: "no such device" });
    await saveDevices();
    logEvent({ event: "role", deviceId: id, device: [...devices.values()].find(d => d.id === id)?.name ?? "?", role });
    emit(gms, "devices", { devices: [...devices.values()] });
    return sendJson(res, 200, { devices: [...devices.values()] });
  }

  // --- GM reads the action log ------------------------------------------
  // Master only: it names devices and macros, and it is the record of what a
  // device did — a device must not be able to read (or shoulder-surf) it.
  if ( (req.method === "GET") && (url.pathname === "/api/log") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    // Floor *before* the test, not after. "0.5" passes "> 0", floors to 0, and
    // slice(-0) is slice(0) — the whole ring, which is both the opposite of what
    // was asked for and larger than the default it should have fallen back to.
    const asked = Math.floor(Number(url.searchParams.get("limit")));
    const limit = (Number.isFinite(asked) && (asked > 0)) ? Math.min(asked, LOG_MAX) : LOG_LIMIT_DEFAULT;
    // Newest first: the question is always "what just happened".
    return sendJson(res, 200, { entries: actionLog.slice(-limit).reverse(), total: actionLog.length });
  }

  // --- GM revokes a paired tablet --------------------------------------
  if ( (req.method === "POST") && (url.pathname === "/api/devices/revoke") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    const id = String(body?.id ?? "");
    const revoked = new Set();
    for ( const [tok, d] of devices ) {
      if ( d.id !== id ) continue;
      logEvent({ event: "revoke", deviceId: d.id, device: d.name, role: d.role });
      devices.delete(tok);
      revoked.add(tok);
    }
    // The token is gone, but its stream would otherwise stay open and keep
    // receiving state; close it the way rotate does for GM streams.
    dropStreamsFor(revoked);
    // Nothing can be delivered to a device that no longer exists, so do not hold
    // its in-flight calls for another five minutes.
    for ( const [key, p] of pending ) if ( revoked.has(p.token) ) pending.delete(key);
    await saveDevices();
    emit(gms, "devices", { devices: [...devices.values()] });
    emit(pads.keys(), "presence", presence());
    emit(gms, "presence", presence());
    return sendJson(res, 200, { devices: [...devices.values()] });
  }

  // --- tablet fires a macro (or probes latency) -------------------------
  if ( (req.method === "POST") && ["/api/fire", "/api/probe"].includes(url.pathname) ) {
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    const clientReqId = String(body?.reqId ?? "").slice(0, 64);
    if ( !clientReqId ) return send(res, 400, "reqId required");
    const gm = pickGm();
    if ( !gm ) return send(res, 503, "no gm connected");
    if ( gms.size > 1 ) console.warn(`[gm-console] ${gms.size} GM streams connected; firing at the most recent one`);

    // Route by device token, not by this response: `res` here is the POST, which
    // is about to end, while the result has to reach the tablet's open SSE stream.
    const asker = [...pads.values()].find(p => p.token === token);
    // The id that goes on the wire is ours, not the caller's. A client-chosen
    // reqId let one tablet claim another's result simply by guessing or reusing
    // its id; the caller's own value never leaves this map and is put back on
    // the way out.
    const internalId = randomBytes(16).toString("hex");
    const probe = url.pathname === "/api/probe";
    const macroId = clip(body?.macroId ?? "", 64) || null;
    // Carry enough to describe the call when its result comes back: by then the
    // device may have been revoked, and `at` is where the round trip is measured
    // from. Never the token beyond the routing key it already was.
    // Resolve the actor now, not when the result lands: by then the device may
    // have been revoked, and the row would name nobody. actorOf no longer falls
    // back to the GM, so the cost of resolving it late is a blank in the audit
    // trail rather than a lie in it — but a blank is still worse than the name.
    const actor = actorOf(token);
    // Which GM stream this went to, so that if that stream is dropped the tablet
    // is told now instead of waiting out PENDING_TTL_MS. Held only as a routing
    // key, the same way `token` is.
    pending.set(internalId, { clientReqId, token, at: Date.now(), macroId, probe, actor, gm });
    // Probes run every 20 s per tablet and did nothing by definition; logging
    // them would push every real fire out of the ring within minutes.
    if ( !probe ) logEvent({ event: "fire", ...actor, macroId });
    emit([gm], probe ? "probe" : "fire", {
      reqId: internalId,
      macroId: body?.macroId ?? null,
      // Parameter values and which tile was tapped, forwarded untouched. The
      // relay deliberately does not interpret or validate them: the executor
      // checks them against its own stored board, because that board is the only
      // trustworthy copy of what a tile is allowed to do. Rebuilding the frame
      // without these silently dropped every parameterised call.
      args: body?.args ?? null,
      tile: body?.tile ?? null,
      // Which board the tile was tapped on, forwarded on the same terms: the
      // executor compares it against its own active board and refuses a tap made
      // on another one, because a tile position means nothing without the board
      // it indexes into. Absent from an older tablet, which the executor reads as
      // "said nothing" rather than as a match.
      board: body?.board ?? null,
      device: asker?.name ?? "Tablet"
    });
    return send(res, 202, "queued");
  }

  // --- GM reports what the macro did ------------------------------------
  if ( (req.method === "POST") && (url.pathname === "/api/result") ) {
    if ( !masterOnly() ) return send(res, 403, "master token required");
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    const internalId = String(body?.reqId ?? "");
    const waiting = pending.get(internalId);
    pending.delete(internalId);
    // A probe's result is the latency measurement itself and is not interesting
    // after the fact; a fire's is the answer to "did it work, and how slowly".
    if ( waiting && !waiting.probe ) {
      logEvent({
        event: "result",
        ...waiting.actor,
        macroId: waiting.macroId,
        ok: body?.ok !== false,
        ms: Date.now() - waiting.at,
        text: clip(body?.text ?? body?.error ?? "", LOG_TEXT_MAX)
      });
    }
    // The tablet may have navigated away mid-flight; that is not an error.
    // Only the asking device's streams get it, and they get back the reqId they
    // themselves chose — the internal id is never shown to a tablet.
    if ( waiting ) {
      const targets = [...pads].filter(([, p]) => p.token === waiting.token).map(([r]) => r);
      emit(targets, "result", { ...body, reqId: waiting.clientReqId });
    }
    return send(res, 200, "ok");
  }

  // --- tablet saves a console layout ------------------------------------
  if ( (req.method === "POST") && (url.pathname === "/api/layout") ) {
    const body = await readBody(req, res, url);
    if ( body === undefined ) return;
    if ( !Array.isArray(body?.groups) ) return send(res, 400, "groups[] required");
    const gm = pickGm();
    if ( !gm ) return send(res, 503, "no gm connected");
    // A save can now be *refused* by the executor — a layout edited against one
    // board must not land on another — so it needs a way back to the tablet that
    // is holding the only copy of the edit. That way already exists: the same
    // pending map and the same /api/result the fire path uses, with the same rule
    // that the id on the wire is ours and the caller's own is put back on the way
    // out. A tablet that sends no reqId simply gets no answer, exactly as before.
    const saveReqId = String(body?.reqId ?? "").slice(0, 64);
    let internalId = "";
    if ( saveReqId ) {
      internalId = randomBytes(16).toString("hex");
      pending.set(internalId, {
        clientReqId: saveReqId,
        token,
        at: Date.now(),
        macroId: null,
        // Quiet, like a probe, and for the same reason: the action log records
        // what was *run*, and this is routing for a write the GM makes on their
        // own console. Logging it would put a second, macro-less row next to
        // every save and a "timeout" row behind every older executor.
        probe: true,
        actor: actorOf(token),
        gm
      });
    }
    // One writer: two tabs both persisting the same layout to the same user flag
    // is at best redundant and at worst a write race.
    emit([gm], "layout", {
      reqId: internalId,
      groups: body.groups,
      // The board this layout was edited against, forwarded untouched for the
      // executor to compare against its own — see the fire handler above.
      board: body?.board ?? null
    });
    return send(res, 202, "queued");
  }

  send(res, 404, "not found");
});

/* -------------------------------------------- */
/*  Housekeeping                                */
/* -------------------------------------------- */

// Keep proxies and mobile radios from dropping idle SSE streams, and expire
// anything that has been waiting too long.
setInterval(() => {
  // Same check emit() uses, and for a second reason here: a stream can go quiet
  // between pushes, and this sweep is then the only thing that will notice it is
  // holding a megabyte nobody is reading.
  for ( const pool of [[...gms], [...pads.keys()]] ) {
    for ( const res of pool ) {
      if ( !streamWritable(res) ) continue;
      res.write(": ping\n\n");
    }
  }
  const now = Date.now();
  for ( const [id, p] of pending ) {
    if ( now - p.at <= PENDING_TTL_MS ) continue;
    // The tablet was told nothing came back; the log should say so too, or a
    // macro that hung looks in the log exactly like one that was never fired.
    if ( !p.probe ) logEvent({ event: "timeout", ...p.actor, macroId: p.macroId, ok: false, ms: now - p.at });
    pending.delete(id);
  }
  for ( const [code, p] of pairings ) if ( p.expires < now ) pairings.delete(code);
  // Lockout windows were only ever cleared by a successful claim, so the table
  // grew for the lifetime of the process and stale windows were never released.
  for ( const [ip, rec] of claimAttempts ) if ( rec.until < now ) claimAttempts.delete(ip);
}, 15000).unref();

/**
 * Node's defaults were switched off entirely, so a client that opened a socket
 * and sent half a request line held it open forever. These only bound how long
 * *receiving a request* may take; an SSE response, whose request is complete the
 * moment its headers arrive, is unaffected and stays open indefinitely.
 */
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
// Idle keep-alive sockets between requests; a stream in progress is not idle,
// so this never applies to SSE.
server.keepAliveTimeout = 65_000;
// Node only enforces the two timeouts above when this sweep runs, so with the
// 30 s default a half-open socket could sit there for a full minute.
server.connectionsCheckingInterval = 5_000;

server.listen(PORT, HOST, () => {
  console.log(`[gm-console] relay listening on http://${HOST}:${PORT}`);
  if ( OPEN_CLAIM ) {
    console.warn("[gm-console] GMC_OPEN_CLAIM is on: /api/master/code hands the bootstrap code to ANY caller that can reach this port. Only do this on a trusted LAN.");
  }
  if ( bootstrapCode ) {
    announceCode();
    // Repeat until claimed: whoever needs the code may only start watching the
    // log after startup has already scrolled past.
    const nag = setInterval(() => {
      if ( !bootstrapCode ) return clearInterval(nag);
      announceCode();
    }, 60000);
    nag.unref();
  } else if ( ENV_PINNED ) {
    console.log("[gm-console] master token pinned by GMC_TOKEN (rotation disabled)");
  } else {
    console.log("[gm-console] master token loaded from secrets.json");
  }
});

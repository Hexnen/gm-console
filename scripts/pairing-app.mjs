/**
 * Pairing window — owns every credential in the system.
 *
 * Two levels, both obtained the same way so nothing long has to be typed:
 *  - the master token, traded for the one-time code the relay prints at startup,
 *    then rotatable from here;
 *  - per-device tablet tokens, traded for a QR code, revocable individually.
 */

import qrcode from "./qrcode.mjs";
import {
  MODULE_ID,
  DEFAULT_KEY,
  SCENE_PREFIX,
  boardFallbackName,
  boardLabel,
  candidateKeys,
  countItems,
  describeChanges,
  readActiveBoard,
  readBackup,
  readCollection,
  restoreBackup,
  sanitizeCollection,
  writeCollection
} from "./boards.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Escape text for interpolation into a DialogV2 content string.
 *
 * Local rather than foundry.utils.escapeHTML so the window keeps working on the
 * whole declared compatibility range, and because board names come from an
 * imported file — the one place in this module where markup could ride in.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/**
 * The two roles the relay knows (relay/server.mjs ROLE_CAPS), in the order they
 * are offered. Hardcoded rather than discovered: the window has to render the
 * choice before it has ever talked to the relay, and a value the relay does not
 * know is refused there with a 400 anyway.
 * @type {string[]}
 */
const ROLES = ["console", "viewer"];

/** What a code with no role asked for gets, on the relay and here alike. */
const DEFAULT_ROLE = "console";

/** Polish names for the roles. The relay's own words are the wire format, not UI. */
const ROLE_LABELS = { console: "konsola", viewer: "widz" };

/**
 * How many log rows to ask the relay for, and how many to actually paint.
 *
 * The relay keeps 300 and would hand over all of them; this section answers
 * "what just happened", so it asks for enough that folding each fire into its
 * result still leaves a full screen, and paints a readable slice of that.
 */
const LOG_FETCH = 60;
const LOG_SHOW = 25;

/** Log events that are not a macro call, and what to call them. */
const EVENT_LABELS = {
  pair: "sparowano tablet",
  revoke: "odłączono tablet",
  role: "zmieniono rolę",
  denied: "odmowa dostępu"
};

/**
 * Normalise whatever arrived as a role into one this window can render.
 *
 * Only "viewer" is taken literally; everything else — absent, misspelt, from a
 * devices.json written before roles existed — reads as `console`, which is the
 * same default the relay applies (relay/server.mjs roleOf). A role the relay
 * cannot parse never reaches us as such: it drops that one to viewer on load.
 * @param {unknown} raw
 * @returns {"console"|"viewer"}
 */
function deviceRole(raw) {
  return (raw === "viewer") ? "viewer" : "console";
}

/**
 * "how long ago", not a timestamp: the question the log answers is always about
 * the last few minutes, and an ISO string makes the reader do the subtraction.
 *
 * The locale is pinned to Polish rather than taken from game.i18n.lang because
 * every other string in this window is hardcoded Polish; mixing "5 minutes ago"
 * into that would be worse than mixing nothing.
 */
const RELATIVE = new Intl.RelativeTimeFormat("pl", { numeric: "auto" });

/** [below this many ms, express it in units of this many ms, unit name] */
const RELATIVE_STEPS = [
  [60_000, 1_000, "second"],
  [3_600_000, 60_000, "minute"],
  [86_400_000, 3_600_000, "hour"],
  [Infinity, 86_400_000, "day"]
];

/**
 * @param {string} iso
 * @returns {string} e.g. "teraz", "5 minut temu"; empty when the stamp is junk.
 */
function timeAgo(iso) {
  const then = Date.parse(iso);
  if ( !Number.isFinite(then) ) return "";
  // Clamp: a tablet-side clock skew must not produce "za 3 minuty" for something
  // that has already been recorded as done.
  const delta = Math.max(0, Date.now() - then);
  for ( const [ceiling, unit, name] of RELATIVE_STEPS ) {
    if ( delta < ceiling ) return RELATIVE.format(-Math.floor(delta / unit), name);
  }
  return "";
}

/**
 * A round trip as a human reads it: milliseconds while they are countable, then
 * one decimal of a second. Polish uses a decimal comma.
 * @param {unknown} ms
 * @returns {string}
 */
function durationLabel(ms) {
  const n = Number(ms);
  if ( !Number.isFinite(n) || (n < 0) ) return "";
  return (n < 1000) ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1).replace(".", ",")} s`;
}

/** Ask the module to republish, if it is loaded and connected. Never throws. */
function republish() {
  try {
    game.modules.get(MODULE_ID)?.api?.pushState?.(true);
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not republish after a board change`, err);
  }
}

/**
 * Would this relay address be meaningless on another device?
 *
 * Loopback resolves relative to whoever asks, so a tablet scanning a QR built
 * from it looks for the relay on itself. This is a warning, never a block: the
 * GM may be about to change the address, and an unusual but valid setup should
 * not be refused on a guess. Nothing downstream can catch this — the scan simply
 * fails to load — so it has to be said where the address is still visible.
 * @param {string} base
 * @returns {boolean}
 */
function unreachableFromTablet(base) {
  let host;
  try {
    ({ hostname: host } = new URL(base));
  } catch {
    return false;                       // not our job to validate the URL itself
  }
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (bare === "localhost") || bare.endsWith(".localhost")
    || bare.startsWith("127.") || (bare === "::1") || (bare === "0.0.0.0");
}

/**
 * Read relay settings without importing the main module (avoids a cycle).
 *
 * Deliberately unlike the module's own config(): this window has to work in
 * exactly the state that one refuses — relay URL set, no token yet — because it
 * is where the token comes from.
 */
function relayConfig() {
  const base = game.settings.get(MODULE_ID, "relayUrl").trim().replace(/\/+$/, "");
  const token = game.settings.get(MODULE_ID, "token").trim();
  return base ? { base, token } : null;
}

// Nothing here calls the module's reconnect(). Writing the token setting is
// enough: its onChange does it, and Foundry fires that exactly once per real
// change (client/helpers/client-settings.mjs:322-327). Doing both built and tore
// down two EventSources per credential change, which is how a stale in-flight
// retry got the chance to leave a second live stream behind.

export class PairingApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "gm-console-pairing",
    tag: "div",
    classes: ["gm-console", "gm-console-pairing"],
    window: {
      title: "GMCONSOLE.Pairing.Title",
      icon: "fa-solid fa-qrcode",
      resizable: false
    },
    position: { width: 460, height: "auto" },
    actions: {
      autoConnect: PairingApp.#onAutoConnect,
      copy: PairingApp.#onCopy,
      claimMaster: PairingApp.#onClaimMaster,
      rotateMaster: PairingApp.#onRotateMaster,
      clearToken: PairingApp.#onClearToken,
      newCode: PairingApp.#onNewCode,
      revoke: PairingApp.#onRevoke,
      refreshLog: PairingApp.#onRefreshLog,
      exportCopy: PairingApp.#onExportCopy,
      exportFile: PairingApp.#onExportFile,
      importPaste: PairingApp.#onImportPaste,
      importFile: PairingApp.#onImportFile,
      restorePrevious: PairingApp.#onRestorePrevious,
      boardForScene: PairingApp.#onBoardForScene,
      boardDelete: PairingApp.#onBoardDelete
    }
  };

  static PARTS = {
    main: { template: "modules/gm-console/templates/pairing.hbs" }
  };

  /**
   * The one live window.
   *
   * SettingsConfig opens a submenu with `new menu.type()` on every click
   * (client/applications/settings/config.mjs:212), so a second click used to build
   * a second application sharing the DOM id `gm-console-pairing` and registering a
   * second gmConsoleDevices hook — closing either one then tore down the shared
   * element and left the other hook alive.
   * @type {PairingApp|null}
   */
  static #instance = null;

  /**
   * A derived constructor is allowed to return an object before calling super():
   * `new` yields that object and this second, never-initialised application is
   * discarded. That is the only place to intercept, since the caller is Foundry.
   * @param {object} [options]
   */
  constructor(options={}) {
    if ( PairingApp.#instance ) return PairingApp.#instance;
    super(options);
    PairingApp.#instance = this;
  }

  /** @type {{code: string, expiresIn: number, role?: string}|null} */
  #pairing = null;
  /**
   * The role the *next* code is minted for. Chosen before the code exists,
   * because the role rides on the code and a tablet cannot be promoted by asking.
   * @type {"console"|"viewer"}
   */
  #pairRole = DEFAULT_ROLE;
  /** @type {object[]} */
  #devices = [];
  /**
   * Raw log rows, newest first, exactly as the relay returned them.
   * @type {object[]}
   */
  #log = [];
  /** How many entries the relay is holding, which is more than we paint. */
  #logTotal = 0;
  /**
   * Whether the last log fetch worked. A failed one keeps the rows it already
   * had rather than blanking them, so "failed" is the only thing that can tell
   * an empty section apart from a refused one — a 403 or 401 must never read as
   * "nothing happened".
   * @type {"unknown"|"ok"|"failed"}
   */
  #logState = "unknown";
  /** @type {string} */
  #error = "";
  /** @type {string} */
  #notice = "";
  /**
   * Whether the stored token actually works. A non-empty setting is not proof:
   * a token from a previous relay leaves the window showing "connected" with no
   * way back to the bootstrap form.
   * @type {"unknown"|"ok"|"bad"|"offline"}
   */
  #auth = "unknown";
  /**
   * Bootstrap code the relay volunteered because we are on its own network.
   * Empty when the relay is remote, in which case the code has to be read from
   * its log or bootstrap-code.txt and typed.
   * @type {string}
   */
  #localCode = "";
  /**
   * What the relay said when asked for a bootstrap code. "claimed" is the one
   * that matters: it means no code exists anywhere and every code the GM could
   * type will be refused, so the window must stop asking for one.
   * @type {"unknown"|"available"|"claimed"|"remote"}
   */
  #codeState = "unknown";

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const cfg = relayConfig();
    context.configured = !!cfg;
    context.relayUrl = cfg?.base ?? "";
    context.connected = this.#auth === "ok";
    context.staleToken = (this.#auth === "bad") && !!cfg?.token;
    context.offline = this.#auth === "offline";
    context.hasToken = !!cfg?.token;
    context.canAutoConnect = !!this.#localCode;
    context.relayClaimed = this.#codeState === "claimed";
    context.tokenMasked = cfg?.token ? `${cfg.token.slice(0, 6)}…${cfg.token.slice(-4)}` : "";
    context.error = this.#error;
    context.notice = this.#notice;
    // Shaped here rather than in the template: `selected` needs a boolean, and
    // the role a device reports still has to be normalised before it is shown.
    context.devices = this.#devices.map(d => {
      const role = deviceRole(d.role);
      return { id: d.id, name: d.name, role, isViewer: role === "viewer" };
    });
    context.hasViewer = context.devices.some(d => d.isViewer);

    context.pairRoleViewer = this.#pairRole === "viewer";

    if ( (this.#auth === "ok") && this.#pairing ) {
      const url = `${cfg.base}/?pair=${this.#pairing.code}`;
      context.code = this.#pairing.code;
      context.pairUrl = url;
      context.qrSvg = this.#renderQr(url);
      // A QR encodes the relay URL verbatim, and a loopback or bare-hostname one
      // is perfectly scannable and completely useless from a tablet: the code
      // resolves on the phone to the phone. Nothing downstream can detect this —
      // the scan simply fails to load — so say it here, where the address is
      // still visible next to the thing that will carry it.
      context.qrUnreachable = unreachableFromTablet(cfg.base);
      context.expiresMinutes = Math.round(this.#pairing.expiresIn / 60000);
      // The relay echoes the role it actually minted the code for. Show that,
      // not what the select says: they can only differ if minting failed, and
      // that is the one moment the difference matters.
      context.codeRoleLabel = ROLE_LABELS[deviceRole(this.#pairing.role)];
      context.codeIsViewer = deviceRole(this.#pairing.role) === "viewer";
    }

    Object.assign(context, this.#logContext());

    Object.assign(context, this.#boardsContext());
    return context;
  }

  /**
   * Everything the boards / backup half of the window shows.
   *
   * Read fresh on every render rather than cached: the active board follows the
   * viewed scene, so it can change while this window is open.
   * @returns {object}
   */
  #boardsContext() {
    const { key: activeKey, collection } = readActiveBoard();
    const boards = Object.entries(collection.boards).map(([key, board]) => ({
      key,
      label: boardLabel(key, board),
      groups: board.groups?.length ?? 0,
      items: countItems(board),
      active: key === activeKey,
      // The default board is the last fallback for every scene and system; with
      // it gone a board could resolve to nothing at all.
      removable: key !== DEFAULT_KEY
    }));

    // A scene key is among the candidates only while a scene is actually in view,
    // so its absence is also how the window knows there is nothing to make a
    // board for (an empty world, or no-canvas mode with no active scene).
    const sceneKey = candidateKeys().find(k => k.startsWith(SCENE_PREFIX)) ?? "";
    const backup = readBackup();

    return {
      boards,
      activeBoardLabel: boards.find(b => b.active)?.label ?? "",
      sceneBoardName: sceneKey ? boardFallbackName(sceneKey) : "",
      canMakeSceneBoard: !!sceneKey && !collection.boards[sceneKey],
      hasBackup: !!backup,
      backupWhen: backup ? new Date(backup.at).toLocaleString() : "",
      backupReason: backup?.reason ?? "",
      backupBoards: backup ? Object.keys(backup.data.boards).length : 0
    };
  }

  /**
   * Everything the "recent actions" section shows.
   *
   * Recomputed on every render rather than at fetch time, because both halves of
   * a row age: the relative time moves, and a macro can be renamed or deleted
   * while this window is open.
   * @returns {object}
   */
  #logContext() {
    const rows = this.#logRows();
    return {
      log: rows,
      logFailed: this.#logState === "failed",
      logTotal: this.#logTotal,
      // Only worth saying when something was actually left out.
      logMore: this.#logTotal > rows.length
    };
  }

  /**
   * Fold the raw log into one line per thing that happened.
   *
   * The relay records a `fire` when a tablet asks and a `result` when the answer
   * comes back, so painting the rows as they arrive shows every macro call
   * twice. Walking newest-first, a result is always seen before its own fire, so
   * a result can claim the next older fire for the same device and macro and
   * that fire drops out. A fire with no result left to claim is a call that was
   * never answered, and saying so is more useful than hiding it.
   * @returns {object[]}
   */
  #logRows() {
    const rows = [];
    /** @type {Map<string, number>} results seen but not yet matched to a fire */
    const answered = new Map();

    for ( const entry of this.#log ) {
      if ( rows.length >= LOG_SHOW ) break;
      const at = String(entry.at ?? "");
      const base = {
        when: timeAgo(at),
        // Plain `title`, never data-tooltip: Foundry pushes a tooltip's text
        // through innerHTML (client/helpers/interaction/tooltip-manager.mjs:264)
        // and reads it from the *decoded* dataset, so Handlebars' escaping would
        // be undone on the way in. Device and macro names are not ours.
        exact: at ? new Date(at).toLocaleString() : "",
        device: String(entry.device ?? entry.deviceId ?? "?")
      };
      // Unambiguous by construction: a macro id is forwarded from a tablet, so
      // it could otherwise carry whatever separator this joined on.
      const key = JSON.stringify([entry.deviceId ?? "", entry.macroId ?? ""]);

      switch ( entry.event ) {
        case "result":
        case "timeout": {
          answered.set(key, (answered.get(key) ?? 0) + 1);
          const ok = (entry.event === "result") && (entry.ok !== false);
          rows.push({
            ...base,
            ...this.#macroLabel(entry.macroId),
            status: ok ? "ok" : "fail",
            statusLabel: ok ? "OK" : "błąd",
            duration: durationLabel(entry.ms),
            // A successful roll's own output belongs in chat, not here; a
            // failure's message is the only reason to open this section.
            detail: (entry.event === "timeout") ? "brak odpowiedzi" : (ok ? "" : String(entry.text ?? "")),
            showDetail: !ok
          });
          break;
        }
        case "fire": {
          const seen = answered.get(key) ?? 0;
          if ( seen > 0 ) {
            answered.set(key, seen - 1);
            break;
          }
          rows.push({
            ...base,
            ...this.#macroLabel(entry.macroId),
            status: "pending",
            statusLabel: "w toku",
            duration: "",
            detail: "",
            showDetail: false
          });
          break;
        }
        default: {
          // pair / revoke / role / denied, and anything a later relay adds.
          const denied = entry.event === "denied";
          const role = ROLE_LABELS[deviceRole(entry.role)];
          rows.push({
            ...base,
            what: EVENT_LABELS[entry.event] ?? String(entry.event ?? "?"),
            unknownMacro: false,
            status: denied ? "fail" : "info",
            // For a role change this is the role it ended up with, which is the
            // whole content of the event; for a refusal it is what was refused.
            statusLabel: denied ? "odmowa" : role,
            duration: "",
            detail: denied ? `${role} → ${entry.path ?? ""}` : "",
            showDetail: denied
          });
        }
      }
    }
    return rows;
  }

  /**
   * What to call the macro a row is about.
   *
   * The log stores ids on purpose — a rename must not rewrite history, and a
   * deleted macro still has to be identifiable — so the name is resolved now,
   * against the world as it currently is, and the id stands in when the macro is
   * gone. `unknownMacro` lets the template render that fallback as an id rather
   * than as a name nobody wrote.
   * @param {unknown} macroId
   * @returns {{what: string, unknownMacro: boolean}}
   */
  #macroLabel(macroId) {
    const id = String(macroId ?? "");
    if ( !id ) return { what: "(bez makra)", unknownMacro: false };
    const name = game.macros?.get(id)?.name;
    return name ? { what: name, unknownMacro: false } : { what: id, unknownMacro: true };
  }

  /**
   * The collection as a formatted JSON document — what both export routes hand
   * out, so a copied blob and a downloaded file are byte-identical.
   * @returns {string}
   */
  #exportJson() {
    return JSON.stringify(readCollection(), null, 2);
  }

  /**
   * Build the QR as an inline SVG. Type 0 lets the encoder pick the smallest
   * version that fits; L is fine because the code is short-lived and on-screen.
   * @param {string} text
   * @returns {string}
   */
  #renderQr(text) {
    try {
      const qr = qrcode(0, "L");
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch ( err ) {
      console.error(`${MODULE_ID} | QR generation failed`, err);
      return "";
    }
  }

  /**
   * Talk to the relay *before* the window is painted. _onFirstRender is too late:
   * the app is already RENDERED by then, so the frame shows the bootstrap form
   * (#auth still "unknown") and a second render swaps it for the connected view —
   * a visible flash. _preFirstRender is awaited between _prepareContext and
   * _renderHTML (client/applications/api/application.mjs:532-557) and is handed
   * the very context object that is about to be rendered, so refreshing that
   * object in place gets the right view on the first and only paint.
   * @inheritDoc
   */
  async _preFirstRender(context, options) {
    await super._preFirstRender(context, options);
    // The window is a singleton, so a reopen lands on the same object; a notice
    // left over from the previous session would be stale by now. (Closing sets
    // the state to CLOSED, which is below NONE, so this runs again on reopen —
    // client/applications/api/application.mjs:113-114,520.)
    this.#error = this.#notice = "";
    await this.#verify();
    if ( this.#auth === "ok" ) {
      await this.#refresh();
      await this.#loadDevices();
      await this.#loadLog();
    } else {
      await this.#probeLocalCode();
    }
    Object.assign(context, await this._prepareContext(options));
  }

  /**
   * Ask the relay whether the stored token is still good, so the window can show
   * the bootstrap form instead of a dead "connected" state.
   */
  async #verify() {
    const cfg = relayConfig();
    if ( !cfg?.token ) {
      this.#auth = "bad";
      return;
    }
    try {
      const res = await fetch(`${cfg.base}/api/ping?token=${encodeURIComponent(cfg.token)}`, { cache: "no-store" });
      if ( !res.ok ) {
        this.#auth = "bad";
        return;
      }
      // A *device* token also gets a 200 from /api/ping. Every control in this
      // window needs the master level, so treat anything else as no credential
      // at all rather than showing a connected state whose buttons all 403.
      const { level } = await res.json().catch(() => ({}));
      this.#auth = (level === "master") ? "ok" : "bad";
    } catch {
      this.#auth = "offline";
    }
  }

  /**
   * See whether the relay will simply hand us its bootstrap code. It does that
   * only while unclaimed and only for callers on its own network, where the code
   * guards nothing anyone on that network could not already reach. When it does,
   * connecting is one button and no secret is ever copied by hand.
   */
  async #probeLocalCode() {
    const cfg = relayConfig();
    this.#localCode = "";
    this.#codeState = "unknown";
    if ( !cfg ) return;
    try {
      const res = await fetch(`${cfg.base}/api/master/code`, { cache: "no-store" });
      // Tell the two refusals apart, because they need opposite advice.
      // 409 "already claimed" (relay/server.mjs:332) means the relay has a master
      // token and mints no code at all — bootstrap-code.txt still holds the spent
      // one, so telling the GM to look there is the dead end this window used to
      // walk into. 403 only means we are off its network and the printed code is
      // still good (relay/server.mjs:333-335).
      if ( res.status === 409 ) this.#codeState = "claimed";
      else if ( res.status === 403 ) this.#codeState = "remote";
      else if ( res.ok ) {
        this.#localCode = (await res.json()).code ?? "";
        if ( this.#localCode ) this.#codeState = "available";
      }
    } catch {
      // Relay unreachable; #verify already recorded that.
    }
  }

  /**
   * Ask the relay for a fresh tablet pairing code.
   * Does not render — callers decide, so first render can paint just once.
   */
  async #refresh() {
    const cfg = relayConfig();
    if ( !cfg?.token ) return;
    this.#error = "";
    try {
      const res = await fetch(`${cfg.base}/api/pair/new?token=${encodeURIComponent(cfg.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The role belongs to the code: the tablet claims it and is stuck with
        // whatever it was minted for, so this is the only moment it is decided.
        body: JSON.stringify({ role: this.#pairRole })
      });
      if ( !res.ok ) throw new Error(`relay said ${res.status}`);
      this.#pairing = await res.json();
    } catch ( err ) {
      this.#error = `Nie udało się pobrać kodu: ${err.message}`;
      this.#pairing = null;
    }
  }

  /**
   * Pull the action log.
   *
   * Kept separate from the device list because it is refreshed on its own, and
   * because a refusal here has to be visible: dropping to an empty list would
   * claim nothing has happened, which is the opposite of what a 401/403 means.
   * Nothing polls — the times are relative and a stale one is off by minutes,
   * not wrong, and a timer on a singleton window is a leak waiting to happen.
   */
  async #loadLog() {
    const cfg = relayConfig();
    if ( !cfg?.token ) return;
    try {
      const res = await fetch(
        `${cfg.base}/api/log?token=${encodeURIComponent(cfg.token)}&limit=${LOG_FETCH}`,
        { cache: "no-store" }
      );
      // A refusal is plain text ("bad token"), not JSON, so the status is the
      // only thing safe to read off it.
      if ( !res.ok ) throw new Error(`relay said ${res.status}`);
      const data = await res.json();
      this.#log = Array.isArray(data.entries) ? data.entries : [];
      this.#logTotal = Number.isFinite(data.total) ? data.total : this.#log.length;
      this.#logState = "ok";
    } catch ( err ) {
      // Keep the rows already on screen; they are old, not invented.
      this.#logState = "failed";
      this.#error = `Nie udało się pobrać dziennika: ${err.message}`;
    }
  }

  /**
   * Pull the paired-device list. The relay also pushes it over the GM stream,
   * but only on GM connect / pair / revoke — a window opened at any other moment
   * would otherwise sit on an empty list with the revoke buttons out of reach.
   */
  async #loadDevices() {
    const cfg = relayConfig();
    if ( !cfg?.token ) return;
    try {
      const res = await fetch(`${cfg.base}/api/devices?token=${encodeURIComponent(cfg.token)}`, { cache: "no-store" });
      if ( !res.ok ) throw new Error(`relay said ${res.status}`);
      const data = await res.json();
      this.#devices = data.devices ?? [];
    } catch ( err ) {
      console.warn(`${MODULE_ID} | could not list paired devices`, err);
    }
  }

  /* -------------------------------------------- */
  /*  Master token                                */
  /* -------------------------------------------- */

  /**
   * Copy whatever the button carries in `data-copy`.
   *
   * Goes through game.clipboard rather than navigator.clipboard directly: the
   * latter is unavailable in an insecure context, and Foundry is commonly served
   * over plain http, where the helper falls back to an execCommand copy.
   */
  static async #onCopy(event, target) {
    const text = target.dataset.copy ?? "";
    if ( !text ) return;
    await game.clipboard.copyPlainText(text);
    ui.notifications.info(game.i18n.localize("GMCONSOLE.Pairing.Copied"));
  }

  /** One-click path: the relay already told us the code because we are local. */
  static async #onAutoConnect() {
    if ( !this.#localCode ) return;
    await PairingApp.#claimWith.call(this, this.#localCode);
  }

  static async #onClaimMaster() {
    const input = this.element.querySelector("input[name=bootstrap]");
    const code = (input?.value ?? "").trim().toUpperCase();
    if ( !code ) {
      this.#error = "Wpisz kod startowy z konsoli relaya.";
      return this.render();
    }
    await PairingApp.#claimWith.call(this, code);
  }

  /**
   * Exchange a bootstrap code for the master token and store it.
   * @param {string} code
   */
  static async #claimWith(code) {
    const cfg = relayConfig();
    this.#error = this.#notice = "";
    if ( !cfg ) {
      this.#error = "Najpierw ustaw adres relaya.";
      return this.render();
    }
    if ( !code ) {
      this.#error = "Wpisz kod startowy z konsoli relaya.";
      return this.render();
    }
    try {
      const res = await fetch(`${cfg.base}/api/master/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });
      const data = await res.json().catch(() => ({}));
      if ( !res.ok ) throw new Error(data.error ?? `relay said ${res.status}`);
      // Writing the setting is what reconnects the module — see the note above.
      await game.settings.set(MODULE_ID, "token", data.token);
      this.#auth = "ok";
      this.#localCode = "";          // spent
      this.#codeState = "claimed";
      this.#notice = "Połączono. Token zapisany.";
      await this.#refresh();
      await this.#loadDevices();
      await this.#loadLog();
    } catch ( err ) {
      this.#error = `Nie udało się połączyć: ${err.message}`;
    }
    this.render();
  }

  static async #onRotateMaster() {
    const cfg = relayConfig();
    if ( !cfg?.token ) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Nowy token" },
      content: "<p>Wygenerować nowy token główny? Ta przeglądarka przełączy się automatycznie; sparowane tablety działają dalej.</p>"
    });
    if ( !ok ) return;

    this.#error = this.#notice = "";
    try {
      const res = await fetch(`${cfg.base}/api/master/rotate?token=${encodeURIComponent(cfg.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      const data = await res.json().catch(() => ({}));
      if ( !res.ok ) throw new Error(data.error ?? `relay said ${res.status}`);
      // The relay ends every GM stream before it answers this request, so the
      // module is already reconnecting by now; setting the token is what hands it
      // the new credential, and its onChange restarts the stream once.
      await game.settings.set(MODULE_ID, "token", data.token);
      this.#notice = "Token wymieniony.";
      await this.#refresh();
      await this.#loadDevices();
    } catch ( err ) {
      this.#error = `Nie udało się wymienić tokenu: ${err.message}`;
    }
    this.render();
  }

  /* -------------------------------------------- */
  /*  Devices                                     */
  /* -------------------------------------------- */

  /**
   * Escape hatch: forget a token the relay no longer accepts.
   *
   * Clearing it does not un-claim the relay — once it has a master token both
   * /api/master/code and /api/master/claim answer 409 forever
   * (relay/server.mjs:332,343) — so the old "now type the bootstrap code" advice
   * pointed at a code that cannot exist and left the window with no way forward.
   * Re-probe instead, and only promise a code when the relay really has one.
   */
  static async #onClearToken() {
    await game.settings.set(MODULE_ID, "token", "");
    this.#auth = "bad";
    this.#pairing = null;
    this.#devices = [];
    // The log came with the credential that is being forgotten; keeping it on
    // screen would outlive the right to read it.
    this.#log = [];
    this.#logTotal = 0;
    this.#logState = "unknown";
    this.#error = "";
    await this.#probeLocalCode();
    this.#notice = this.#localCode
      ? "Token wyczyszczony. Relay czeka na sparowanie — kliknij „Połącz z relayem”."
      : "Token wyczyszczony.";
    this.render();
  }

  /** Refresh both halves of the window: a new pairing code and the current device list. */
  static async #onNewCode() {
    await this.#refresh();
    await this.#loadDevices();
    this.render();
  }

  /**
   * One delegated change listener for every <select> in this window.
   *
   * data-action cannot drive one: ApplicationV2 binds only click and auxclick
   * (client/applications/api/application.mjs:1824-1830), so a keyboard change of
   * a select would never be heard. The frame element outlives part re-renders
   * and this reference is stable, so re-binding it every render is a no-op
   * rather than a second listener — the same reason #onFileChosen is a field.
   * @type {(event: Event) => void}
   */
  #onSelectChange = event => {
    const select = event.target;
    if ( !(select instanceof HTMLSelectElement) ) return;
    if ( select.name === "pairRole" ) this.#setPairRole(select.value);
    else if ( select.name === "deviceRole" ) this.#setDeviceRole(select);
  };

  /**
   * Choose what the next pairing code will be worth, and mint it again at once.
   *
   * Re-minting is the point: a code carries the role it was created with, so
   * leaving the old QR on screen under the new label would hand a player's
   * tablet the console rights this control exists to withhold.
   * @param {string} role
   */
  async #setPairRole(role) {
    const next = ROLES.includes(role) ? role : DEFAULT_ROLE;
    if ( next === this.#pairRole ) return;
    this.#pairRole = next;
    this.#error = this.#notice = "";
    // Drop the old code first, so a failed mint leaves no code at all rather
    // than the previous role's code sitting under the new heading.
    this.#pairing = null;
    await this.#refresh();
    this.render();
  }

  /**
   * Change what an already-paired tablet may do, without re-pairing it.
   * @param {HTMLSelectElement} select
   */
  async #setDeviceRole(select) {
    const id = select.closest("[data-device-id]")?.dataset.deviceId;
    const cfg = relayConfig();
    if ( !id || !cfg?.token ) return;
    this.#error = this.#notice = "";
    // The round trip is short, but a second change on the way would race the
    // first one's answer and the list would settle on whichever replied last.
    select.disabled = true;
    try {
      const res = await fetch(`${cfg.base}/api/devices/role?token=${encodeURIComponent(cfg.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, role: select.value })
      });
      // Same as revoke: 401 and 403 answer in plain text, so parsing first would
      // report a syntax error instead of the refusal.
      if ( !res.ok ) throw new Error(`relay said ${res.status}`);
      const data = await res.json();
      // Show what the relay says the devices are now, never what was clicked —
      // that is the difference between reporting a role and reporting a wish.
      this.#devices = data.devices ?? [];
      const shown = this.#devices.find(d => d.id === id);
      this.#notice = `„${shown?.name ?? id}” — teraz ${ROLE_LABELS[deviceRole(shown?.role)]}.`;
    } catch ( err ) {
      // #devices still holds the old role, so re-rendering puts the select back
      // where it was: the control must not show a change that did not happen.
      this.#error = `Nie udało się zmienić roli: ${err.message}`;
    }
    this.render();
  }

  static async #onRevoke(event, target) {
    const id = target.closest("[data-device-id]")?.dataset.deviceId;
    const cfg = relayConfig();
    if ( !id || !cfg?.token ) return;
    try {
      const res = await fetch(`${cfg.base}/api/devices/revoke?token=${encodeURIComponent(cfg.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      // A refusal is plain text, not JSON, so parsing first turned "403" into a
      // syntax error and the window blamed the wrong thing.
      if ( !res.ok ) throw new Error(`relay said ${res.status}`);
      const data = await res.json();
      this.#devices = data.devices ?? [];
    } catch ( err ) {
      this.#error = `Nie udało się odłączyć: ${err.message}`;
    }
    this.render();
  }

  /* -------------------------------------------- */
  /*  Action log                                  */
  /* -------------------------------------------- */

  static async #onRefreshLog() {
    this.#error = this.#notice = "";
    await this.#loadLog();
    this.render();
  }

  /* -------------------------------------------- */
  /*  Boards: export                              */
  /* -------------------------------------------- */

  /** Put the whole collection on the clipboard as formatted JSON. */
  static async #onExportCopy() {
    await game.clipboard.copyPlainText(this.#exportJson());
    ui.notifications.info(game.i18n.localize("GMCONSOLE.Pairing.Copied"));
  }

  /**
   * Download the collection as a file.
   *
   * foundry.utils.saveDataToFile (client/utils/helpers.mjs:117-128) already does
   * the Blob + object-URL + synthetic click dance, including revoking the URL
   * afterwards, so there is nothing to hand-roll here.
   */
  static #onExportFile() {
    // The world id is already a package-style slug, but it comes from a world
    // manifest, and this string ends up in a Content-Disposition filename.
    const world = String(game.world.id).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "world";
    const stamp = new Date().toISOString().slice(0, 10);
    foundry.utils.saveDataToFile(this.#exportJson(), "application/json",
      `gm-console-plansze-${world}-${stamp}.json`);
    this.#notice = "Zapisano plik z planszami.";
    this.render();
  }

  /* -------------------------------------------- */
  /*  Boards: import                              */
  /* -------------------------------------------- */

  static async #onImportPaste() {
    const text = this.element.querySelector("textarea[name=boardsJson]")?.value ?? "";
    if ( !text.trim() ) {
      this.#error = "Wklej najpierw JSON z planszami.";
      return this.render();
    }
    await PairingApp.#importFrom.call(this, text, "wklejony JSON");
  }

  /** The visible button only opens the file chooser; #onFileChosen does the work. */
  static #onImportFile() {
    this.element.querySelector("input[name=boardsFile]")?.click();
  }

  /**
   * A stable reference so re-binding it after every render is a no-op rather than
   * a second listener — one chosen file would otherwise be imported twice.
   * @type {(event: Event) => void}
   */
  #onFileChosen = event => {
    const file = event.target.files?.[0];
    // Clear first: choosing the same file twice in a row fires no change event
    // otherwise, so a failed import could not be retried without reopening.
    event.target.value = "";
    if ( !file ) return;
    foundry.utils.readTextFromFile(file)
      .then(text => PairingApp.#importFrom.call(this, text, file.name))
      .catch(() => {
        this.#error = "Nie udało się odczytać pliku.";
        this.render();
      });
  };

  /**
   * Validate, show exactly what would change, and only then overwrite.
   *
   * Nothing is written before the GM has confirmed, and writeCollection keeps the
   * outgoing collection in the undo slot, so even a confirmed mistake is one
   * button from being put back.
   * @param {string} text     Raw JSON.
   * @param {string} source   Where it came from, for the messages.
   */
  static async #importFrom(text, source) {
    this.#error = this.#notice = "";
    let incoming;
    try {
      // Two separate failures with two different fixes: malformed JSON, and
      // well-formed JSON that is not a board file. Say which.
      const parsed = JSON.parse(text);
      incoming = sanitizeCollection(parsed);
    } catch ( err ) {
      const why = (err instanceof SyntaxError) ? "to nie jest poprawny JSON" : err.message;
      this.#error = `Import (${source}) odrzucony: ${why}`;
      return this.render();
    }

    // Read once and hold it across the dialog. This is the base the import is a
    // delta of; recovering it at write time instead would pick up whatever a
    // tablet saved while the GM was reading the confirmation, and the import
    // would then silently revert that save — or resurrect a board deleted in
    // the meantime.
    const current = readCollection();
    const rows = describeChanges(current, incoming);
    const labels = { added: "nowa", replaced: "nadpisana", removed: "usunięta" };
    const list = rows.map(row => `<li><strong>${escapeHtml(row.name)}</strong>
      <code>${escapeHtml(row.key)}</code> — ${labels[row.status]}
      (${row.groups} grup, ${row.items} kafelków)</li>`).join("");

    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Import plansz" },
      position: { width: 480 },
      content: `<p>Z <code>${escapeHtml(source)}</code>. Po imporcie plansze będą wyglądać tak:</p>
        <ul class="gmc-pair__changes">${list}</ul>
        <p>Poprzedni układ zostanie zachowany i można go cofnąć jednym kliknięciem.</p>`,
      yes: { label: "Nadpisz plansze", icon: "fa-solid fa-file-import" },
      no: { label: "Anuluj" }
    });
    if ( !ok ) return;

    try {
      await writeCollection(incoming, { reason: `import: ${source}`, base: current });
      republish();
      // Optional: the GM can close the window while the confirmation dialog is
      // up, and ApplicationV2 drops its element on close.
      const textarea = this.element?.querySelector("textarea[name=boardsJson]");
      if ( textarea ) textarea.value = "";
      this.#notice = `Zaimportowano ${Object.keys(incoming.boards).length} plansz.`;
    } catch ( err ) {
      this.#error = `Nie udało się zapisać plansz: ${err.message}`;
    }
    this.render();
  }

  /* -------------------------------------------- */
  /*  Boards: undo and per-scene boards           */
  /* -------------------------------------------- */

  /** Put the previous collection back. The one it displaces becomes the new undo slot. */
  static async #onRestorePrevious() {
    const backup = readBackup();
    if ( !backup ) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Przywróć poprzednie plansze" },
      content: `<p>Przywrócić układ z <strong>${escapeHtml(new Date(backup.at).toLocaleString())}</strong>
        (${Object.keys(backup.data.boards).length} plansz)?</p>
        <p>Obecny układ trafi do kopii, więc tę operację też da się cofnąć.</p>`,
      yes: { label: "Przywróć", icon: "fa-solid fa-clock-rotate-left" },
      no: { label: "Anuluj" }
    });
    if ( !ok ) return;
    this.#error = this.#notice = "";
    try {
      await restoreBackup();
      republish();
      this.#notice = "Przywrócono poprzedni układ plansz.";
    } catch ( err ) {
      this.#error = `Nie udało się przywrócić: ${err.message}`;
    }
    this.render();
  }

  /**
   * Give the scene in view a board of its own, copied from the one it currently
   * falls back to — so the GM starts from what is already on the tablet rather
   * than from nothing.
   */
  static async #onBoardForScene() {
    const { key: activeKey, collection } = readActiveBoard();
    const sceneKey = candidateKeys().find(k => k.startsWith(SCENE_PREFIX));
    if ( !sceneKey || collection.boards[sceneKey] ) return;
    this.#error = this.#notice = "";
    const next = foundry.utils.deepClone(collection);
    next.boards[sceneKey] = {
      name: boardFallbackName(sceneKey),
      groups: foundry.utils.deepClone(collection.boards[activeKey]?.groups ?? [])
    };
    try {
      // `collection` is what `next` was cloned from, so it is the true base of
      // this delta; letting it be recovered at write time would risk adopting a
      // tablet's concurrent save as the base and reverting it.
      await writeCollection(next, { reason: "nowa plansza sceny", base: collection });
      republish();
      this.#notice = `Utworzono planszę „${boardFallbackName(sceneKey)}”.`;
    } catch ( err ) {
      this.#error = `Nie udało się utworzyć planszy: ${err.message}`;
    }
    this.render();
  }

  static async #onBoardDelete(event, target) {
    const key = target.closest("[data-board-key]")?.dataset.boardKey;
    const collection = readCollection();
    if ( !key || (key === DEFAULT_KEY) || !collection.boards[key] ) return;
    const label = boardLabel(key, collection.boards[key]);
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Usuń planszę" },
      content: `<p>Usunąć planszę <strong>${escapeHtml(label)}</strong>?
        Ta scena wróci do planszy systemu albo domyślnej.</p>
        <p>Poprzedni układ zostanie zachowany i można go cofnąć.</p>`,
      yes: { label: "Usuń", icon: "fa-solid fa-trash" },
      no: { label: "Anuluj" }
    });
    if ( !ok ) return;
    this.#error = this.#notice = "";
    const next = foundry.utils.deepClone(collection);
    delete next.boards[key];
    try {
      // Read before the confirmation dialog, so it is the state the GM actually
      // decided against — and the only base under which "remove this key" can be
      // told apart from "this key was never here".
      await writeCollection(next, { reason: `usunięcie planszy ${key}`, base: collection });
      republish();
      this.#notice = `Usunięto planszę „${label}”.`;
    } catch ( err ) {
      this.#error = `Nie udało się usunąć planszy: ${err.message}`;
    }
    this.render();
  }

  _onRender(context, options) {
    super._onRender(context, options);
    // The relay pushes the device list over the GM stream; mirror it here.
    this._deviceHook ??= Hooks.on("gmConsoleDevices", devices => {
      this.#devices = devices;
      if ( this.rendered ) this.render();
    });
    // A hidden file input cannot be driven by a data-action, which only ever
    // yields a click. Re-bound every render because Handlebars parts replace
    // their DOM; the listener reference is stable, so re-binding the same node
    // is a no-op rather than a duplicate.
    this.element?.querySelector("input[name=boardsFile]")
      ?.addEventListener("change", this.#onFileChosen);
    // Delegated on the frame, which survives part re-renders, so the per-device
    // selects that Handlebars rebuilds each time need no binding of their own.
    this.element?.addEventListener("change", this.#onSelectChange);
  }

  async close(options) {
    if ( this._deviceHook ) Hooks.off("gmConsoleDevices", this._deviceHook);
    this._deviceHook = null;
    return super.close(options);
  }
}

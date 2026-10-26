/**
 * Board storage for the GM console.
 *
 * One flat console does not fit two game systems and thirty scenes, so what used
 * to be a single arrangement is now a keyed collection of them, and the module
 * serves whichever board matches where the GM currently is. This file owns the
 * whole of that storage: the shape, the migration off the old single board, the
 * sanitising of anything that arrives from outside Foundry, and the backup a bad
 * write can be undone from.
 *
 * It imports nothing, so both the module entry point and the pairing window can
 * use it without a cycle, and every pure function below can be exercised outside
 * a browser. Foundry globals are touched only inside functions, never at load.
 */

export const MODULE_ID = "gm-console";

/** The pre-2.1 flag: one board, `{groups: [...]}`. Read for migration, never written again. */
export const LAYOUT_FLAG = "layout";
/** The keyed collection: `{version, boards: {[key]: {name, groups}}}`. */
export const BOARDS_FLAG = "layouts";
/** The undo history: a bounded, newest-first list. A JSON *string*, see writeBackup for why. */
export const BACKUP_FLAG = "layoutsBackup";

/**
 * The GM's starred macros: a bare array of ids, on the same User document.
 *
 * A flag of its own rather than a field inside the collection. A favourite is not
 * part of any board — it outlives switching scene, which is the whole point of it
 * — and folding it into `layouts` would make one star cost a whole-collection
 * write *plus* the snapshot writeCollection takes, so a dozen taps would push
 * every board edit off the end of the undo history and leave it holding nothing
 * but "I starred something".
 */
export const FAVORITES_FLAG = "favorites";

export const BOARDS_VERSION = 2;
export const DEFAULT_KEY = "default";
export const DEFAULT_NAME = "Domyślna";
export const SCENE_PREFIX = "scene:";
export const SYSTEM_PREFIX = "system:";

const SLOT_COUNT = 50;
const PAGE_SIZE = 10;

/* Caps for data that arrives from a tablet or an imported file, i.e. from outside
 * Foundry's own validation. */
export const MAX_BOARDS = 40;
export const MAX_GROUPS = 20;
export const MAX_ITEMS = 60;
export const MAX_LABEL = 40;
/** Foundry document ids are 16 characters; the slack is only so a near-miss still round-trips. */
export const MAX_MACRO_ID = 64;
/** A key is `scene:` plus an id, so this is generous on purpose. */
export const MAX_KEY = 64;
/**
 * Cap on the favourites list.
 *
 * Favourites exist to be read at a glance at the top of a tablet sheet, so a
 * hundred of them would have defeated the feature long before they threatened the
 * flag. The bound is here rather than only on the tablet for the usual reason:
 * this list arrives from a device, and a device is a credential, not a peer.
 */
export const MAX_FAVORITES = 40;

/* Caps for a tile's declared parameters. A tablet prompt with more than a handful
 * of fields is unusable anyway, so these are UI limits as much as safety ones. */
export const MAX_PARAMS = 8;
export const MAX_CHOICES = 20;
export const MAX_PARAM_KEY = 32;
export const MAX_PARAM_TEXT = 200;
export const PARAM_TYPES = ["number", "text", "choice"];
/**
 * Bound on a numeric parameter's magnitude. Not a domain rule — a macro may well
 * want 10^9 — but a finite ceiling means no value can arrive as Infinity or as a
 * float so large that String() of it is 300 characters of exponent.
 */
export const MAX_PARAM_NUMBER = 1e12;

/* -------------------------------------------- */
/*  Pure helpers                                */
/* -------------------------------------------- */

/**
 * Coerce an untrusted value to a bounded string.
 *
 * String() rather than a template literal because a Symbol would throw from one,
 * and the try/catch because an object can throw from its own toString — neither
 * is reachable through the relay's JSON, but this is the boundary where a hostile
 * payload stops, so it does not depend on who is upstream.
 * @param {unknown} value
 * @param {string} fallback
 * @param {number} max
 * @returns {string}
 */
export function boundedString(value, fallback, max) {
  let text;
  try {
    text = ((value === undefined) || (value === null)) ? fallback : String(value);
  } catch {
    text = fallback;
  }
  return text.slice(0, max);
}

/**
 * Make a board key safe to use as an object key inside a document flag.
 *
 * A flag value is written through mergeObject, which at depth 0 expands any key
 * containing a dot into nested objects (common/utils/helpers.mjs:1141-1142) and
 * reads a leading `-=` or `==` as a delete/replace operator
 * (common/utils/helpers.mjs:1155-1159, 456-469). A board key is data, never a
 * path, so flatten anything that would be mistaken for one. Scene ids cannot
 * contain either, but a package id is only validated by the core's own rules and
 * this is cheaper than trusting them.
 * @param {unknown} key
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizeKey(key, fallback) {
  const text = boundedString(key, fallback, MAX_KEY).trim().replace(/\./g, "_").replace(/^[-=]=/, "");
  return text || fallback;
}

/* -------------------------------------------- */
/*  Tile parameters                             */
/* -------------------------------------------- */

/**
 * Names a parameter may not take.
 *
 * A script macro is compiled as
 *   new AsyncFunction("speaker", "actor", "token", "character", "scope", ...argNames, body)
 * (client/documents/macro.mjs:146-147) where argNames are the scope keys left after
 * `{speaker, actor, token, ...scope}` has been destructured off
 * (client/documents/macro.mjs:130). So the five fixed names are not merely bad
 * style here, they are two different kinds of breakage: `speaker`/`actor`/`token`
 * are eaten by that destructuring and would be handed to Foundry as the actual
 * speaker/actor/token of the run, while `character`/`scope` would be declared
 * twice in the same parameter list. A reserved word would be a SyntaxError from
 * the same constructor, and `arguments`/`eval` are illegal as parameter names in
 * strict code. None of this is reachable from the tablet's own editor — which is
 * exactly why it is enforced here, where a hostile payload also arrives.
 */
const RESERVED_PARAM_KEYS = new Set([
  // Fixed positional arguments of the compiled macro function.
  "speaker", "actor", "token", "character", "scope",
  // Reserved words and their strict-mode extensions.
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export",
  "extends", "false", "finally", "for", "function", "if", "implements", "import",
  "in", "instanceof", "interface", "let", "new", "null", "package", "private",
  "protected", "public", "return", "static", "super", "switch", "this", "throw",
  "true", "try", "typeof", "var", "void", "while", "with", "yield"
]);

/**
 * Is this a name a macro can safely receive as a variable?
 *
 * ASCII only, deliberately. JS identifiers may hold most of Unicode, but a key
 * that differs from another only by an invisible codepoint is a trap in a macro
 * body nobody can debug, and the tablet's keyboard offers no way to type one on
 * purpose. Foundry rejects a purely numeric key itself
 * (client/documents/macro.mjs:140-141); the leading-character rule covers that
 * and more.
 * @param {unknown} key
 * @returns {boolean}
 */
export function isParamKey(key) {
  if ( (typeof key !== "string") || !key || (key.length > MAX_PARAM_KEY) ) return false;
  if ( !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ) return false;
  return !RESERVED_PARAM_KEYS.has(key);
}

/**
 * Pull a number into the representable range, or give up.
 * @param {unknown} value
 * @returns {number|null} Null when it is not a finite number at all.
 */
function finiteNumber(value) {
  const n = Number(value);
  if ( !Number.isFinite(n) ) return null;
  return Math.min(Math.max(n, -MAX_PARAM_NUMBER), MAX_PARAM_NUMBER);
}

/**
 * Sanitise a tile's declared parameters.
 *
 * The same rigour as sanitizeGroups and for the same reason: this list arrives
 * from a tablet and then decides what variable names a macro is compiled with.
 * Anything doubtful is dropped rather than repaired, because a parameter the GM
 * can see missing from the prompt is a bug they can fix, while one silently
 * renamed is a macro that reads `undefined` forever.
 * @param {unknown} params
 * @returns {object[]}  Always an array; never throws.
 */
export function sanitizeParams(params) {
  if ( !Array.isArray(params) ) return [];
  const out = [];
  const seen = new Set();
  for ( const raw of params ) {
    if ( out.length >= MAX_PARAMS ) break;
    if ( !raw || (typeof raw !== "object") ) continue;
    let param;
    try {
      param = readParam(raw);
    } catch ( err ) {
      // Reading a property can itself throw — an accessor that does, which is the
      // same case boundedString guards String() against. Not reachable through the
      // relay's JSON, but this is the boundary a hostile payload stops at, and one
      // bad entry must not cost the GM the whole board.
      console.warn(`${MODULE_ID} | dropped an unreadable tile parameter`, err);
      continue;
    }
    // Duplicates would be a duplicate function parameter on the macro, and the
    // later one would silently win — so the first declaration keeps the name.
    if ( !param || seen.has(param.key) ) continue;
    seen.add(param.key);
    out.push(param);
  }
  return out;
}

/**
 * One declared parameter, or null when it cannot be used.
 * @param {object} raw
 * @returns {object|null}
 */
function readParam(raw) {
  const key = boundedString(raw.key, "", MAX_PARAM_KEY);
  if ( !isParamKey(key) ) return null;
  const type = PARAM_TYPES.includes(raw.type) ? raw.type : "text";
  const param = { key, label: boundedString(raw.label, key, MAX_LABEL) || key, type };

  if ( type === "choice" ) {
    const choices = [];
    for ( const choice of (Array.isArray(raw.choices) ? raw.choices : []) ) {
      if ( choices.length >= MAX_CHOICES ) break;
      const text = boundedString(choice, "", MAX_PARAM_TEXT);
      if ( text && !choices.includes(text) ) choices.push(text);
    }
    // A choice with nothing to choose from cannot be answered, and defaulting it
    // to "" would feed the macro an empty string it never asked for.
    if ( !choices.length ) return null;
    param.choices = choices;
    param.default = choices.includes(raw.default) ? raw.default : choices[0];
  } else if ( type === "number" ) {
    param.default = finiteNumber(raw.default) ?? 0;
  } else {
    param.default = boundedString(raw.default, "", MAX_PARAM_TEXT);
  }
  return param;
}

/** Sentinel for "this value cannot be used", distinct from every legal value. */
const REJECT = Symbol("reject");

/**
 * Coerce one incoming value to a declared type, or reject it.
 *
 * Coercion is deliberately narrow: a number typed into a text field arrives as a
 * string and vice versa, which is worth accepting, but an object, an array or a
 * boolean is not a typo — it is something that did not come from the prompt.
 * @param {object} param
 * @param {unknown} value
 * @returns {number|string|symbol}  REJECT when the value is unusable.
 */
function coerceParam(param, value) {
  const primitive = (typeof value === "number") || (typeof value === "string");
  if ( !primitive ) return REJECT;
  switch ( param.type ) {
    case "number": {
      // Not Number(""): the empty string coerces to 0, so a field the user cleared
      // would fire as a real zero rather than being caught here.
      if ( (typeof value === "string") && !value.trim() ) return REJECT;
      const n = Number(value);
      if ( !Number.isFinite(n) ) return REJECT;
      if ( Math.abs(n) > MAX_PARAM_NUMBER ) return REJECT;
      return n;
    }
    case "choice":
      // Exact membership only. A near-miss is a stale board on the tablet, and
      // guessing which option was meant is not this function's business.
      return (param.choices ?? []).includes(value) ? value : REJECT;
    default: {
      const text = String(value);
      // Rejected rather than truncated: a truncated string still runs the macro,
      // just with a different meaning than anybody chose.
      return (text.length > MAX_PARAM_TEXT) ? REJECT : text;
    }
  }
}

/**
 * Build the scope object a macro will actually be executed with.
 *
 * `declared` must come from the console's *own* stored board, never from the
 * request — the whole point is that the tablet says which values it typed, not
 * what the tile is allowed to accept. Missing keys fall back to the stored
 * default; anything else is a refusal rather than a repair, because a console
 * that quietly substitutes values would report a run that never happened.
 * @param {unknown} declared          The tile's `params`, as stored.
 * @param {unknown} incoming          The values the tablet sent.
 * @returns {{ok: true, values: object}|{ok: false, error: string}}
 */
export function applyParams(declared, incoming) {
  const params = sanitizeParams(declared);
  const hasValues = (incoming !== undefined) && (incoming !== null);
  if ( hasValues && ((typeof incoming !== "object") || Array.isArray(incoming)) ) {
    return { ok: false, error: "Parametry mają zły format" };
  }

  // Object.keys, not for..in: only own enumerable keys count, so a "__proto__" or
  // "constructor" that JSON.parse put on the object is seen as the ordinary — and
  // unknown — key it is, rather than reaching through to Object.prototype.
  const given = hasValues ? Object.keys(incoming) : [];
  if ( given.length > MAX_PARAMS ) return { ok: false, error: "Za dużo parametrów" };
  const names = new Set(params.map(p => p.key));
  const unknown = given.filter(k => !names.has(k));
  // Refused, not ignored. An unknown key means the tablet is firing against a tile
  // that no longer looks the way it thinks it does, and running the macro with the
  // parameters it *did* recognise would be running a different action than the one
  // the GM tapped.
  if ( unknown.length ) return { ok: false, error: `Nieznany parametr: ${unknown.slice(0, 3).join(", ")}` };

  const values = {};
  for ( const param of params ) {
    if ( !hasValues || !Object.hasOwn(incoming, param.key) ) {
      values[param.key] = param.default;
      continue;
    }
    const coerced = coerceParam(param, incoming[param.key]);
    if ( coerced === REJECT ) return { ok: false, error: `Zła wartość: „${param.label}”` };
    values[param.key] = coerced;
  }
  return { ok: true, values };
}

/**
 * One short line naming what a run was actually given, for the result toast.
 * Labelled rather than keyed: the GM reads this, the macro reads the keys.
 * @param {unknown} declared
 * @param {object} values
 * @returns {string}
 */
export function describeParams(declared, values) {
  const parts = [];
  for ( const param of sanitizeParams(declared) ) {
    if ( !Object.hasOwn(values ?? {}, param.key) ) continue;
    parts.push(`${param.label}=${values[param.key]}`);
  }
  return parts.join(", ").slice(0, 90);
}

/**
 * Sanitise the group/tile structure of one board.
 *
 * Everything here is hostile until proved otherwise. The relay only checks that
 * `groups` is an array, so `{"groups":[null]}` or `items:[null]` reaches this
 * function, and an uncapped macroId would put half a megabyte into a User flag
 * that is then broadcast to every connected device.
 * @param {unknown} groups
 * @returns {object[]}
 * @throws {Error} If the value is not an array at all — a caller that hands over
 *                 rubbish should hear about it rather than silently save nothing.
 */
export function sanitizeGroups(groups) {
  if ( !Array.isArray(groups) ) throw new Error("layout: groups must be an array");
  return groups
    .slice(0, MAX_GROUPS)
    .filter(g => g && (typeof g === "object"))
    .map((g, gi) => ({
      id: boundedString(g.id, `g${gi}`, MAX_LABEL),
      name: boundedString(g.name, "Grupa", MAX_LABEL),
      items: (Array.isArray(g.items) ? g.items : [])
        .slice(0, MAX_ITEMS)
        .filter(it => it && (typeof it === "object"))
        .map(it => {
          const clean = {
            macroId: boundedString(it.macroId, "", MAX_MACRO_ID),
            size: ["1x1", "2x1", "2x2"].includes(it.size) ? it.size : "1x1",
            confirm: !!it.confirm
          };
          // Present only when there is something to declare, so a board full of
          // ordinary tiles serialises byte-for-byte the way it always has — no
          // `params: []` on every item, no state push whose only change is that.
          const params = sanitizeParams(it.params);
          if ( params.length ) clean.params = params;
          return clean;
        })
        .filter(it => it.macroId)
    }));
}

/**
 * Sanitise one board. Never throws: a board whose groups are unusable becomes an
 * empty board, because dropping the whole collection over one bad entry is worse.
 * @param {unknown} board
 * @param {string} fallbackName
 * @returns {{name: string, groups: object[]}}
 */
export function sanitizeBoard(board, fallbackName) {
  const source = (board && (typeof board === "object")) ? board : {};
  return {
    name: boundedString(source.name, fallbackName, MAX_LABEL),
    groups: sanitizeGroups(Array.isArray(source.groups) ? source.groups : [])
  };
}

/**
 * Sanitise a whole collection, whatever shape it arrived in.
 *
 * Used for three different sources — the stored flag, an imported file, a pasted
 * blob — so it is strict about the outer structure (the caller has to be able to
 * say *why* an import was refused) and lenient inside (one broken tile must not
 * cost the GM the other twenty-nine boards).
 * @param {unknown} raw
 * @returns {{version: number, boards: Record<string, {name: string, groups: object[]}>}}
 * @throws {Error} With a message meant to be shown to the GM.
 */
export function sanitizeCollection(raw) {
  if ( !raw || (typeof raw !== "object") || Array.isArray(raw) ) {
    throw new Error("To nie jest obiekt JSON z planszami.");
  }
  // A v1 export — or the old single-board flag — is a bare `{groups: [...]}`.
  // Accept it as the default board so an old backup file still imports.
  const source = (raw.boards && (typeof raw.boards === "object") && !Array.isArray(raw.boards))
    ? raw.boards
    : (Array.isArray(raw.groups) ? { [DEFAULT_KEY]: raw } : null);
  if ( !source ) throw new Error("Brak pola „boards” ani „groups” — to nie jest plik plansz GM Console.");

  const boards = {};
  for ( const [key, board] of Object.entries(source) ) {
    if ( Object.keys(boards).length >= MAX_BOARDS ) break;
    const clean = sanitizeKey(key, "");
    if ( !clean || (clean in boards) ) continue;
    boards[clean] = sanitizeBoard(board, clean === DEFAULT_KEY ? DEFAULT_NAME : clean);
  }
  if ( !Object.keys(boards).length ) throw new Error("Nie ma tam ani jednej poprawnej planszy.");
  return { version: BOARDS_VERSION, boards };
}

/**
 * Pick the board to serve. `candidates` runs most specific first and its last
 * entry is the fallback used when the collection holds none of them, so a scene
 * that was never given a board of its own opens on the system's board — or the
 * default one — instead of stranding the GM in front of an empty console.
 * @param {object} collection
 * @param {string[]} candidates
 * @returns {string}
 */
export function resolveBoardKey(collection, candidates) {
  for ( const key of candidates ) {
    if ( collection?.boards?.[key] ) return key;
  }
  return candidates[candidates.length - 1] ?? DEFAULT_KEY;
}

/**
 * @param {object} board
 * @returns {number} How many tiles the board holds.
 */
export function countItems(board) {
  let n = 0;
  for ( const group of board?.groups ?? [] ) n += group?.items?.length ?? 0;
  return n;
}

/**
 * What importing `incoming` would do to `current`, one row per board.
 * @param {object} current
 * @param {object} incoming
 * @returns {{key: string, name: string, status: "added"|"replaced"|"removed", groups: number, items: number}[]}
 */
export function describeChanges(current, incoming) {
  const currentBoards = current?.boards ?? {};
  const incomingBoards = incoming?.boards ?? {};
  const rows = [];
  for ( const [key, board] of Object.entries(incomingBoards) ) {
    rows.push({
      key,
      name: board.name,
      status: (key in currentBoards) ? "replaced" : "added",
      groups: board.groups?.length ?? 0,
      items: countItems(board)
    });
  }
  for ( const [key, board] of Object.entries(currentBoards) ) {
    if ( key in incomingBoards ) continue;
    rows.push({
      key,
      name: board.name,
      status: "removed",
      groups: board.groups?.length ?? 0,
      items: countItems(board)
    });
  }
  return rows;
}

/* -------------------------------------------- */
/*  Favourites                                  */
/* -------------------------------------------- */

/**
 * Sanitise a favourites list, wherever it came from.
 *
 * Stricter than sanitizeGroups on purpose. A board has years of stored shapes
 * behind it and has to keep reading them, so it repairs what it can; this list
 * was only ever written by one tap on one tablet, so there is no legacy to be
 * lenient towards and a non-string entry can only be a mistake or an attack.
 * Rejected rather than String()-ed, because `String({})` is `"[object Object]"` —
 * a perfectly bounded, perfectly useless id that would sit in the flag forever.
 * @param {unknown} raw
 * @returns {string[]}  Always an array, bounded, deduplicated, order preserved.
 */
export function sanitizeFavorites(raw) {
  if ( !Array.isArray(raw) ) return [];
  const out = [];
  for ( const entry of raw ) {
    if ( out.length >= MAX_FAVORITES ) break;
    if ( typeof entry !== "string" ) continue;
    const id = entry.trim().slice(0, MAX_MACRO_ID);
    // A duplicate would show the same macro twice in the sheet and would let a
    // hostile payload spend the whole cap on one id.
    if ( !id || out.includes(id) ) continue;
    out.push(id);
  }
  return out;
}

/**
 * What the GM's own arrangements say about each macro, gathered across *every*
 * board rather than only the active one.
 *
 * This is what lets a macro be found and fired from the search sheet without
 * losing the treatment the GM already gave it: a macro they marked guarded on
 * some scene's board is guarded when it turns up in a search result too, and one
 * they gave parameters to is flagged as "this normally asks you something".
 *
 * Both traits are sticky — one unguarded tile does not un-guard a macro the GM
 * guarded elsewhere. The safe answer to "is this dangerous?" is the most cautious
 * thing the GM has ever said about it, and the alternative would mean a macro's
 * guard depended on which of two tiles a search happened to find first.
 * @param {object} collection
 * @returns {Map<string, {confirm: boolean, asks: boolean}>}
 */
export function macroTraits(collection) {
  const traits = new Map();
  for ( const board of Object.values(collection?.boards ?? {}) ) {
    for ( const group of board?.groups ?? [] ) {
      for ( const item of group?.items ?? [] ) {
        const id = item?.macroId;
        if ( !id || (typeof id !== "string") ) continue;
        const trait = traits.get(id) ?? { confirm: false, asks: false };
        if ( item.confirm ) trait.confirm = true;
        if ( item.params?.length ) trait.asks = true;
        traits.set(id, trait);
      }
    }
  }
  return traits;
}

/* -------------------------------------------- */
/*  Foundry-facing storage                      */
/* -------------------------------------------- */

/**
 * Board keys for the current situation, most specific first, always ending in the
 * fallback. Scene beats system beats default.
 * @returns {string[]}
 */
export function candidateKeys() {
  // game.scenes.current is the *viewed* scene once the canvas is up and the
  // *activated* one otherwise (client/documents/collections/scenes.mjs:40-44) —
  // exactly "the scene the GM is looking at". The explicit .active fallback is
  // for no-canvas mode, where current still asks for the viewed scene but
  // Scene#_view is only ever assigned by the Canvas (client/canvas/board.mjs:
  // 1134-1150), so nothing is viewed and current comes back undefined.
  //
  // Wrapped because that getter reads the `canvas` global, and this runs on
  // every state push: a throw here would take the whole stream down over a
  // question whose answer we can perfectly well default.
  let scene = null;
  try {
    scene = game.scenes?.current ?? game.scenes?.active ?? null;
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not read the current scene`, err);
  }
  const keys = [];
  if ( scene?.id ) keys.push(sanitizeKey(`${SCENE_PREFIX}${scene.id}`, DEFAULT_KEY));
  if ( game.system?.id ) keys.push(sanitizeKey(`${SYSTEM_PREFIX}${game.system.id}`, DEFAULT_KEY));
  keys.push(DEFAULT_KEY);
  return keys;
}

/** Seed a board from whatever is currently pinned to the hotbar. */
export function groupsFromHotbar() {
  const hotbar = game.user.hotbar ?? {};
  const groups = [];
  for ( let page = 1; page <= SLOT_COUNT / PAGE_SIZE; page++ ) {
    const items = [];
    for ( let i = 0; i < PAGE_SIZE; i++ ) {
      const macroId = hotbar[(page - 1) * PAGE_SIZE + i + 1];
      if ( macroId ) items.push({ macroId, size: "1x1", confirm: false });
    }
    if ( items.length ) groups.push({ id: `page-${page}`, name: `Strona ${page}`, items });
  }
  if ( !groups.length ) groups.push({ id: "main", name: "Konsola", items: [] });
  return groups;
}

/** Set once the one-off migration write has been started, so it is never queued twice. */
let migrationStarted = false;

/**
 * The collection as stored, migrating the old single board on the way if that is
 * all there is.
 *
 * Synchronous, because every reader (buildState, the execute whitelist) is, and
 * because the migrated value is correct whether or not its write has landed yet.
 *
 * Every collection handed out here is also recorded — see rememberRead. A caller
 * that reads, waits for a dialog and only then writes is the case a write queue
 * cannot help with, and this is where the state it derived its change from can
 * still be seen.
 * @returns {{version: number, boards: Record<string, object>}}
 */
export function readCollection() {
  const stored = game.user.getFlag(MODULE_ID, BOARDS_FLAG);
  if ( stored?.boards && (typeof stored.boards === "object") ) {
    try {
      return rememberRead(sanitizeCollection(stored));
    } catch ( err ) {
      // Do not write anything here. The flag stays exactly as it is, so the GM
      // can still export it, and the backup slot is still intact.
      console.error(`${MODULE_ID} | stored boards were unreadable, serving an empty one`, err);
      return { version: BOARDS_VERSION, boards: { [DEFAULT_KEY]: { name: DEFAULT_NAME, groups: [] } } };
    }
  }

  const legacy = game.user.getFlag(MODULE_ID, LAYOUT_FLAG);
  // Array.isArray, not groups.length: an empty board is one the GM emptied on
  // purpose, and reading that as "never saved" would re-seed it from the hotbar
  // on every push. Same reasoning the single-board getLayout() used.
  const migrating = Array.isArray(legacy?.groups);
  const collection = {
    version: BOARDS_VERSION,
    boards: {
      [DEFAULT_KEY]: {
        name: DEFAULT_NAME,
        groups: sanitizeGroups(migrating ? legacy.groups : groupsFromHotbar())
      }
    }
  };

  // Persist only a real migration. A hotbar seed is deliberately left unsaved, as
  // it was before: until the GM saves a board from the tablet, the console keeps
  // tracking the hotbar. Fire-and-forget — no synchronous caller can await it, and
  // the value returned above is already the right one either way. The old `layout`
  // flag is left untouched: it costs nothing and is the oldest backup there is.
  if ( migrating && !migrationStarted ) {
    migrationStarted = true;
    // `base: null` on purpose. There is nothing stored to be a delta against — that
    // is what makes this the migration — so this replaces whatever is there, and
    // saying so explicitly keeps it out of the inference below.
    writeCollection(collection, { backup: false, base: null })
      .then(() => console.log(`${MODULE_ID} | migrated the single board to the keyed collection`))
      .catch(err => console.error(`${MODULE_ID} | could not persist the migrated board`, err));
  }
  return rememberRead(collection);
}

/**
 * The board that is currently active, plus the key it is stored under.
 * @returns {{key: string, board: {name: string, groups: object[]}, collection: object}}
 */
export function readActiveBoard() {
  const collection = readCollection();
  const key = resolveBoardKey(collection, candidateKeys());
  const board = collection.boards[key] ?? { name: DEFAULT_NAME, groups: [] };
  return { key, board, collection };
}

/**
 * The GM's favourites, as stored.
 *
 * Sanitised on the way out as well as on the way in: the flag is on a User
 * document, which a world migration, a hand-edited database or another module can
 * reach, and every reader of this is about to publish the result to a tablet.
 * @returns {string[]}
 */
export function readFavorites() {
  return sanitizeFavorites(game.user.getFlag(MODULE_ID, FAVORITES_FLAG));
}

/**
 * Star or unstar one macro.
 *
 * Returns rather than throws for a refusal the GM should see (the list is full),
 * because the caller has to turn that into one short line on a tablet toast; a
 * failed *write* still rejects, since that is a Foundry problem and not an answer.
 *
 * No backup entry, unlike a board write. The undo history is bounded, and filling
 * it with stars would push out the board edit the GM might actually want back —
 * un-starring is one tap anyway.
 * @param {unknown} macroId
 * @param {boolean} on          Star it, or take it off the list.
 * @returns {Promise<{ok: boolean, favorites: string[], error?: string}>}
 */
export async function setFavorite(macroId, on) {
  const id = boundedString(macroId, "", MAX_MACRO_ID).trim();
  if ( !id ) return { ok: false, favorites: readFavorites(), error: "Puste id makra" };

  // Through the same queue as a board write, and reading inside it. Not because a
  // star can collide with a board — they are separate keys under the module's flag
  // scope and diffObject touches only the one that changed — but because two stars
  // tapped a moment apart are the same read-modify-write hazard on one array, and
  // the second would otherwise be computed from a list the first had already
  // replaced. One queue, so there is one answer to "what is stored now".
  return queueFlagWrite(async () => {
    const current = readFavorites();
    const next = current.filter(entry => entry !== id);
    if ( on ) {
      if ( next.length !== current.length ) return { ok: true, favorites: current };   // already starred
      if ( current.length >= MAX_FAVORITES ) {
        return { ok: false, favorites: current, error: `Najwyżej ${MAX_FAVORITES} ulubionych` };
      }
      // Newest first: the macro just starred is the one being looked for.
      next.unshift(id);
    } else if ( next.length === current.length ) return { ok: true, favorites: current };

    // Safe to write whole, unlike the boards object. A flag value is merged into
    // what is already stored, but _mergeUpdate only recurses when both sides are
    // plain objects — getType([]) is "Array", so it takes the overwrite branch
    // (common/utils/helpers.mjs:1196-1223) and the array is replaced, not appended
    // to. That is why this needs none of writeCollection's stale-key pruning.
    await game.user.setFlag(MODULE_ID, FAVORITES_FLAG, next);
    return { ok: true, favorites: next };
  });
}

/**
 * The `{key: value}` pair that removes `key` when merged into a document update.
 *
 * v14 replaced the `{"-=key": null}` form with operator instances and logs a
 * compatibility warning for the old one (common/utils/helpers.mjs:456-469), while
 * v13 understands only the old one — so use whichever the running core prefers.
 * Note the pair has to be nested by hand rather than written as a dotted path:
 * diffObject drops a deletion whose key is not literally present in the stored
 * object (common/utils/helpers.mjs:343-347), and a dotted key never is.
 * @param {string} key
 * @returns {[string, unknown]}
 */
function deletionEntry(key) {
  const ForcedDeletion = foundry.data?.operators?.ForcedDeletion;
  return ForcedDeletion ? [key, new ForcedDeletion()] : [`-=${key}`, null];
}

/**
 * How many snapshots the undo history keeps.
 *
 * One slot was enough while the only way to lose a board was a deliberate import,
 * because the GM noticed that immediately and the very next thing they did was
 * press undo. It stopped being enough once a tablet could clobber a board on its
 * own: the slot then held the *clobber* after one further routine save, and the
 * arrangement the GM actually wanted back was gone with nothing on screen to say
 * it ever existed. A dozen is chosen against how the loss is noticed rather than
 * against the flag — "the board was wrong when I looked up after the fight" is a
 * handful of tablet saves ago, not one.
 */
export const MAX_BACKUPS = 12;
/**
 * Byte ceiling for the whole history, trimmed oldest-first.
 *
 * Each entry is a whole collection, and a collection is allowed forty boards of
 * twenty groups of sixty tiles — so a full history of full collections would be
 * megabytes on a User document that is broadcast to every client that logs in.
 * The count cap alone cannot bound that; this does, and the newest entry is kept
 * whatever it costs, since a history that drops the thing just overwritten is not
 * a history at all.
 */
export const MAX_BACKUP_BYTES = 400_000;
/** The history's own shape version, so a later change can recognise these entries. */
const BACKUP_VERSION = 2;

/**
 * Snapshot the collection being overwritten, at the head of a bounded history.
 *
 * Stored as a JSON string on purpose. A flag value that is an object gets *merged*
 * into whatever is already there (flags is a DocumentFlagsField over ObjectField,
 * whose _updateDiff diffs then mergeObjects — common/data/fields.mjs:1933-1950), so
 * an object-shaped backup would accumulate boards from every previous backup and
 * eventually restore a mixture that never existed. A string is replaced whole —
 * which is also why the whole history is rewritten here rather than appended to.
 * @param {object|undefined} previous  The collection being overwritten.
 * @param {string} reason              Short label shown next to the restore button.
 * @returns {Promise<void>}
 */
async function writeBackup(previous, reason) {
  if ( !previous?.boards ) return;
  const history = readBackupHistory();

  // A forced re-save of the identical arrangement — the console publishes on more
  // occasions than it changes — must not push the entry that matters off the end.
  if ( history[0] && (JSON.stringify(history[0].data) === JSON.stringify(previous)) ) return;

  const entries = [{ at: Date.now(), reason, data: previous }, ...history].slice(0, MAX_BACKUPS);
  // Trim oldest-first until it fits, but never below one entry: the guarantee this
  // exists for is "the write that just happened can be undone".
  let payload = JSON.stringify({ version: BACKUP_VERSION, entries });
  while ( (entries.length > 1) && (payload.length > MAX_BACKUP_BYTES) ) {
    entries.pop();
    payload = JSON.stringify({ version: BACKUP_VERSION, entries });
  }

  try {
    await game.user.setFlag(MODULE_ID, BACKUP_FLAG, payload);
  } catch ( err ) {
    // A backup that cannot be written must not stop the write it protects; the
    // GM would then be unable to save at all.
    console.error(`${MODULE_ID} | could not store the previous boards`, err);
  }
}

/**
 * The undo history, newest first, or an empty array when there is nothing to go
 * back to.
 *
 * Reads the pre-history single snapshot too. That is not politeness to old worlds:
 * it is the GM whose module updated between two saves of the same session, whose
 * one stored snapshot is the only copy of the board they are about to ask for.
 * @returns {{at: number, reason: string, data: object}[]}
 */
export function readBackupHistory() {
  const raw = game.user.getFlag(MODULE_ID, BACKUP_FLAG);
  if ( typeof raw !== "string" ) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch ( err ) {
    console.warn(`${MODULE_ID} | the stored backup is not readable JSON`, err);
    return [];
  }
  // The pre-2.2 shape: one snapshot, stored bare.
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [parsed];
  return entries.filter(entry => entry?.data?.boards && (typeof entry.data.boards === "object"));
}

/**
 * The newest undo slot, or null when there is nothing to go back to.
 *
 * Unchanged in shape and meaning from when there was only ever one: the pairing
 * window renders `at`, `reason` and `data.boards` from exactly this object.
 * @returns {{at: number, reason: string, data: object}|null}
 */
export function readBackup() {
  return readBackupHistory()[0] ?? null;
}

/* -------------------------------------------- */
/*  Serialised flag writes                      */
/* -------------------------------------------- */

/**
 * The tail of every board-flag write this tab has started.
 *
 * A flag write is a read-modify-write over a document that lives on the server: a
 * caller reads the collection, computes the next one, and awaits a round trip. Two
 * of those interleaving is not a theoretical race — a tablet save landing inside a
 * board delete was reproduced in both directions, and it lost the save one way and
 * resurrected the deleted board the other, because the update sent is merged into
 * whatever is stored *when it arrives* (ObjectField#_updateDiff diffs then
 * mergeObjects, common/data/fields.mjs:1946-1948, and _mergeUpdate only recurses
 * when both sides are objects, common/utils/helpers.mjs:1211).
 *
 * So every mutation goes through here and they happen strictly one at a time. The
 * relay does the same for its own files (relay/server.mjs, saveAtomic) for the same
 * reason; the shape is the same and the hazard is not — there it is two handlers
 * truncating one file, here it is two snapshots of one object.
 */
let flagChain = Promise.resolve();

/**
 * Run `job` with no other board-flag write in flight, and hand back what it returns.
 *
 * The chain is advanced by a promise that cannot reject. A rejected job — the
 * server refused the update, the user document went away mid-write — must reach
 * *its own* caller and nobody else's, and must not wedge every later save behind a
 * promise nothing will ever settle.
 * @template T
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
function queueFlagWrite(job) {
  const run = flagChain.then(job, job);
  flagChain = run.then(() => {}, () => {});
  return run;
}

/**
 * The collection as stored right now, or null when there is nothing usable there.
 *
 * Sanitised, so it can be compared board-for-board against what a caller computed:
 * both sides are then built by the same code in the same key order and JSON of one
 * board is a fair test of "is this the same board".
 * @returns {{version: number, boards: Record<string, object>}|null}
 */
function storedCollection() {
  const stored = game.user.getFlag(MODULE_ID, BOARDS_FLAG);
  if ( !stored?.boards || (typeof stored.boards !== "object") ) return null;
  try {
    return sanitizeCollection(stored);
  } catch {
    return null;
  }
}

/* -------------------------------------------- */
/*  Read receipts                               */
/* -------------------------------------------- */

/**
 * How many distinct collections readCollection() remembers having served.
 *
 * The list exists to answer one question — "which state did this write derive
 * from?" — for a caller that read minutes ago, so it is sized against how many
 * *different* arrangements can exist inside one dialog rather than against how
 * often the collection is read. Identical reads collapse into one entry, and
 * buildState reads on every push without moving the list at all unless a board
 * actually changed. Six is several tablet saves' worth; beyond that the caller's
 * snapshot is old enough that inferring anything from it would be a guess.
 */
const MAX_READS = 6;

/**
 * Every distinct collection this module has handed to a reader, newest first.
 *
 * This is the whole of the fix for a base captured too late. A flag write is a
 * read-modify-write, and the write queue can only serialise the *write* half: the
 * pairing window reads the collection, puts a confirmation dialog on screen and
 * writes minutes later, so by then "what is stored" and "what this caller was
 * looking at" are two different collections and only the second one is a base.
 * Defaulting to the first said "nothing landed in between" about a write that had
 * waited through everything — which reconcileCollection then believed, and wrote
 * the stale snapshot whole.
 * @type {{version: number, boards: Record<string, object>}[]}
 */
const servedReads = [];

/**
 * Record a collection as served, and hand it straight back.
 *
 * The entry is the collection itself, not a copy. Everything in `servedReads` was
 * built by sanitizeCollection from a flag value, so no caller shares an object
 * with another and nothing here can be mutated from outside — and if one ever
 * were, the comparisons below simply stop matching, which fails towards "I cannot
 * tell", not towards a wrong base.
 * @template T
 * @param {T} collection
 * @returns {T}  The same object.
 */
function rememberRead(collection) {
  const json = JSON.stringify(collection.boards);
  const at = servedReads.findIndex(entry => JSON.stringify(entry.boards) === json);
  // Already the newest: the common case by far, since buildState reads on every
  // push. Move an older duplicate to the front rather than storing it twice.
  if ( at === 0 ) return collection;
  if ( at > 0 ) servedReads.splice(at, 1);
  servedReads.unshift(collection);
  servedReads.length = Math.min(servedReads.length, MAX_READS);
  return collection;
}

/**
 * Which served collection a caller most likely computed `clean` from.
 *
 * A caller that names its base is believed; this is for the one that cannot say,
 * because it is a window this file does not own. What it has to go on is that a
 * board the caller merely carried along is *byte-identical* to the board it was
 * given — sanitizeGroups builds every object literal the same way, so equal JSON
 * is equal arrangement — and that a caller only ever edits a handful of boards at
 * once. So the snapshot sharing the most boards with `clean` is the one it read,
 * and in the case that matters (the pairing window's delete) that is the stale
 * read rather than what is stored now, which is exactly the distinction that was
 * being lost.
 *
 * Ties go to the snapshot that knew about the most boards, then to the newest: a
 * base that contains a key the caller dropped is the one that can express the
 * deletion, and a base missing it would silently turn "delete this board" into a
 * write that does nothing.
 * @param {object} clean
 * @returns {object|null}  Null when no served collection shares a single board
 *   with `clean` — see writeCollection for what that means.
 */
function inferBase(clean) {
  let best = null;
  let bestScore = 0;
  for ( const snapshot of servedReads ) {
    let score = 0;
    for ( const [key, board] of Object.entries(snapshot.boards) ) {
      const mine = clean.boards[key];
      if ( mine && (JSON.stringify(mine) === JSON.stringify(board)) ) score++;
    }
    // Sharing nothing at all is not evidence of anything, so it is never a base.
    if ( !score ) continue;
    if ( !best || (score > bestScore)
      || ((score === bestScore)
        && (Object.keys(snapshot.boards).length > Object.keys(best.boards).length)) ) {
      best = snapshot;
      bestScore = score;
    }
  }
  // Newest-first iteration plus a strictly-greater test means an outright tie is
  // decided by recency, which is the right way round: the caller is far more
  // likely to have read the arrangement that has been current for the last minute
  // than the one before it.
  return best;
}

/**
 * Fold a caller's intent into whatever is stored now.
 *
 * Serialising the writes is only half of it. A caller reads the collection, works
 * out the next one, and only then queues — so by the time its turn comes the thing
 * it read may be two saves old, and writing its snapshot whole would undo them.
 * What the caller actually meant is the *difference* between what it read and what
 * it computed, so that is what is applied: a board it changed or added wins, a
 * board it removed goes, and a board it never touched keeps whatever the writes it
 * waited behind made of it.
 *
 * Board granularity, not tile granularity, and deliberately so. Two edits to the
 * same board are a conflict that has an owner — `saveActiveGroups` refuses a save
 * whose `rev` has moved — while two edits to *different* boards are not a conflict
 * at all and are exactly what used to be lost.
 * @param {object} clean    What the caller computed, sanitised.
 * @param {object|null} base     What the caller read it from.
 * @param {object|null} current  What is stored now.
 * @returns {object}
 */
function reconcileCollection(clean, base, current) {
  // Nothing landed in between, so the caller's snapshot is the whole truth.
  if ( !base || !current ) return clean;
  if ( JSON.stringify(base.boards) === JSON.stringify(current.boards) ) return clean;

  const boards = { ...current.boards };
  for ( const [key, board] of Object.entries(clean.boards) ) {
    const before = base.boards[key];
    // Untouched by this caller: leave the interleaved write's version alone. This
    // is the case that used to cost a board, in both directions.
    if ( before && (JSON.stringify(before) === JSON.stringify(board)) ) continue;
    boards[key] = board;
  }
  for ( const key of Object.keys(base.boards) ) {
    if ( key in clean.boards ) continue;
    // Only remove the board the caller was actually looking at. Delete-versus-
    // recreate used to be inexpressible: a key the caller dropped was dropped
    // whatever had happened to it, so a board deleted here and immediately made
    // again from another tab lost the new one too, and a stale delete took a
    // board that had been rewritten under it since. Comparing against the base's
    // copy makes the deletion mean "remove this arrangement", which is a thing
    // the interleaved write can have already invalidated.
    if ( JSON.stringify(current.boards[key]) === JSON.stringify(base.boards[key]) ) delete boards[key];
  }

  // Two callers can between them remove everything either of them knew about, and
  // a collection with no boards at all is not a state this module can serve.
  if ( !Object.keys(boards).length ) return clean;
  // Back through the sanitiser: the union of two collections can be over MAX_BOARDS
  // even when neither of them was.
  return sanitizeCollection({ version: BOARDS_VERSION, boards });
}

/**
 * Store a collection. Runs inside the write queue — never call it from outside one.
 * @param {object} clean         The sanitised collection the caller wants stored.
 * @param {object|null} base     The sanitised collection it was computed from.
 * @param {boolean} backup       Snapshot what is being overwritten.
 * @param {string} reason        Why, for the restore button's label.
 * @returns {Promise<object>}    What was actually stored.
 */
async function commitCollection(clean, base, backup, reason) {
  // Read inside the queue, so this is the state this write is really landing on.
  const current = storedCollection();
  const next = reconcileCollection(clean, base, current);
  if ( backup ) await writeBackup(current ?? base, reason);

  // setFlag merges rather than replaces (see writeBackup), so a board this
  // collection drops would survive the write. Write first and prune second, not
  // the other way round: the intermediate state is then a superset of both, never
  // a gap in which a state push could reach the tablet showing an empty console.
  await game.user.setFlag(MODULE_ID, BOARDS_FLAG, next);
  // Off the raw flag rather than off `current`: a key the sanitiser rewrote (a dot
  // in it) or dropped is still sitting in the document and still has to go.
  const raw = game.user.getFlag(MODULE_ID, BOARDS_FLAG);
  const stale = Object.keys(raw?.boards ?? {}).filter(key => !(key in next.boards));
  if ( stale.length ) {
    await game.user.update({
      flags: { [MODULE_ID]: { [BOARDS_FLAG]: { boards: Object.fromEntries(stale.map(deletionEntry)) } } }
    });
  }
  // A write is an observation too. Whoever stored this collection has by
  // definition seen it, so it is a base a *later* base-less write from the same
  // caller can be recovered against — which is what a caller that writes twice
  // without reading in between (a migration, an import followed by a tidy-up) has
  // otherwise left no trace of at all. Without this, inferBase can only match a
  // snapshot that predates the first write, and a board that write had added is
  // then a board the second one is not allowed to remove.
  return rememberRead(next);
}

/**
 * Replace the whole collection, keeping the outgoing one at the head of the undo
 * history.
 * @param {object} collection
 * @param {object} [options]
 * @param {boolean} [options.backup=true]  Snapshot what is being overwritten.
 * @param {string} [options.reason=""]     Why, for the restore button's label.
 * @param {object|null} [options.base]  The collection `collection` was computed
 *   from. Pass the object readCollection() (or readActiveBoard()) returned, held
 *   from the moment of the read — that is the only value that makes the guarantee
 *   exact, and it is what a caller with a confirmation dialog between its read and
 *   its write has to do.
 *
 *   Omitted, the base is *recovered* rather than assumed: inferBase picks the
 *   collection this module actually served that best explains what arrived. It
 *   used to default to whatever was stored at the moment of the call, which is a
 *   claim — "nothing landed in between" — that a caller which had been sitting in
 *   a dialog was in no position to make, and reconcileCollection believed it and
 *   wrote the stale snapshot whole.
 *
 *   An explicit `null` says "this replaces whatever is there", which is what a
 *   restore means and is a different statement from saying nothing at all. A
 *   collection that shares no board with anything ever read here is treated the
 *   same way, because it cannot be a delta of anything this module has served —
 *   an imported file of somebody else's boards is the case — and that is said out
 *   loud in the log rather than left to be inferred from the result.
 * @returns {Promise<object>}              The collection that was stored.
 */
export async function writeCollection(collection, { backup = true, reason = "", base } = {}) {
  const clean = sanitizeCollection(collection);
  let from = base;
  if ( base === undefined ) {
    from = inferBase(clean);
    if ( !from ) {
      console.warn(`${MODULE_ID} | a write named no base and matches nothing that has been read`
        + ` (${reason || "no reason given"}); treating it as a replacement`);
    }
  }
  return queueFlagWrite(() => commitCollection(clean, from, backup, reason));
}

/**
 * A short fingerprint of one board's arrangement.
 *
 * The key says *which* board; this says *which version of it*. A key alone cannot
 * tell "the tablet edited this board" apart from "the tablet edited this board
 * before somebody else rewrote it" — importing boards (pairing-app.mjs) replaces
 * the active board's contents without changing which key is active, and a save
 * that started before the import would silently undo it.
 *
 * FNV-1a over the sanitised groups, which serialise in a fixed key order
 * (sanitizeGroups builds every object literal the same way), so the same
 * arrangement always produces the same string on both sides. Not a security
 * property and not a version number: a collision costs one stale overwrite of a
 * board the tablet was editing anyway, which is what happened on every save
 * before this existed.
 * @param {{groups?: object[]}} board
 * @returns {string}
 */
export function boardRev(board) {
  const text = JSON.stringify(board?.groups ?? []);
  let hash = 0x811c9dc5;
  for ( let i = 0; i < text.length; i++ ) {
    hash ^= text.charCodeAt(i);
    // Math.imul, not `*`: the product leaves the 2^53 the double can hold exactly
    // and would lose the low bits that carry the whole hash.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Save groups sent up from a tablet into the board it was edited against.
 *
 * Only one key is ever touched — the tablet has no idea the other boards exist,
 * and a whole-collection write from it would delete every board for a scene the
 * GM is not looking at.
 *
 * Which key, though, used to be answered at *write* time: whichever board was
 * active when the frame happened to arrive. A tablet edits the board it was shown
 * and keeps it while the edit is dirty (relay/public/index.html, the state
 * handler), so if the GM walked the party into another scene meanwhile, the save
 * landed on that other scene's board — overwriting an arrangement nobody was
 * editing, under its own name, and losing the edit that was actually made.
 *
 * So the tablet now names the board it edited, and a mismatch is *refused*, not
 * retargeted. Refusing rather than writing to the named board is the deliberate
 * choice: the tablet holds a snapshot of that board taken before it drifted out
 * of view, so writing it back would resurrect an arrangement the GM may since
 * have changed from Foundry — a second silent overwrite, just of a different
 * board, and of one nobody is even looking at to notice. A refusal costs nothing
 * that cannot be recovered: the edit is still on the tablet, still dirty, still
 * saveable the moment the GM is back on that scene, and the caller reports why in
 * one line rather than leaving it to be discovered later.
 * @param {unknown} groups
 * @param {{key?: string, rev?: string}|null} [expect]  The board identity the
 *   tablet was published and edited against. Absent from a client that predates
 *   the field, which keeps the old "write to whatever is active" behaviour.
 * @returns {Promise<{ok: true, key: string, rev: string}|{ok: false, key: string, reason: string, error: string}>}
 */
export async function saveActiveGroups(groups, expect = null) {
  const clean = sanitizeGroups(groups);

  // The whole read-modify-write inside the queue, not just the write. This is the
  // one caller that can do that — it decides everything from what it reads, with no
  // dialog in the middle — and it is the one that has to, because it is the one
  // that fires while the GM is working the board manager. Reading here means the
  // `rev` check below is made against the collection this save is actually landing
  // on rather than against one a queued write is about to replace.
  return queueFlagWrite(async () => {
    const { key, board, collection } = readActiveBoard();

    // Bounded before it is compared or shown: this arrived from a tablet through a
    // relay that checks neither, and it ends up in a notification string.
    const wantedKey = boundedString(expect?.key, "", MAX_KEY);
    if ( wantedKey && (wantedKey !== key) ) {
      return {
        ok: false,
        key,
        reason: "board",
        error: `Zapis dotyczy planszy „${boardLabel(wantedKey, collection.boards[wantedKey])}”`
          + `, a aktywna jest „${boardLabel(key, board)}”`
      };
    }

    const rev = boardRev(board);
    const wantedRev = boundedString(expect?.rev, "", MAX_LABEL);
    if ( wantedRev && (wantedRev !== rev) ) {
      return {
        ok: false,
        key,
        reason: "rev",
        error: `Plansza „${boardLabel(key, board)}” zmieniła się w międzyczasie — odśwież i zapisz ponownie`
      };
    }

    const next = foundry.utils.deepClone(collection);
    next.boards[key] = { name: collection.boards[key]?.name ?? boardFallbackName(key), groups: clean };
    // commitCollection, not writeCollection: this is already inside the queue and
    // joining it again from here would wait on a turn that cannot come.
    const stored = await commitCollection(sanitizeCollection(next), collection, true, "zapis z tabletu");
    // Computed from what was stored, not from what arrived: this is the identity the
    // tablet has to echo on its *next* save, and sanitizeGroups may well have dropped
    // something on the way in.
    return { ok: true, key, rev: boardRev(stored.boards[key] ?? next.boards[key]) };
  });
}

/**
 * Give a board that does not exist yet a readable name.
 * @param {string} key
 * @returns {string}
 */
export function boardFallbackName(key) {
  if ( key === DEFAULT_KEY ) return DEFAULT_NAME;
  if ( key.startsWith(SCENE_PREFIX) ) {
    return boundedString(game.scenes?.get(key.slice(SCENE_PREFIX.length))?.name, key, MAX_LABEL);
  }
  if ( key.startsWith(SYSTEM_PREFIX) ) {
    const id = key.slice(SYSTEM_PREFIX.length);
    return boundedString((game.system?.id === id) ? game.system.title : id, id, MAX_LABEL);
  }
  return key;
}

/**
 * A human label for a board key: the scene's or system's current name, which the
 * stored board name may well have drifted from.
 * @param {string} key
 * @param {object} [board]
 * @returns {string}
 */
export function boardLabel(key, board) {
  if ( key === DEFAULT_KEY ) return board?.name || DEFAULT_NAME;
  if ( key.startsWith(SCENE_PREFIX) ) {
    const scene = game.scenes?.get(key.slice(SCENE_PREFIX.length));
    return `Scena: ${scene?.name || board?.name || key.slice(SCENE_PREFIX.length)}`;
  }
  if ( key.startsWith(SYSTEM_PREFIX) ) {
    const id = key.slice(SYSTEM_PREFIX.length);
    return `System: ${((game.system?.id === id) && game.system.title) || board?.name || id}`;
  }
  return board?.name || key;
}

/**
 * Put a snapshot from the undo history back, keeping the collection it displaces
 * at the head of that history so the restore is itself undoable.
 *
 * The default is the newest entry, which is what the pairing window's single
 * "restore" button means and what this did when there was only ever one snapshot.
 * @param {number} [index=0]  Which entry, newest first.
 * @returns {Promise<boolean>}  Whether anything was restored.
 */
export async function restoreBackup(index = 0) {
  const snapshot = readBackupHistory()[Number(index) || 0];
  if ( !snapshot ) return false;
  // No `base`: a restore is not an edit of what is stored, it is a replacement of
  // it, so nothing about the current collection should survive the write.
  await writeCollection(snapshot.data, { reason: "cofnięcie przywrócenia", base: null });
  return true;
}

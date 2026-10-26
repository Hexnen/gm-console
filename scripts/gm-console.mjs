/**
 * GM Console — streams a tablet-editable macro console to an external relay and
 * executes macros on request, reporting back what they actually did.
 *
 * Foundry has no server-side extension point: module code only ever runs in a
 * browser client. So this tab is the executor. It opens an outbound SSE stream
 * to a small relay, which the tablet talks to over plain HTTP.
 */

import { PairingApp } from "./pairing-app.mjs";
import {
  MAX_KEY,
  MAX_LABEL,
  MAX_MACRO_ID,
  MODULE_ID,
  applyParams,
  boardLabel,
  boardRev,
  boundedString,
  describeParams,
  macroTraits,
  readActiveBoard,
  readCollection,
  readFavorites,
  saveActiveGroups,
  setFavorite
} from "./boards.mjs";

export { MODULE_ID };

/** How long to keep watching chat after a macro runs, for its output. */
const CAPTURE_MS = 300;

/**
 * Separates a macro id from the parameter values packed behind it — see unpackFire
 * for why they travel there. A Foundry document id is 16 characters drawn from
 * [A-Za-z0-9] (common/utils/helpers.mjs:1252-1262), so this can never occur inside
 * a real one and the split is unambiguous.
 */
const PARAM_SEPARATOR = "?";

/** Ceiling on one packed fire payload, so a hostile frame cannot be parsed at length. */
const MAX_FIRE_PAYLOAD = 4096;

/**
 * Marks a `fire` frame that is not a macro request at all but an instruction to
 * the console — starring a macro, activating a scene, working the music.
 *
 * It rides the fire channel because that is the only tablet→GM route the relay
 * forwards structure on: /api/layout is rebuilt as `{groups}` and nothing else
 * (relay/server.mjs, the POST /api/layout handler), while /api/fire forwards
 * `macroId` verbatim. A Foundry document id is 16 characters of [A-Za-z0-9]
 * (common/utils/helpers.mjs:1252-1262), so a leading "!" can never begin a real
 * one and the two kinds of frame can never be confused for each other. The
 * request/response plumbing, the auth and the action log all come for free.
 *
 * THE CONVENTION, in full, so the next feature extends it rather than inventing
 * a second one:
 *
 *   macroId = "!" + <name> + PARAM_SEPARATOR + JSON.stringify(<payload object>)
 *
 * One name, one JSON object, and the payload is optional — "!stop" with nothing
 * behind it is a legal frame. unpackFire splits it; a tail that will not parse is
 * `damaged` and the command is refused rather than run with defaults. Every
 * command is answered on the ordinary /api/result channel with the same
 * `{ok, macro, text}` shape a macro run reports, so the tablet's existing toast,
 * latency and haptics all work on a scene change with no special case; `macro`
 * carries whatever the command acted on (the scene's name, the playlist's), since
 * that is the field the page already prints. A command that has something to
 * *return* — only `!sounds` today — puts it in an extra field on that same frame,
 * which reaches the asking device alone (relay/server.mjs, the POST /api/result
 * handler routes by the waiting device's token).
 *
 * Nothing here is a macro: no command reaches Macro#execute, and a command frame
 * comes out of unpackFire with an empty macroId precisely so it cannot.
 */
const COMMAND_PREFIX = "!";

/** Longest command name accepted, so a hostile frame cannot be matched at length. */
const MAX_COMMAND = 16;

/**
 * Caps on the scene and audio panel, in the same spirit as the board caps in
 * boards.mjs: everything published goes to every paired tablet on every change,
 * and everything accepted arrives from a device that is a credential rather than
 * a peer. A world with four hundred scenes is a world whose console lists the
 * first hundred, not one that pushes a megabyte every time the music changes.
 */
const MAX_SCENES = 120;
const MAX_PLAYLISTS = 120;
/** Sounds returned by one `!sounds` listing — sent to the asking device only. */
const MAX_SOUNDS = 300;
/**
 * Sounds published per playlist in the broadcast state. Only the ones actually
 * playing are published at all (see buildAudio), and a playlist in SIMULTANEOUS
 * mode can legitimately have a handful going at once; anything beyond that is a
 * runaway, not a soundscape.
 */
const MAX_PLAYING = 12;
/** A fade longer than this is a mistake, and PlaylistSound caps it at half the track anyway. */
const MAX_FADE_MS = 60000;
/** Document names are published for display; a playlist may be titled at length. */
const MAX_NAME = 80;

/**
 * Combatants published per encounter.
 *
 * The combat slice is republished on every turn, so it is the one slice whose size
 * is paid for again and again — the reason it carries a name, a number and two
 * short lists per row and nothing else. A fight with fifty rows is already past
 * what anyone runs off a tablet; beyond that the console shows the first fifty
 * rather than pushing a novel to every paired device six times a round.
 */
const MAX_COMBATANTS = 50;
/** Conditions shown on one combatant's row. Anything past this is a stack, not a state. */
const MAX_CONDITIONS = 12;
/** Conditions offered in one `!conds` listing — sent to the asking device only. */
const MAX_CONDITION_LIST = 80;
/**
 * Ceiling on one damage or healing step. Not a rules bound — a system may well
 * deal four figures — but a finite one means no single tap can write an absurd
 * number, and Actor#modifyTokenAttribute clamps a bar to [0, max] anyway
 * (client/documents/actor.mjs:422).
 */
const MAX_HP_DELTA = 100000;

/*
 * The chat feed.
 *
 * Chat is the highest-frequency thing in a Foundry world by a wide margin, and the
 * relay stores one snapshot and replaces it outright (relay/server.mjs, the POST
 * /api/state handler) — so every one of these caps is paid on every push, and the
 * push rate matters more than any of them. See buildFeed for what travels and
 * scheduleFeedPush for how often.
 */
/**
 * Entries published, newest kept. Enough that a GM who picks the tablet up after a
 * minute of dice sees what they missed; small enough that the slice stays a couple
 * of kilobytes rather than the world's whole chat log.
 */
const MAX_FEED = 30;
/** Characters of one message's text. A tablet row shows one line; this is the line. */
const MAX_FEED_TEXT = 160;
/** Characters of a roll's flavour (its label) and of a printed formula. */
const MAX_FEED_FLAVOR = 80;
const MAX_FEED_FORMULA = 60;
/** Rolls carried per message. A system that attaches six is describing, not rolling. */
const MAX_FEED_ROLLS = 4;
/** Dice terms carried per roll, and results carried per term. */
const MAX_FEED_DICE = 6;
/**
 * Individual die results per term. A 100d6 pool is a real thing in some systems and
 * its total is the useful part; a hundred numbers on a tablet row is not.
 */
const MAX_FEED_RESULTS = 20;

/**
 * The global volume settings this console is willing to touch, by audio channel.
 *
 * Two of the three CONST.AUDIO_CHANNELS, on purpose. `interface` is dice clatter
 * and UI clicks on whichever machine is looking — never a thing a GM reaches for
 * mid-session — and "expose what is useful" is worth more than symmetry.
 *
 * All three are registered scope: "client" (client/audio/helper.mjs:293-320), so
 * these move the volume in *this* browser tab and nowhere else. At a table that
 * is exactly right, because the GM's machine is the one wired to the speakers;
 * over a remote game it is not, and the tablet says so rather than implying it
 * turned the music down for the players.
 */
const VOLUME_SETTINGS = {
  music: "globalPlaylistVolume",
  environment: "globalAmbientVolume"
};

let stream = null;
let retryTimer = null;
let retryDelay = 2000;
let pushTimer = null;
let lastPayload = "";
/**
 * The tail of every state push, so exactly one is ever in flight.
 *
 * Three independent things publish — the 250 ms debounce, the chat feed's own
 * 1.2 s window, and the forced pushes after a save, a star, a stream opening or a
 * resync — and nothing used to stop two of them overlapping. The relay keeps one
 * snapshot and replaces it, so the one that *finished* last was the one the
 * tablets got, while `lastPayload` was set by the one that *resolved* last: two
 * different orders, and when they disagreed the console recorded a state the relay
 * was not holding. Every later unchanged push then matched that fingerprint and
 * returned early, so the tablet stayed frozen on the losing snapshot until
 * something happened to change the state again.
 */
let pushChain = Promise.resolve();
/**
 * Sequence number carried by every push, so the relay can tell "older" from
 * "newer" rather than "arrived later". Never reset while the tab lives.
 */
let pushSeq = 0;
/**
 * Which publishing session these sequence numbers belong to.
 *
 * The relay ignores a body whose `seq` is not greater than the last it accepted
 * for the same `gen`, and accepts anything under a `gen` it has not seen — which
 * is what makes a reloaded GM tab, whose counter starts again at 1, publishable at
 * all. So this must be a fresh value whenever the counter goes backwards, i.e.
 * whenever the module starts up or reconnects from scratch, and must *not* change
 * between two ordinary pushes.
 *
 * It is also declared on the event stream — `?role=gm&gen=…`, see connect() — which
 * is minted here and in reconnect(), both strictly before the EventSource is built,
 * so the value on the stream and the value in the body are always the same one. The
 * relay uses that to make the tab it *delivers* fires to and the tab it *accepts*
 * pushes from the same tab (relay/server.mjs, boundGen/electPublisher). Without it
 * the two elections are independent, and a GM with a popped-out second window can
 * end up firing macros from one tab while publishing from the other.
 */
let pushGen = newPushGen();
/** Set once the relay has rejected our credential, so the retry loop stops and the GM is warned exactly once. */
let authRejected = false;
/**
 * Monotonic connection generation, bumped by every teardown and every connect.
 * An async continuation captures the value it started under and gives up when it
 * no longer matches: without that, `disconnect()` cannot cancel an in-flight
 * `verifyThenRetry()`, and when that resumes it opens a second EventSource on top
 * of the live one — two streams, so one tap on the tablet runs the macro twice.
 */
let epoch = 0;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  const { StringField, BooleanField } = foundry.data.fields;

  // onChange is the *only* path that rebuilds the connection. Foundry fires it
  // exactly once per real change — a client setting whose value did not actually
  // differ returns before calling it (client/helpers/client-settings.mjs:322-327)
  // — so callers must never also poke reconnect() themselves, or every credential
  // change would build and tear down two EventSources.
  game.settings.register(MODULE_ID, "relayUrl", {
    name: "GMCONSOLE.Settings.RelayUrl.Name",
    hint: "GMCONSOLE.Settings.RelayUrl.Hint",
    scope: "client", config: true,
    type: new StringField({ required: true, blank: true, initial: "" }),
    onChange: () => reconnect()
  });

  // Not config: true — the token is obtained from the relay with a one-time
  // bootstrap code and rotated from the pairing window, never hand-typed.
  game.settings.register(MODULE_ID, "token", {
    scope: "client", config: false,
    type: new StringField({ required: true, blank: true, initial: "" }),
    onChange: () => reconnect()
  });

  game.settings.register(MODULE_ID, "enabled", {
    name: "GMCONSOLE.Settings.Enabled.Name",
    hint: "GMCONSOLE.Settings.Enabled.Hint",
    scope: "client", config: true,
    type: new BooleanField({ initial: true }),
    onChange: () => reconnect()
  });

  game.settings.registerMenu(MODULE_ID, "pairing", {
    name: "GMCONSOLE.Settings.Pairing.Name",
    label: "GMCONSOLE.Settings.Pairing.Label",
    hint: "GMCONSOLE.Settings.Pairing.Hint",
    icon: "fa-solid fa-qrcode",
    type: PairingApp,
    restricted: true
  });
});

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  if ( !game.user.isGM ) return;

  game.modules.get(MODULE_ID).api = {
    reconnect, pushState, buildState, disconnect, config,
    readCollection, readActiveBoard,
    openPairing: () => new PairingApp().render({ force: true })
  };

  Hooks.on("updateUser", user => {
    if ( user.id === game.user.id ) schedulePush("board", "library");
  });
  for ( const hook of ["createMacro", "updateMacro", "deleteMacro"] ) {
    // Both slices: the library is obviously the macros, and a tile's published
    // name and image are read off the macro it points at.
    Hooks.on(hook, () => schedulePush("board", "library"));
  }

  /*
   * Audio. Every one of these is a document change, which is the whole reason the
   * panel needs nothing of its own to remember: "what is playing" is a field on a
   * PlaylistSound in the world database, so it is the same answer before and after
   * the GM reloads their tab, and this only has to notice that it moved.
   *
   * Playlist#playAll and friends update the parent and its embedded sounds in one
   * operation, so a single tap raises several of these; they all land in the same
   * debounced push, and pushState drops it if the payload did not actually change.
   */
  for ( const name of ["Playlist", "PlaylistSound"] ) {
    for ( const verb of ["create", "update", "delete"] ) {
      Hooks.on(`${verb}${name}`, () => schedulePush("audio"));
    }
  }

  /*
   * The two global channel volumes are the exception to all of that: they are
   * client settings on this tab, not documents, so none of the hooks above says a
   * word when they move. That was fine while the audio slice was rebuilt on every
   * push — the value was simply re-read — and stopped being fine the moment the
   * slice started being cached, because nothing invalidated it and the number the
   * tablet showed was then the one that happened to be set when the console last
   * rebuilt. It never moved again, whether the GM dragged Foundry's own sidebar
   * slider or the tablet asked for a change.
   *
   * `invalidate`, not `schedulePush`. The design that publishes nothing for a
   * volume nudge is deliberate and still holds: a slider drag must not cost every
   * paired tablet the boards, the library, the scenes and the encounter, and the
   * tablet that moved it is confirmed by its own result frame. This restores what
   * the design actually promised — that the value is re-read on the next push that
   * happens anyway — rather than adding a push per drag.
   *
   * AudioHelper raises both from the setting's own onChange
   * (client/audio/helper.mjs:335, 355), so they fire for the sidebar slider and for
   * the tablet's `!vol` alike.
   */
  for ( const hook of ["globalPlaylistVolumeChanged", "globalAmbientVolumeChanged"] ) {
    Hooks.on(hook, () => invalidate("audio"));
  }

  // Scenes the tablet lists. createScene/deleteScene are unconditional — the list
  // gained or lost a row — while an update is filtered to the fields that are
  // actually published, because a Scene document is written for reasons that have
  // nothing to do with any of them.
  Hooks.on("createScene", () => schedulePush("scenes"));
  Hooks.on("deleteScene", () => schedulePush("scenes"));

  // Which board is active follows the scene, so republish when that changes.
  //
  // canvasReady is the one hook that covers both halves of "the GM is now
  // somewhere else". Merely viewing another scene goes Scene#view ->
  // canvas.draw (client/documents/scene.mjs:273-281), and drawing ends in
  // Hooks.call("canvasReady") (client/canvas/board.mjs:1243). *Activating* a
  // scene reaches the same place: the update operation calls _onActivate on
  // every client (client/documents/scene.mjs:1233-1234) and that calls view()
  // (client/documents/scene.mjs:1401-1403). So a scene-update hook would be
  // redundant for the normal case and, worse, would fire on every unrelated
  // edit to the scene — a token move updates the Scene document too.
  //
  // The one case canvasReady cannot cover is no-canvas mode, where canvas.draw
  // never runs at all: there the activated scene is the only notion of "where
  // the GM is", and updateScene filtered to an actual activation is what sees it
  // change. Both routes end in the same debounced push, and pushState drops a
  // push whose payload is unchanged, so the overlap costs nothing.
  /*
   * Combat. Its own slice with its own hooks, because it is the one thing here
   * that moves several times a minute: a turn change must not cost every paired
   * tablet a re-walk of the boards and a re-map of three hundred macros.
   *
   * Every one of these is a document change, so — exactly as with audio — the
   * console has nothing of its own to remember. Whose turn it is, the round, the
   * initiative order and every hit point are fields on Combat, Combatant and
   * Actor documents in the world database, which is why the panel is the same
   * after the GM reloads their tab as it was before, and why a change the GM
   * makes on the laptop reaches the tablet with no extra plumbing at all.
   *
   * There is no `combatEnd` hook in v14 — the only "combatEnd" in the source is an
   * ActiveEffect expiry event (client/documents/combat.mjs:678) — so an encounter
   * ending is seen as `deleteCombat`, and `combatTurn`/`combatRound` are not used
   * either: they fire *before* the update and only on the client that initiated it
   * (client/documents/combat.mjs:293-294), while `updateCombat` fires on every
   * client after the fact, which is the one that must be right when the GM works
   * the tracker on their laptop.
   */
  for ( const name of ["Combat", "Combatant"] ) {
    for ( const verb of ["create", "update", "delete"] ) {
      Hooks.on(`${verb}${name}`, () => schedulePush("combat"));
    }
  }

  // Hit points live on the Actor, so this is the hook that carries damage — and
  // it carries it for an unlinked token too, since ActorDelta#_onUpdate re-emits
  // it for the synthetic actor (client/documents/actor-delta.mjs:225). It fires
  // for every actor edit in the world, most of which have nothing to do with the
  // fight, so it is filtered to the encounter being published.
  Hooks.on("updateActor", actor => {
    if ( affectsCombat(actor) ) schedulePush("combat");
  });

  // Conditions are ActiveEffects; `Actor#statuses` is rebuilt from them on every
  // data preparation (client/documents/actor.mjs:247-261). Which effects, though,
  // is the whole of this: the loop that fills `statuses` walks
  // `allApplicableEffects()`, and that yields the transferred effects of every one
  // of the actor's Items as well as the actor's own (client/documents/actor.mjs:
  // 310-318). So an effect whose parent is an Item is just as much a condition on
  // the actor — which is why the actor is resolved through effectActor rather than
  // taken as `effect.parent`.
  for ( const verb of ["create", "update", "delete"] ) {
    Hooks.on(`${verb}ActiveEffect`, effect => {
      if ( affectsCombat(effectActor(effect)) ) schedulePush("combat");
    });
  }

  /*
   * And the Items themselves. An item created with its effects already on it — the
   * ordinary way a condition arrives in most systems, since dragging a "Poisoned"
   * item onto a sheet creates the item and its embedded effects in one operation —
   * raises no `createActiveEffect` at all, so without this the tablet kept showing
   * the conditions from before it, and kept showing a combatant as alive after the
   * item that marked them defeated was dropped on them (`Combatant#isDefeated`
   * reads `actor.statuses`, client/documents/combatant.mjs:124-126).
   *
   * Deliberately not filtered to a list of fields, unlike updateToken. There is no
   * such list to write: a system that derives an effect's `disabled` from whether
   * the item is equipped changes what the actor's statuses are by writing
   * `system.equipped` and nothing else, and no field name here would survive the
   * next system. The filter that matters is affectsCombat — this fires only for
   * items on the handful of actors in the encounter being published.
   */
  for ( const verb of ["create", "update", "delete"] ) {
    Hooks.on(`${verb}Item`, item => {
      if ( affectsCombat(item?.parent) ) schedulePush("combat");
    });
  }

  // A token moves constantly during a fight and writes its document every time,
  // so this is filtered twice over: to the fields the slice actually publishes,
  // and to the encounter. A combatant's name and image fall back to the token's
  // (client/documents/combatant.mjs:166-167) and the hit points are read through
  // the token's bars, which is why those four fields and no others.
  Hooks.on("updateToken", (token, changed) => {
    if ( !TOKEN_FIELDS.some(field => field in changed) ) return;
    if ( affectsCombat(token?.actor) ) schedulePush("combat");
  });

  /*
   * Chat. The one slice with a scheduler of its own — see scheduleFeedPush — because
   * it is the only thing here that can fire twenty times in a combat round, and the
   * relay replaces the whole snapshot on every push.
   *
   * All three verbs, so the feed tracks edits and deletions and not merely arrivals.
   * That is not politeness: buildFeed re-reads game.messages every time, so a deleted
   * message leaves the tablet on the next push instead of sitting there — and the
   * message most likely to be deleted in a hurry is the one that was whispered to the
   * wrong person. An edited roll simply re-publishes with its new total.
   *
   * `updateChatMessage` fires for every client's edits (client/data/client-backend.mjs:
   * 337), `create` at :164 and `delete` at :466, so a message posted or removed on a
   * player's machine reaches the tablet exactly as one posted here does.
   */
  for ( const verb of ["create", "update", "delete"] ) {
    Hooks.on(`${verb}ChatMessage`, () => scheduleFeedPush());
  }

  Hooks.on("canvasReady", () => schedulePush("board", "scenes", "combat"));
  Hooks.on("updateScene", (scene, changed) => {
    // Which board is served follows the active scene, and the panel marks it. So
    // does which encounter is in front of the GM: game.combats.combats is filtered
    // to the current scene (client/documents/collections/combat-encounters.mjs:45).
    if ( "active" in changed ) return schedulePush("board", "scenes", "combat");
    // Everything else the scene list publishes. A token move, a fog update or a
    // lighting tweak writes the Scene document too and must not cost every paired
    // tablet a state frame.
    if ( SCENE_FIELDS.some(field => field in changed) ) schedulePush("scenes");
  });

  reconnect();
});

/* -------------------------------------------- */
/*  Layout                                      */
/* -------------------------------------------- */

/**
 * The tile a fire request is allowed to refer to, or null — the whitelist of what
 * a tablet may run, and now also the authority on what it may run it *with*.
 * Rebuilt per call rather than cached: the boards live in a user flag that the
 * GM, another of their tabs, or the tablet itself can change at any moment, and
 * the active board changes whenever the GM looks at another scene, so a stale
 * whitelist would either refuse a legitimate tile or keep a removed one alive.
 *
 * Only the *active* board counts. A macro parked on some other scene's board is
 * not on the console the tablet can see, so a tap claiming it did not come from
 * a tile the GM put in front of themselves.
 *
 * `locator` disambiguates the case the parameter feature makes ordinary: the same
 * macro on two tiles with different declared parameters — "obrażenia" defaulting
 * to 5 next to one defaulting to 8. It selects a tile; it can never widen what may
 * be run, because the item it picks still has to be the requested macro and its
 * parameters still come from here.
 *
 * A locator that does not resolve fails closed, and so does a request that carries
 * none. Resolving by macro id alone used to be the fallback for a client older than
 * the locator, and it reads as harmless — "same macro either way" — but it is the
 * one answer this must never give: it picks *some* tile with that id, so a frame
 * naming no position was resolved against a tile on whichever board happened to be
 * active, with a lock the user never held and parameters they never typed. An
 * orphaned hold on the tablet posts exactly that frame — fireBody()'s bare branch
 * sends the macro id and nothing else when locate() cannot place the item
 * (relay/public/index.html) — so the fallback was the step that turned a malformed
 * request into a run of a guarded macro.
 *
 * Every legitimate tap now carries a locator: a tile tap reads its position at tap
 * time (tapOrigin), and a prompt captures it before the modal opens rather than
 * after it closes. So "no locator" no longer names a client, it names a frame that
 * lost the only thing that says which tile the user touched — and there is no such
 * thing as running that safely. The one caller with genuinely no tile is the search
 * sheet, which never reaches here: executeMacro resolves nothing for `via: "search"`
 * and authorises it against the published library instead.
 * @param {string} macroId
 * @param {{group: string, index: number}|null} locator
 * @param {{key: string, board: object}} [active]  The board to resolve against;
 *   read here by default, passed in by a caller that already has it in hand.
 * @returns {object|null}  The stored item, never a copy the caller sent.
 */
function findBoardItem(macroId, locator, active = readActiveBoard()) {
  // No position, no tile. Asked before the walk, so there is no branch below in
  // which a match without a locator can be picked up by accident later.
  if ( !locator ) return null;
  for ( const group of active.board.groups ?? [] ) {
    const items = group?.items ?? [];
    for ( let i = 0; i < items.length; i++ ) {
      if ( !items[i]?.macroId || (String(items[i].macroId) !== macroId) ) continue;
      if ( (group.id === locator.group) && (i === locator.index) ) return items[i];
    }
  }
  // Named a tile and it is not there any more: refuse, and let the caller say so.
  return null;
}

/**
 * Split a `fire` frame into the macro to run, the values to run it with, and the
 * tile they were typed on.
 *
 * The values arrive packed into `macroId` because the relay rebuilds that frame
 * from exactly three fields — `reqId`, `macroId`, `device` (relay/server.mjs, the
 * POST /api/fire handler) — and drops everything else the tablet posted, while
 * forwarding the value of `macroId` verbatim. `data.args`/`data.tile` are read
 * first, so the moment the relay does forward fields of its own the packing
 * becomes dead weight and can be deleted from both ends without a flag day.
 *
 * Nothing here is trusted: this only decides what was *asked for*. What is
 * permitted is decided by findBoardItem and applyParams against the stored board.
 * @param {object} data
 * @returns {{macroId: string, args: unknown, tile: object|null, board: string,
 *            damaged: boolean, command: string, payload: object, via: string}}
 */
function unpackFire(data) {
  let raw = String(data?.macroId ?? "").slice(0, MAX_FIRE_PAYLOAD);
  let packed = null;
  let damaged = false;
  const cut = raw.indexOf(PARAM_SEPARATOR);
  if ( cut >= 0 ) {
    const tail = raw.slice(cut + 1);
    raw = raw.slice(0, cut);
    try {
      packed = JSON.parse(tail);
    } catch {
      packed = null;
    }
    // A tail that will not parse means values were sent and did not survive the
    // trip — a relay that clipped the field, a truncated frame. This must fail,
    // loudly: treating it as "no values" would fall through to the declared
    // defaults and run the tile with numbers nobody chose, which is the one
    // outcome worse than not running it at all.
    if ( !packed || (typeof packed !== "object") || Array.isArray(packed) ) damaged = true;
  }

  const at = data?.tile ?? packed?.at ?? null;
  const tile = (at && (typeof at === "object") && (typeof at.group === "string") && Number.isInteger(at.index))
    // Bounded to what a stored group id can actually be (sanitizeGroups caps it at
    // MAX_LABEL), so a megabyte-long "group" never reaches a string comparison.
    ? { group: at.group.slice(0, MAX_LABEL), index: at.index }
    : null;

  // A console command, not a macro — see COMMAND_PREFIX. Separated here so that
  // nothing downstream has to wonder whether "!fav" might be a document id: a
  // command frame comes out with an empty macroId and can never reach execution.
  const command = raw.startsWith(COMMAND_PREFIX) ? raw.slice(1, MAX_COMMAND + 1) : "";

  // Which board the tap was made against. Bounded to what a stored board key can
  // be (sanitizeKey caps it at MAX_KEY), so a megabyte-long "board" never reaches
  // a string comparison. Empty means "the client said nothing", which is the only
  // thing a client older than this field can say — see executeMacro.
  const board = boundedString(data?.board ?? packed?.board, "", MAX_KEY);

  return {
    macroId: command ? "" : raw.slice(0, MAX_MACRO_ID),
    args: data?.args ?? packed?.args ?? null,
    tile,
    board,
    damaged,
    command,
    // Never used as anything but a bag of already-bounded reads. Same rule as
    // `args`: this says what was asked for, not what is allowed.
    payload: (packed && !Array.isArray(packed)) ? packed : {},
    // Which surface the tap came from. Compared against the one literal that
    // means anything rather than carried through, so an unknown value can only
    // ever fall back to the strict board path.
    via: ((data?.via === "search") || (packed?.via === "search")) ? "search" : "tile"
  };
}

/**
 * Persist a layout sent up from a tablet into the board it was edited against.
 *
 * Everything arriving here is hostile until proved otherwise — the relay only
 * checks that `groups` is an array — which is why the sanitising lives in
 * boards.mjs and is shared with the import path.
 *
 * A refusal is reported back down the same result channel a fire uses, so the
 * tablet can keep the edit and say why it did not go up. Without that the only
 * trace would be a notification on the GM's own screen, and the tablet would go
 * on believing it had saved — which is how a refusal turns into the same lost
 * edit it was added to prevent.
 * @param {string} reqId    The relay's id for this save, or "" from a relay that
 *                          predates the acknowledgement.
 * @param {unknown} groups
 * @param {unknown} board   `{key, rev}` naming the board the tablet edited.
 * @returns {Promise<void>}
 */
async function saveLayout(reqId, groups, board) {
  const expect = (board && (typeof board === "object") && !Array.isArray(board)) ? board : null;
  const result = await saveActiveGroups(groups, expect);
  if ( !result.ok ) {
    // Both ends hear about it: the GM, because a tablet's save just bounced off
    // their console and they are the one who moved it; the tablet, because it is
    // holding the only copy of the edit.
    console.warn(`${MODULE_ID} | refused a layout from another board: ${result.error}`);
    ui.notifications.warn(`GM Console: ${result.error}`);
    if ( reqId ) await postResult(reqId, { ok: false, text: result.error, layout: { key: result.key } });
    return;
  }
  await pushState(true);
  // The identity to edit against from here on. The tablet cannot compute it — the
  // fingerprint is over what was *stored*, sanitising and all — and without it the
  // next save of the same session would be refused as stale.
  if ( reqId ) await postResult(reqId, { ok: true, text: "Układ zapisany", layout: { key: result.key, rev: result.rev } });
}

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/**
 * Resolve an image path to an absolute URL — the tablet is served from a
 * different origin than Foundry and cannot resolve relative paths.
 * @param {string} img
 * @returns {string}
 */
function absoluteImage(img) {
  if ( !img ) return "";
  if ( /^(https?:)?\/\//.test(img) || img.startsWith("data:") ) return img;
  const route = foundry.utils?.getRoute?.("/") ?? "/";
  try {
    return new URL(img, `${window.location.origin}${route}`).href;
  } catch {
    return img;
  }
}

/* -------------------------------------------- */
/*  Untrusted markup                            */
/* -------------------------------------------- */

/**
 * Parses inertly, once, for every call.
 *
 * A document produced by DOMParser has no browsing context, so nothing in it
 * loads or executes. Assigning innerHTML on a detached <div> is not equivalent:
 * that node still belongs to the live document, and Chromium fetches its <img>
 * sources — enough for an `onerror` payload in a player-authored chat message to
 * run script in the GM's tab, which is exactly the content passing through here.
 *
 * It sits up here, above the slices, because it now has two callers rather than
 * one: a macro's chat output on the way to a toast, and every message body on the
 * way into the feed. Both are arbitrary HTML written by players and modules, and
 * both must leave this file as text and nothing else — the tablet page has no
 * innerHTML anywhere and must never need one.
 */
const domParser = new DOMParser();

/**
 * Strip markup so chat content can be shown as plain text.
 * @param {string} html
 * @returns {string}
 */
function plainText(html) {
  if ( !html ) return "";
  const doc = domParser.parseFromString(String(html), "text/html");
  return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The same text, but with every element boundary left as a space.
 *
 * `textContent` runs adjacent elements together, so the dice template's
 * `<div>1d20 + 5</div><h4>17</h4>` becomes the single run "1d20 + 517" and the
 * total is no longer a number anybody can find in it. That costs nothing when the
 * text is only being *shown* — which is why plainText is left exactly as it is,
 * and why what is published is still its output — but it is fatal to a test that
 * asks whether a number appears. A space before every `<` cannot change how the
 * markup parses (whitespace between elements is only ever text) and cannot change
 * what any element contains.
 * @param {string} html
 * @returns {string}
 */
function spacedText(html) {
  return plainText(String(html ?? "").replace(/</g, " <"));
}

/* -------------------------------------------- */
/*  State slices                                */
/* -------------------------------------------- */

/*
 * The state is pushed whole to every paired tablet on every change, because the
 * relay stores one snapshot and replaces it outright (relay/server.mjs, the POST
 * /api/state handler) — a partial push would blank whatever it left out. So the
 * only two levers that exist are *what goes in* and *how often it is rebuilt*,
 * and the panel leans on both:
 *
 *  - What: the audio slice carries playlists and the sounds that are actually
 *    playing, never the world's sound library. A playlist's contents are fetched
 *    on demand by the one tablet that opened it (the `!sounds` command), so a
 *    world with three hundred tracks costs the broadcast nothing.
 *  - How often: a volume nudge publishes *nothing at all*. The global channel
 *    volumes are client settings on this tab, so there is no document to change;
 *    the tablet's slider is confirmed by its own result frame, and the value is
 *    only re-read on the next push that happens anyway. That last part is a
 *    promise the slice cache can break, so it is kept by an explicit invalidation
 *    from AudioHelper's own volume hooks — see the ready() handlers. Invalidating
 *    without publishing is the whole trick: nothing goes out now, but nothing is
 *    stale when something does.
 *  - And when a push does happen, only the slice whose hook fired is rebuilt.
 *    Turning the music down used to mean re-walking every board for macroTraits
 *    and re-mapping three hundred macros; now it re-reads the playlists.
 *
 * Correctness rests on every slice being invalidated by a hook that must fire for
 * the underlying data to have changed — see the ready() handlers, which name
 * their slices. A slice nobody invalidates is a console frozen on stale data, so
 * the bias throughout is to invalidate more than strictly necessary: `board` and
 * `library` go together everywhere because a tile's name is read off its macro.
 */
const slices = new Map();

/**
 * A cached slice of the published state, built on first use after invalidation.
 * @param {string} name
 * @param {() => object} build
 * @returns {object}
 */
function slice(name, build) {
  if ( !slices.has(name) ) slices.set(name, build());
  return slices.get(name);
}

/** @param {...string} names  Slices to rebuild on the next push. */
function invalidate(...names) {
  for ( const name of names ) slices.delete(name);
}

/** Scene fields the panel publishes; an update touching none of them changes nothing here. */
const SCENE_FIELDS = ["name", "navName", "navigation", "navOrder", "thumb", "ownership"];

/**
 * Token fields the combat slice reads. A token is written on every step it takes,
 * and a fight is mostly steps, so anything not in this list must cost nothing.
 * `bar1`/`bar2` are here because they say *which* attribute the hit points are
 * read from (common/documents/token.mjs:81-88), not because they hold a value.
 */
const TOKEN_FIELDS = ["name", "texture", "bar1", "bar2", "hidden"];

/**
 * Round a 0..1 volume to something that survives a round trip without turning
 * every push into a new fingerprint. Foundry stores these as AlphaField with a
 * 0.01 step (common/documents/playlist-sound.mjs:51), so two decimals is the
 * whole of the information.
 * @param {unknown} value
 * @returns {number}
 */
function alpha(value) {
  const n = Number(value);
  if ( !Number.isFinite(n) ) return 0;
  return Math.round(Math.min(Math.max(n, 0), 1) * 100) / 100;
}

/**
 * The scenes this GM may actually put in front of the table.
 *
 * `canUserModify(user, "update")` is the equivalent of a macro's `canExecute`:
 * Scene has no custom permission for update, so it falls through to
 * testUserPermission(user, "OWNER") (common/abstract/document.mjs:432-447), which
 * a full GM always passes (line 416) and an assistant only passes on a scene they
 * own. Activation additionally throws for a non-GM inside Foundry itself
 * (client/documents/scene.mjs:242), so the panel lists exactly what a tap could
 * actually do — and the same predicate is re-evaluated when the tap arrives.
 * @returns {{scenes: object[]}}
 */
function buildScenes() {
  // Both are getters that walk the collection; `current` additionally reads the
  // `canvas` global (client/documents/collections/scenes.mjs:40-44) and would
  // throw in a tab that has none, which would take the whole push down.
  let viewedId = null;
  let activeId = null;
  try {
    viewedId = game.scenes?.viewed?.id ?? null;
    activeId = game.scenes?.active?.id ?? null;
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not read which scene is in view`, err);
  }

  const scenes = [];
  for ( const scene of game.scenes?.contents ?? [] ) {
    if ( scenes.length >= MAX_SCENES ) break;
    if ( !canControlScene(scene) ) continue;
    scenes.push({
      id: scene.id,
      // navName is what the GM chose to call it on the nav bar; it is often the
      // shorter, table-facing name, which is the one wanted on a tablet.
      name: boundedString(scene.navName || scene.name, "(bez nazwy)", MAX_NAME),
      // Both present only when true — most scenes are neither, and a pair of
      // `false`s on every row of a hundred-scene world is pure weight.
      ...((scene.id === activeId) ? { active: true } : {}),
      ...((scene.id === viewedId) ? { viewed: true } : {}),
      // Foundry generates scene thumbnails as base64 and stores them in this same
      // field (client/documents/scene.mjs:1021-1027), and twenty of those would be
      // a megabyte pushed to every tablet on every change. Only a real path is
      // published; a world using generated thumbs simply gets a text list, which
      // is the right trade for a control surface that has to arrive instantly.
      ...(scene.thumb && !String(scene.thumb).startsWith("data:")
        ? { img: absoluteImage(scene.thumb) }
        : {})
    });
  }
  scenes.sort((a, b) => collator().compare(a.name, b.name));
  return { scenes };
}

/**
 * The playlists this GM may work, and what is coming out of the speakers.
 *
 * Deliberately not the sounds. `playlist.sounds` is the world's whole music
 * library and belongs in a listing the tablet asks for (see commandSounds); what
 * every tablet needs at all times is which playlists exist and which tracks are
 * up, and that is bounded by how much can physically be playing at once.
 * @returns {{playlists: object[], volume: object}}
 */
function buildAudio() {
  const playlists = [];
  for ( const playlist of game.playlists?.contents ?? [] ) {
    if ( playlists.length >= MAX_PLAYLISTS ) break;
    if ( !canControlPlaylist(playlist) ) continue;

    const now = [];
    for ( const sound of playlist.sounds ) {
      if ( now.length >= MAX_PLAYING ) break;
      if ( !sound.playing ) continue;
      now.push({ id: sound.id, name: boundedString(sound.name, "(bez nazwy)", MAX_NAME), volume: alpha(sound.volume) });
    }

    playlists.push({
      id: playlist.id,
      name: boundedString(playlist.name, "(bez nazwy)", MAX_NAME),
      // Playlist#prepareDerivedData recomputes this from the sounds on every
      // prepare (client/documents/playlist.mjs:80-82), so it is the live answer
      // rather than the stored field — which is exactly what survives a reload.
      ...(playlist.playing ? { playing: true } : {}),
      // How the playlist behaves when told to play, so the tablet can say
      // "soundboard" instead of offering a ▶ that would do nothing.
      mode: Number(playlist.mode ?? 0),
      channel: String(playlist.channel ?? "music"),
      count: playlist.sounds?.size ?? 0,
      // The stored fade, in ms. Absent means none — the field is `positive: true`
      // (common/documents/playlist.mjs:51) so it is null rather than 0 when unset.
      ...(playlist.fade ? { fade: Number(playlist.fade) } : {}),
      ...(now.length ? { now } : {})
    });
  }
  playlists.sort((a, b) => collator().compare(a.name, b.name));

  const volume = {};
  for ( const [channel, setting] of Object.entries(VOLUME_SETTINGS) ) {
    try {
      volume[channel] = alpha(game.settings.get("core", setting));
    } catch ( err ) {
      // A core setting that is somehow not registered must not take the push down.
      console.warn(`${MODULE_ID} | could not read core.${setting}`, err);
    }
  }
  return { playlists, volume };
}

/* -------------------------------------------- */
/*  Combat                                      */
/* -------------------------------------------- */

/*
 * Hit points, without knowing the system.
 *
 * This world runs stonetop and mythicbastionland; the next one will run something
 * else. So nothing below names a data path, and the console reads exactly what
 * Foundry itself reads when it draws the bar under a token:
 *
 *   TokenDocument#getBarAttribute(bar) resolves the token's configured attribute
 *   against actor.system and answers `{type, attribute, value, max, editable}`, or
 *   null when the path leads nowhere (client/documents/token.mjs:548-581). The bars
 *   are not guesses either — bar1/bar2 default to the system manifest's own
 *   `primaryTokenAttribute`/`secondaryTokenAttribute` (common/documents/token.mjs:
 *   81-88), which is the system telling Foundry where its hit points are.
 *
 * Three candidates are tried in order and the first that resolves wins:
 *
 *  1. The combat tracker's configured resource, when the GM set one. It is the
 *     only path anybody explicitly chose *for this list*, so it outranks the rest.
 *     Read through getBarAttribute rather than through Combatant#resource, which
 *     collapses a legitimate 0 to null (client/documents/combatant.mjs:181) — a
 *     character on exactly zero hit points is the one the tablet most needs to show.
 *  2. bar1, then 3. bar2.
 *
 * When none of them resolves the combatant is published with no `hp` at all and
 * the tablet shows a name and nothing else — which is the whole point. A wrong
 * number on a tablet is worse than no number: the GM would act on it.
 */

/**
 * Read one attribute through Foundry's own bar resolver, or null.
 *
 * Never throws. `getBarAttribute` walks a system DataModel to work out whether the
 * field is writable, and a path that means nothing to this system is a perfectly
 * ordinary thing for a stored setting to contain.
 * @param {TokenDocument|PrototypeToken} token
 * @param {string} bar          "bar1"/"bar2", or "" when using `alternative`.
 * @param {string} [alternative]  An explicit attribute path to resolve instead.
 * @returns {{attribute: string, type: string, value: number, max: number|null, editable: boolean}|null}
 */
function readBar(token, bar, alternative) {
  let found;
  try {
    // The two-argument form is Foundry's own way of asking about a path that is
    // not either bar (client/applications/sheets/token/token-config.mjs:130).
    found = alternative ? token.getBarAttribute("", { alternative }) : token.getBarAttribute(bar);
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not read ${alternative || bar} on a combatant`, err);
    return null;
  }
  if ( !found || !Number.isFinite(Number(found.value)) ) return null;
  const isBar = found.type === "bar";
  const max = isBar && Number.isFinite(Number(found.max)) ? Number(found.max) : null;
  return {
    attribute: found.attribute,
    type: found.type,
    value: Number(found.value),
    max,
    // A bar whose max is zero or missing is not a bar this console will write to:
    // modifyTokenAttribute clamps a bar update to [0, max] (client/documents/
    // actor.mjs:422), so on such a bar every damage and every heal would land on 0
    // and the tablet would report a success that silenced the character instead.
    editable: !!found.editable && (!isBar || (max > 0))
  };
}

/**
 * What this combatant has, and whether it can be changed from here.
 * @param {Combat} combat
 * @param {Combatant} combatant
 * @returns {object|null}
 */
function readVitals(combat, combatant) {
  const actor = combatant?.actor;
  if ( !actor ) return null;
  // A combatant need not be on the canvas. getBarAttribute is copied onto
  // PrototypeToken (client/client.mjs:189), so the actor's prototype token answers
  // the same question for one that is not.
  const token = combatant.token ?? actor.prototypeToken ?? null;
  if ( typeof token?.getBarAttribute !== "function" ) return null;

  // Combat#settings is game.settings.get("core", "combatTrackerConfig")
  // (client/documents/collections/combat-encounters.mjs:28), which throws when the
  // setting is somehow not registered — and a throw here would take the whole
  // state push down, exactly as an unregistered volume setting would in buildAudio.
  let resource = "";
  try {
    resource = boundedString(combat?.settings?.resource, "", MAX_NAME).trim();
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not read the combat tracker's resource setting`, err);
  }
  if ( resource ) {
    const found = readBar(token, "", resource);
    if ( found ) return found;
  }
  for ( const bar of ["bar1", "bar2"] ) {
    const found = readBar(token, bar);
    if ( found ) return found;
  }
  return null;
}

/**
 * The status effects this world offers, as a plain iterable — never indexed by a
 * key that came from outside.
 *
 * CONFIG.statusEffects is a Proxy over an array that also answers to each entry's
 * id (client/config.mjs:1686-1734), which means `CONFIG.statusEffects[x]` for a
 * hostile `x` of "constructor" hands back Array itself. Nothing here indexes it:
 * a requested id is matched by scanning, so an id that names no status finds none.
 * @returns {object[]}
 */
function statusCatalogue() {
  const out = [];
  try {
    for ( const status of foundry.utils.iterateValues(CONFIG.statusEffects) ) {
      // `length` rides along in that iteration; a real entry always has an id.
      if ( status?.id ) out.push(status);
    }
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not read CONFIG.statusEffects`, err);
  }
  return out;
}

/**
 * Would Foundry itself offer this status on this actor? The same two tests the
 * Token HUD makes (client/applications/hud/token-hud.mjs:96-99), so a system that
 * hides a status from the HUD hides it from the tablet too.
 * @param {object} status
 * @param {Actor|null} actor
 * @returns {boolean}
 */
function offersStatus(status, actor) {
  if ( status?.hud === false ) return false;
  return status?.hud?.actorTypes?.includes(actor?.type) !== false;
}

/**
 * A status effect's label in the language in use. The config carries a
 * localization key ("EFFECT.StatusProne"), which is what ActiveEffect.fromStatusEffect
 * localizes when it builds the effect (client/documents/active-effect.mjs:131).
 * @param {object} status
 * @returns {string}
 */
function statusLabel(status) {
  const raw = status?.name ?? status?.label ?? status?.id ?? "";
  return boundedString(game.i18n?.localize?.(raw) ?? raw, "", MAX_NAME);
}

/**
 * The conditions currently on a combatant, as `{id, name}`.
 *
 * Both halves are published on purpose: the name is what the row shows, and the id
 * is what lets the toggle sheet mark a fetched catalogue live — the same split the
 * audio panel uses, where the track list is fetched once but "is it playing" comes
 * from the broadcast every time.
 * @param {Actor|null} actor
 * @returns {{id: string, name: string}[]}
 */
function readConditions(actor) {
  const statuses = actor?.statuses;
  if ( !statuses?.size ) return [];
  const catalogue = statusCatalogue();
  const out = [];
  for ( const id of statuses ) {
    if ( out.length >= MAX_CONDITIONS ) break;
    const status = catalogue.find(s => s.id === id);
    // A status with no config entry is one a module applied and never declared.
    // It is still on the actor, so it is still shown — under its own id.
    out.push({ id: boundedString(id, "", MAX_NAME), name: statusLabel(status) || boundedString(id, "", MAX_NAME) });
  }
  return out;
}

/**
 * The encounter this console is willing to talk about, or null.
 *
 * `game.combat` is the tracker's *viewed* encounter, falling back to the active one
 * when there is no sidebar (client/game.mjs:1692-1696) — i.e. the fight the GM is
 * actually looking at, which is the same thing buildScenes means by `viewed`. It
 * reads `ui.combat` and `game.scenes.current`, both of which can be absent in a tab
 * with no canvas, so the read is guarded exactly as buildScenes guards its own.
 * @returns {Combat|null}
 */
function currentCombat() {
  try {
    return game.combat ?? null;
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not read the current encounter`, err);
    return null;
  }
}

/**
 * Is this actor in the encounter being published? Used to keep the hooks that fire
 * for the whole world from republishing on someone else's business.
 * @param {Actor|null} actor
 * @returns {boolean}
 */
function affectsCombat(actor) {
  if ( !actor ) return false;
  const combat = currentCombat();
  if ( !combat ) return false;
  try {
    // Identity first, id second: an unlinked token's actor is a synthetic document,
    // and two tokens of the same base actor share an id. Matching by id therefore
    // over-invalidates rather than missing one, which is the right way round.
    return combat.combatants.some(c => (c.actor === actor) || (c.actor?.id === actor.id));
  } catch {
    return false;
  }
}

/**
 * The actor whose conditions an ActiveEffect can change, or null.
 *
 * An effect's parent is not always an Actor. `allApplicableEffects()` yields the
 * transferred effects of the actor's owned Items alongside the actor's own
 * (client/documents/actor.mjs:310-318), and it is that generator the loop filling
 * `Actor#statuses` walks (client/documents/actor.mjs:247-261) — so an effect
 * parented to an Item is on the actor's condition list just as much as one
 * parented to the actor, and asking `affectsCombat(effect.parent)` about the Item
 * answered "no" for every one of them. That is a stale row on the tablet, and a
 * combatant still shown alive after the effect that marked them defeated arrived
 * on an item (`Combatant#isDefeated` reads `actor.statuses`,
 * client/documents/combatant.mjs:124-126).
 *
 * One level, not a walk to the root: an effect lives on an Actor or on an Item,
 * and an Item lives on an Actor or in the world sidebar. A world item's effects
 * are on nobody, which is what the null is.
 * @param {ActiveEffect|null} effect
 * @returns {Actor|null}
 */
function effectActor(effect) {
  const parent = effect?.parent;
  if ( !parent ) return null;
  return (parent.documentName === "Item") ? (parent.parent ?? null) : parent;
}

/**
 * The turn order, who is up, and what each combatant has left.
 *
 * Absent entirely when there is no encounter this GM may run — the key is simply
 * not in the state, and the tablet hides its combat button rather than showing an
 * empty tracker. Same rule as everywhere else here: publish what is true, omit what
 * is not, and never publish a `false`.
 * @returns {{combat?: object}}
 */
function buildCombat() {
  const combat = currentCombat();
  if ( !canControlCombat(combat) ) return {};

  const turns = [];
  // `turns` is the ordered list Combat#setupTurns builds during data preparation
  // (client/documents/combat.mjs:148, 488-510) — the same order the sidebar shows,
  // including whatever the system did to it.
  for ( const [index, combatant] of (combat.turns ?? []).entries() ) {
    if ( turns.length >= MAX_COMBATANTS ) break;
    const vitals = readVitals(combat, combatant);
    const conditions = readConditions(combatant.actor);
    const img = combatant.img ? absoluteImage(combatant.img) : "";
    turns.push({
      id: combatant.id,
      name: boundedString(combatant.name, "(bez nazwy)", MAX_NAME),
      // Whose turn it is, marked on the row rather than left to the tablet to work
      // out from an index: `turn` is nullable (common/documents/combat.mjs:63) and
      // "nobody's turn" is a real state a tracker can be in.
      ...((index === combat.turn) ? { active: true } : {}),
      ...(Number.isFinite(combatant.initiative) ? { init: combatant.initiative } : {}),
      ...(combatant.hidden ? { hidden: true } : {}),
      // isDefeated, not the raw flag: it also covers the actor carrying the
      // system's DEFEATED status (client/documents/combatant.mjs:124-126).
      ...(combatant.isDefeated ? { defeated: true } : {}),
      // Same rule as a scene thumbnail: a data: image would be kilobytes on a row
      // that is republished every single turn.
      ...((img && !img.startsWith("data:")) ? { img } : {}),
      ...(vitals
        ? { hp: {
          value: vitals.value,
          ...((vitals.max !== null) ? { max: vitals.max } : {}),
          // Present only when this console would actually write it. A tablet that
          // sees no `edit` shows the numbers and no buttons, which is the honest
          // rendering of "this system exposes it but not for writing".
          ...(vitals.editable ? { edit: true } : {})
        } }
        : {}),
      ...(conditions.length ? { cond: conditions } : {})
    });
  }

  return {
    combat: {
      id: combat.id,
      name: boundedString(combat.name, "", MAX_NAME),
      round: Number(combat.round ?? 0),
      // Null is meaningful here — see the `active` mark above.
      turn: Number.isInteger(combat.turn) ? combat.turn : null,
      ...(combat.started ? { started: true } : {}),
      turns
    }
  };
}

/* -------------------------------------------- */
/*  Chat feed                                   */
/* -------------------------------------------- */

/*
 * What the table just did, on the tablet.
 *
 * Three questions had to be answered before a single byte of chat could travel,
 * and none of them has a comfortable answer:
 *
 * 1. HOW IT TRAVELS. In the broadcast state, which is the expensive place — and
 *    it is there because it is the only place. The relay has exactly one GM→every
 *    tablet route, `state`, and it stores one snapshot and replaces it outright
 *    (relay/server.mjs, the POST /api/state handler). The other route, a `result`
 *    frame, reaches the one device that asked and no other, and a `viewer` device
 *    cannot ask at all: ROLE_CAPS grants it "connect" and nothing else, so it may
 *    not POST /api/fire. A feed that a tablet had to pull would therefore be a
 *    feed the one tablet lying on the table — the second screen this feature
 *    exists for — could never see. So it rides the snapshot.
 *
 *    What that costs is real and is paid in scheduleFeedPush rather than here: a
 *    chat message cannot make the snapshot smaller, so it is made rarer instead.
 *
 * 2. WHAT A MESSAGE IS, ONCE IT IS SAFE. Chat content is arbitrary HTML written
 *    by players and modules — the console's oldest hostile input. It leaves this
 *    file as text, through the same inert DOMParser the macro toasts use, and the
 *    page renders every field with textContent. Nothing published from here is
 *    ever markup, a URL or an image path, so there is nothing for the page to
 *    parse and nothing for it to fetch.
 *
 *    Rolls would be poorly served by that alone — "Atak: 17" is most of what a GM
 *    needs but not the part they argue about — so a roll travels as *numbers*:
 *    its total, its formula, and each die's individual results with the dropped
 *    ones kept apart. Numbers cannot be markup, which is what makes carrying
 *    structure here cheaper and safer than carrying Foundry's rendered dice HTML.
 *
 * 3. WHO MAY SEE IT. The broadcast reaches every paired tablet at once, including
 *    a viewer sitting face-up in front of the players, and the relay has no way to
 *    send one device a different snapshot. So the broadcast carries only what the
 *    whole table may read: a whispered or blind message becomes a stub with an id
 *    and a time and nothing else — not its author, not its target, not a total.
 *    The GM's own device gets the rest by *asking* (`!feed`), which is the
 *    `!sounds` shape and, more to the point, the shape the relay already polices:
 *    a viewer's request for it is refused two layers below this file. The page's
 *    idea of its own role decides nothing here, and never did.
 */

/**
 * Message styles worth naming on a row, by CHAT_MESSAGE_STYLES
 * (common/constants.mjs:224-247). OTHER is 0 and is left unnamed — it is most of
 * what a system posts, and a `kind` on every entry would be weight for nothing.
 */
const FEED_KINDS = { 1: "ooc", 2: "ic", 3: "emote" };

/**
 * Is this message private to somebody?
 *
 * Deliberately a property of the message rather than of the reader. The obvious
 * test, `isContentVisible`, is useless here: it answers "may *I* see this", and
 * this code only ever runs in a GM's tab, where the answer is yes to everything
 * (client/documents/chat-message.mjs:70-82). The question the broadcast has to ask
 * is "may a tablet on the table show this to the players", and that is: was it
 * whispered to anyone at all, or rolled blind.
 *
 * A whisper between two players is as private as one to the GM, so the test is
 * `whisper.length` and not "does it name a GM" — this errs shut. `blind` is the
 * other half: a blind roll is one whose result the players are not to see
 * (client/documents/chat-message.mjs:142-171 sets both from the roll mode).
 * @param {ChatMessage} message
 * @returns {boolean}
 */
function isSecretMessage(message) {
  if ( message?.blind ) return true;
  const whisper = message?.whisper;
  return Array.isArray(whisper) ? (whisper.length > 0) : !!whisper;
}

/**
 * When a message happened, or 0.
 *
 * `timestamp` is nullable with no initial value (common/documents/chat-message.mjs:
 * 50), so a message created without one falls back to the stats block Foundry puts
 * on every document, and to nothing at all after that — the row shows no time
 * rather than a confident 1970.
 * @param {ChatMessage} message
 * @returns {number}
 */
function feedTime(message) {
  for ( const stamp of [message?.timestamp, message?._stats?.createdTime] ) {
    const at = Number(stamp);
    if ( Number.isFinite(at) && (at > 0) ) return at;
  }
  return 0;
}

/**
 * Who a row is attributed to.
 *
 * ChatMessage#alias is Foundry's own answer — the token's name for an in-character
 * line, the user's for an out-of-character one (client/documents/chat-message.mjs:
 * 46-51) — so the tablet says what the sidebar says. It reaches for the speaker's
 * Actor on the way, which is a lookup that can fail in a world mid-migration, so
 * the fallback is the two fields that are on the message itself.
 * @param {ChatMessage} message
 * @returns {string}
 */
function feedWho(message) {
  try {
    return boundedString(message.alias, "", MAX_NAME);
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not read a chat message's speaker`, err);
    return boundedString(message?.speaker?.alias || message?.author?.name, "", MAX_NAME);
  }
}

/**
 * One roll, as numbers only.
 *
 * `dice` is Foundry's own flattening of every DiceTerm in the expression, including
 * the ones nested inside pools and parentheticals (client/dice/roll.mjs:158-165), so
 * a system's compound formula still yields its individual dice. `denomination` is
 * the one label that works for all of them — "d20" for a Die (client/dice/terms/
 * die.mjs:51-53), "c" for a Coin, "f" for Fate (client/dice/terms/dice.mjs:171-173).
 *
 * `active === false` is what Foundry itself strikes through on a die: dropped by a
 * keep-highest, rerolled, exploded away (client/dice/_types.mjs, DiceTermResult).
 * Those travel in their own list rather than mixed in, because "18, 4 — kept 18" and
 * "18, 4" are different rolls and the tablet must not have to guess which it has.
 * @param {Roll} roll
 * @returns {object|null}
 */
function feedRoll(roll) {
  const total = Number(roll?.total);
  const dice = [];
  for ( const term of roll?.dice ?? [] ) {
    if ( dice.length >= MAX_FEED_DICE ) break;
    const kept = [];
    const drop = [];
    for ( const result of term?.results ?? [] ) {
      if ( (kept.length + drop.length) >= MAX_FEED_RESULTS ) break;
      const value = Number(result?.result);
      if ( !Number.isFinite(value) ) continue;
      (result.active === false ? drop : kept).push(value);
    }
    if ( !kept.length && !drop.length ) continue;
    dice.push({
      die: boundedString(term.denomination, "", 8),
      kept,
      ...(drop.length ? { drop } : {})
    });
  }

  // A roll with neither a total nor a die is a roll that never evaluated. Publishing
  // it would put a confident "0" on the tablet for something nobody rolled.
  if ( !Number.isFinite(total) && !dice.length ) return null;
  return {
    ...(Number.isFinite(total) ? { total } : {}),
    // The expression as Foundry standardises it. Bounded like everything else: a
    // formula built by a macro can be as long as the macro cares to make it.
    formula: boundedString(roll?.formula, "", MAX_FEED_FORMULA),
    ...(dice.length ? { dice } : {})
  };
}

/**
 * Is this text simply Foundry's own rendering of the rolls beside it?
 *
 * A roll message's `content` is the dice template — the formula, the total and every
 * die — because that is what Roll#toMessage puts there, while a label the user typed
 * goes in `flavor` (client/dice/roll.mjs, toMessage). So on the commonest message in
 * a fight the content repeats, in prose, the numbers `rolls` already carries
 * exactly: publishing it would put "1d20 + 5 17 12 4" under a large 17 and pay for
 * it on every push.
 *
 * Recognised rather than assumed. The content is dropped only when it is the
 * rendering *of these rolls*, which is the case precisely when every one of their
 * totals appears in it. A module or a GM who whispers a sentence next to a roll
 * keeps the sentence — which is the case that matters, because that is a message
 * whose words are the point.
 *
 * "Appears in it" has to mean *as a number*. A substring test made a total of 5
 * match the 5 in "15 obrażeń", so a one-line description beside any single-digit
 * roll — and there is no commoner roll in a fight than a d6 for damage — was read
 * as Foundry's own dice template and thrown away. The digits are therefore
 * compared against the text's numbers rather than against its characters: exactly
 * the difference between "the total is written here" and "that digit occurs
 * somewhere".
 * @param {string} text     The *whole* content, not the bounded version of it: a
 *                          long dice render whose total sits past the cut would
 *                          otherwise fail this test and be published as the noise
 *                          the test exists to remove.
 * @param {object[]} rolls  As built by feedRoll.
 * @returns {boolean}
 */
function isRollRendering(text, rolls) {
  if ( !text || !rolls.length ) return false;
  // A leading minus is part of the number: a total of -2 is rendered "-2", and
  // reading that as a 2 would match the 2 in "1d20 - 2" on any roll at all.
  const numbers = new Set(text.match(/-?\d+(?:\.\d+)?/g) ?? []);
  return rolls.every(roll => (roll.total !== undefined) && numbers.has(String(roll.total)));
}

/**
 * One message, as the feed carries it.
 * @param {ChatMessage} message
 * @param {boolean} secrets  Whether private content may be included — true only for
 *                           the `!feed` answer, which reaches one device.
 * @returns {object}
 */
function feedEntry(message, secrets) {
  const id = boundedString(message?.id, "", MAX_MACRO_ID);
  const at = feedTime(message);

  // The stub. It says that the table's chat moved and when, so the feed does not
  // silently skip a beat, and it says nothing else at all — no author, no target,
  // no total, not even whether it was a roll. `secret` is what the page draws a
  // padlock on, and what the GM's own device replaces by asking.
  if ( !secrets && isSecretMessage(message) ) return { id, at, secret: true };

  const rolls = [];
  for ( const roll of message?.rolls ?? [] ) {
    if ( rolls.length >= MAX_FEED_ROLLS ) break;
    let built = null;
    try {
      built = feedRoll(roll);
    } catch ( err ) {
      // A Roll that will not describe itself — a module's own subclass mid-upgrade —
      // costs its numbers, never the message and never the push.
      console.warn(`${MODULE_ID} | could not read a roll for the feed`, err);
    }
    if ( built ) rolls.push(built);
  }

  // Both stripped to text by the same parser a macro's output goes through. The
  // flavour is the roll's label ("Atak mieczem") and is the more useful of the two
  // on a dice message, where the content is Foundry's rendered dice tooltip.
  //
  // Whole first, bounded second, and the roll-rendering test is asked about the
  // whole. A dice template puts the total at the end, past every die of every term,
  // so on a roll of any size MAX_FEED_TEXT cuts it off — and a test that cannot see
  // the total answers "this is not a rendering of these rolls" for the one thing it
  // was written to recognise. The bounded string is what gets published either way.
  const text = boundedString(plainText(message?.content), "", MAX_FEED_TEXT);
  const flavor = boundedString(plainText(message?.flavor), "", MAX_FEED_FLAVOR);
  const kind = FEED_KINDS[Number(message?.style)];

  return {
    id,
    at,
    who: feedWho(message),
    // Every one of these is absent when empty, the same rule the rest of the state
    // follows: an entry is a row on a list that is republished constantly, and an
    // empty string on each of four fields is four bytes times thirty times every
    // push.
    ...((text && !isRollRendering(spacedText(message?.content), rolls)) ? { text } : {}),
    ...(flavor ? { flavor } : {}),
    ...(kind ? { kind } : {}),
    ...(rolls.length ? { rolls } : {}),
    // Marked so a private message the GM revealed on their own device still reads as
    // private — it is on screen at a table, and "this one is not for everyone" has to
    // survive being shown.
    ...(secrets && isSecretMessage(message) ? { secret: true } : {})
  };
}

/**
 * The recent chat.
 *
 * Rebuilt from game.messages every time rather than accumulated in a ring of our
 * own, which is the same choice the audio and combat slices make and pays the same
 * way: an edit and a deletion need no bookkeeping because there is none to keep, and
 * the feed is correct after the GM reloads their tab without anything being
 * remembered across it. It also means a tablet that was not watching still gets the
 * history — the state it receives on connect is built from the world, not from what
 * this tab happened to see.
 *
 * The tail is taken in the collection's own order, never re-sorted: that is the
 * order Foundry's own log walks (client/applications/sidebar/tabs/chat.mjs:291-307),
 * and two messages a millisecond apart must not swap places between the GM's screen
 * and the tablet.
 * @param {boolean} [secrets]  Include private content. Never for the broadcast.
 * @returns {{feed: object[]}}
 */
function buildFeed(secrets = false) {
  const feed = [];
  for ( const message of (game.messages?.contents ?? []).slice(-MAX_FEED) ) {
    try {
      feed.push(feedEntry(message, secrets));
    } catch ( err ) {
      // One unreadable message must not cost the tablet its board, its scenes and
      // its encounter — they all travel in the same frame as this.
      console.warn(`${MODULE_ID} | could not read a chat message for the feed`, err);
    }
  }
  return { feed };
}

/**
 * Sort in the language actually in use (game.i18n.lang, set by
 * client/helpers/localization.mjs:223) rather than a hardcoded "pl". The fallback
 * is not paranoia about Foundry's own tags but about a translation module
 * registering a malformed one: Intl throws on those, and a throw here would take
 * down every state push.
 * @returns {Intl.Collator}
 */
function collator() {
  try {
    return new Intl.Collator(game.i18n.lang);
  } catch {
    return new Intl.Collator();
  }
}

/** The board the tablet renders, and which of the GM's boards it is. */
function buildBoard() {
  const { key, board, collection } = readActiveBoard();
  const groups = board.groups.map(g => ({
    id: g.id,
    name: g.name,
    items: g.items.map(it => {
      const macro = game.macros.get(it.macroId);
      return {
        macroId: it.macroId,
        size: it.size ?? "1x1",
        confirm: !!it.confirm,
        // Published so the tablet can build the prompt, and left absent on a tile
        // that declares none — the page tests for length, and an empty array on
        // every ordinary tile would only inflate every state frame. It is a copy
        // of the board's declaration for display; the copy that decides what runs
        // is re-read from storage in executeMacro.
        ...(it.params?.length ? { params: it.params } : {}),
        name: macro?.name ?? "(usunięte)",
        img: absoluteImage(macro?.img),
        // The tablet greys a tile out on this flag. It used to be joined by an
        // `executable` flag for macros the GM can see but no longer run; nothing
        // ever read it, and a tap on such a tile is now refused and reported by
        // executeMacro, so publishing a second unread flag bought nothing.
        missing: !macro
      };
    })
  }));

  return {
    groups,
    // Additive only. `groups` still carries the one board the tablet renders, so
    // the page keeps working untouched; these say *which* board that is, and
    // which version of it. The page echoes both back on a save and on every tap,
    // which is what lets this console tell "the board I showed you" apart from
    // "whatever happens to be in front of me now" — see saveActiveGroups and
    // executeMacro. Still information, never an instruction: nothing the tablet
    // sends can select a board, it can only fail to match the active one.
    board: { key, name: board.name, label: boardLabel(key, board), rev: boardRev(board) },
    boards: Object.entries(collection.boards).map(([k, b]) => ({
      key: k,
      label: boardLabel(k, b),
      active: k === key
    }))
  };
}

/** Every macro available to add to the board or fire from the search sheet. */
function buildLibrary() {
  const { collection } = readActiveBoard();

  // What the GM's own boards say about each macro, gathered across all of them.
  // This is what a search result inherits: the guard, and the fact that the macro
  // normally asks for something. Computed once per push, not per entry.
  const traits = macroTraits(collection);

  // canExecute, not visible: the console exists to run things, and a macro the
  // GM can see but not execute would only ever produce a failed tap. This is also
  // the whole set a search fire may name — see the long note in executeMacro.
  const library = game.macros.contents
    .filter(m => m.canExecute)
    .map(m => {
      const trait = traits.get(m.id);
      return {
        id: m.id,
        name: m.name,
        img: absoluteImage(m.img),
        // Both present only when true, for the same reason a tile omits an empty
        // `params`: most macros carry neither, and a `false` on every entry of a
        // three-hundred-macro library would inflate every state frame for nothing.
        // `asks` is deliberately a flag and not the declaration — a search result
        // is not a tile and must not look like one that could be filled in.
        ...(trait?.confirm ? { confirm: true } : {}),
        ...(trait?.asks ? { asks: true } : {})
      };
    })
    .sort((a, b) => collator().compare(a.name, b.name));

  return {
    library,
    // The GM's stars, in the order they were made. Published unpruned: an id
    // whose macro is gone, or one the GM can no longer execute, is simply not in
    // `library` and the tablet drops it when it resolves the two against each
    // other. Pruning here would mean a flag write on every state build — one for
    // every scene change and every macro edit — to fix something nobody sees.
    favorites: readFavorites()
  };
}

/**
 * Snapshot the whole console: the board, the macro library, the scenes the GM can
 * put in front of the table and the music they can work.
 *
 * Assembled from cached slices — see the note above `slices`. The arrays it hands
 * back are the cached ones, so nothing may mutate what it reads here; every
 * consumer (pushState, the module api) only serialises them.
 * @returns {object}
 */
function buildState() {
  return {
    world: game.world.title,
    user: game.user.name,
    origin: window.location.origin,
    updatedAt: Date.now(),
    ...slice("board", buildBoard),
    ...slice("library", buildLibrary),
    ...slice("scenes", buildScenes),
    // Spread, not nested, and absent when there is no encounter: `combat` in the
    // state *is* the fact that a fight is on, which is what the tablet's button
    // keys on. Its own slice because it changes on every turn while nothing else
    // does — see the note above `slices`.
    ...slice("combat", buildCombat),
    // Always an array, unlike `combat`, which is absent when there is no fight: an
    // empty feed is a real answer ("nobody has said anything") and the tablet's
    // button should exist for it, whereas an absent one means the GM's console is
    // older than this feature and the button should not.
    ...slice("feed", buildFeed),
    // Nested rather than spread flat: everything about the music is one thing the
    // page turns on or off together, and a `playlists` next to `library` at the
    // top level would read as a second macro list.
    audio: slice("audio", buildAudio)
  };
}

/* -------------------------------------------- */
/*  Chat capture                                */
/* -------------------------------------------- */

/**
 * Runs currently watching chat.
 *
 * Both hooks involved are global: `createChatMessage` fires for every client's
 * messages, and Foundry's "error" hook for every failure anywhere in the client.
 * So an observed event can only be attributed to a run when exactly one run could
 * possibly have produced it — otherwise two taps in flight would report each
 * other's output.
 * @type {Set<{isChat: boolean, messages: ChatMessage[], error: Error|null, ambiguous: boolean}>}
 */
const captures = new Set();
/** Hook ids, held only while at least one run is watching. @type {{chat: number, error: number}|null} */
let captureHooks = null;

/**
 * Start watching for output belonging to one macro run.
 * @param {boolean} isChat  Whether the macro is a chat macro (only those can raise Macro#_executeChat).
 * @returns {object}        The capture context, to be passed back to endCapture.
 */
function beginCapture(isChat) {
  const capture = { isChat, messages: [], error: null, ambiguous: false };
  captures.add(capture);
  captureHooks ??= {
    chat: Hooks.on("createChatMessage", onCapturedMessage),
    error: Hooks.on("error", onCapturedError)
  };
  return capture;
}

/** @param {object} capture */
function endCapture(capture) {
  captures.delete(capture);
  if ( captures.size || !captureHooks ) return;
  Hooks.off("createChatMessage", captureHooks.chat);
  Hooks.off("error", captureHooks.error);
  captureHooks = null;
}

/**
 * Give an observed event to the single run that must have caused it. With more
 * than one candidate there is no way to tell which did, so nobody takes it and
 * every candidate is marked so it can admit the gap instead of guessing.
 * @param {object[]} candidates
 * @param {(capture: object) => void} assign
 */
function claim(candidates, assign) {
  if ( candidates.length === 1 ) assign(candidates[0]);
  else for ( const capture of candidates ) capture.ambiguous = true;
}

/** @param {ChatMessage} message */
function onCapturedMessage(message) {
  // Every player's rolls arrive through this hook as their documents sync in.
  // Only a message this user authored can be output of a macro this tab ran.
  if ( message?.author?.id !== game.user.id ) return;
  claim([...captures], capture => capture.messages.push(message));
}

/**
 * @param {string} location  The method that caught the error.
 * @param {Error} error
 */
function onCapturedError(location, error) {
  // Macro#execute for a chat macro is
  //   ui.chat.processMessage(...).catch(err => Hooks.onError("Macro#_executeChat", err, ...))
  // (client/documents/macro.mjs:107-115), so the rejection never reaches our await
  // and the promise resolves undefined. Hooks.onError re-emits it as the "error"
  // hook (client/helpers/hooks.mjs:187) — the only place the failure is still
  // visible, and the reason a bad /roll used to flash the tile green.
  if ( location !== "Macro#_executeChat" ) return;
  claim([...captures].filter(c => c.isChat), capture => { capture.error = error; });
}

/* -------------------------------------------- */
/*  Execution + result reporting                */
/* -------------------------------------------- */

/**
 * Turn whatever a macro produced into one short human-readable line.
 * @param {unknown} result             The macro's return value.
 * @param {ChatMessage[]} messages     Messages it posted while running.
 * @returns {string}
 */
function describeOutcome(result, messages) {
  const parts = [];
  for ( const msg of messages ) {
    const rolls = msg.rolls ?? [];
    if ( rolls.length ) parts.push(rolls.map(r => r.total).join(", "));
    else {
      const text = plainText(msg.content);
      if ( text ) parts.push(text);
    }
  }
  if ( !parts.length && (result !== undefined) && (result !== null) ) {
    if ( typeof result === "object" ) {
      if ( result.total !== undefined ) parts.push(String(result.total));
      else if ( result.name ) parts.push(String(result.name));
    } else parts.push(String(result));
  }
  return parts.join(" · ").slice(0, 180);
}

/**
 * Run a macro and report the outcome back to the tablet that asked for it.
 * @param {string} reqId       The relay's request id, echoed back untouched.
 * @param {object} request     As unpacked by unpackFire.
 */
async function executeMacro(reqId, request) {
  const { macroId, args, tile, board, damaged, command, via } = request;
  // A command frame is not a run at all and shares none of what follows.
  if ( command ) return runCommand(reqId, request);
  if ( damaged ) {
    console.warn(`${MODULE_ID} | a fire request arrived with unreadable parameters`, request);
    return postResult(reqId, { ok: false, text: "Parametry nie dotarły w całości — spróbuj jeszcze raz" });
  }

  /*
   * Two ways in, and only one of them is the board.
   *
   * A paired tablet is a credential, not a trusted peer: the relay forwards
   * whatever it posted as `macroId` verbatim (relay/server.mjs, the POST
   * /api/fire handler). Handing that to game.macros.get() unchecked means a
   * stolen device token can run any script macro in the world as the GM —
   * arbitrary JS from a device. The board is the GM's own arrangement, so it is
   * also the authorisation list, and for a tap on a tile that check below is
   * untouched: same function, same locator, same refusal.
   *
   * The search sheet has no tile, so that question has no answer for it, and the
   * lazy fix — drop the check when the tablet says "this came from search" — is
   * exactly the "anything goes" that must not happen. What this console *can*
   * still verify, entirely from its own state, is four things:
   *
   *  1. The macro is one it publishes. buildState's library is
   *     game.macros.contents.filter(m => m.canExecute); the same predicate is
   *     re-evaluated below at fire time, never read from a cache and never taken
   *     from the request. canExecute is Foundry's own permission model —
   *     testUserPermission(user, "LIMITED") (client/documents/macro.mjs:40-41,
   *     63-64) — so a macro this GM may not run is refused whichever way it was
   *     asked for.
   *  2. A search fire carries no values. The only bytes a tablet sends that reach
   *     a macro *body* are the parameter scope, and the schema for that lives on
   *     a tile. With no tile there is no schema, so any args at all are refused
   *     outright rather than guessed at.
   *  3. A guard the GM attached anywhere still applies. macroTraits() gathers
   *     `confirm` across every board, and buildState publishes it on the library
   *     entry, so a macro marked dangerous on some scene's board is held-to-fire
   *     in the search sheet too. That decision is the console's, not the tablet's.
   *  4. It is logged as what it is, below, so the GM can see off-board runs.
   *
   * What this does *not* claim: it is not a narrower set than the tablet can
   * already reach. This same credential may POST /api/layout, and saveActiveGroups
   * stores whatever macro ids it sends — so a device could already put any library
   * macro on the board and then fire it, in three steps instead of one. The board
   * check's real job was never to contain a stolen token (the relay and the pairing
   * token are that boundary); it is to make the GM's arrangement the authority on
   * what a tap *means* — which parameters, which guard, which tile. Search keeps
   * every one of those properties and skips only the detour, and unlike the detour
   * it leaves the GM's board exactly as they left it.
   *
   * ...and only one board. Which board is active follows the GM's own scene, so
   * it can change between the tap and this frame — the tablet was offline and the
   * tap sat in its queue, the GM walked the party into the next room, a prompt was
   * left open on a tile that is no longer on screen. The tile the user meant is
   * then simply not here, and every answer this console could give is about some
   * other tile: another board's version of the same macro, with another board's
   * parameters and another board's lock. So the tap names the board it was made
   * against and a mismatch is refused. Said differently: the locator answers
   * "which tile", and this answers "of which board" — a locator is only meaningful
   * relative to one.
   *
   * A tap that names no board is a client older than the field. It keeps exactly
   * the behaviour it has always had: resolved against whatever is active now.
   */
  const active = readActiveBoard();
  if ( board && (board !== active.key) && (via !== "search") ) {
    console.warn(`${MODULE_ID} | refused a tap made on board "${board}" while "${active.key}" is active`);
    return postResult(reqId, {
      ok: false,
      text: `Kafelek pochodzi z innej planszy („${boardLabel(board, active.collection.boards[board])}”)`
    });
  }

  const item = (via === "search") ? null : findBoardItem(macroId, tile, active);
  if ( !item && (via !== "search") ) {
    // Two refusals, not one, because they ask two different things of the GM: a
    // locator that no longer resolves means the board moved under a tap that was
    // legitimate when it was made — a tablet to refresh, not one to suspect —
    // while a frame that named no tile at all is not a stale tap but a malformed
    // one. Nothing the tablet sends any more lacks a position, so this is either a
    // tile whose hold outlived the board it was drawn on or something that was
    // never a tap; either way the console has no idea which tile is meant, and the
    // answer that used to be given (the first tile carrying that macro, on
    // whatever board is active now) was a guess with a macro on the end of it.
    console.warn(`${MODULE_ID} | refused a fire ${tile ? "whose tile is gone" : "that named no tile"}: "${macroId}"`);
    return postResult(reqId, {
      ok: false,
      text: tile
        ? "Ten kafelek zniknął z planszy — odśwież konsolę"
        : "To dotknięcie nie wskazało kafelka — odśwież tablet i spróbuj ponownie"
    });
  }

  // A tile that declares parameters is a tile the user is asked to fill in, so a
  // tap on it always carries values — the page opens the prompt before it fires.
  // Values-free plus a declaration therefore means the two ends disagree about
  // what this tile is, and the old answer to that was to quietly run the macro on
  // the stored defaults: numbers nobody was shown, let alone chose. Refuse.
  if ( item?.params?.length && ((args === null) || (args === undefined)) ) {
    console.warn(`${MODULE_ID} | refused a values-free tap on a tile that declares parameters: "${macroId}"`);
    return postResult(reqId, { ok: false, text: "Ten kafelek prosi teraz o parametry — odśwież konsolę" });
  }

  const macro = game.macros.get(macroId);
  if ( !macro ) return postResult(reqId, { ok: false, text: "Nie ma takiego makra" });

  // Macro#execute() only warns and returns undefined when the user may not run
  // it (client/documents/macro.mjs:82-85) — it does not throw. Without this
  // check the call below "succeeds", and the tablet flashes the tile green for
  // a macro that never ran.
  if ( !macro.canExecute ) {
    return postResult(reqId, {
      ok: false,
      macro: macro.name,
      text: "Brak uprawnień do uruchomienia tego makra"
    });
  }

  // Point 2 above. applyParams would refuse these anyway — with no declaration
  // every key is an unknown one — but the message it produces names the key, as
  // though the tile had merely drifted. This one says what actually happened, and
  // says it before the macro's name has been used for anything.
  if ( (via === "search") && (args !== null) && (args !== undefined) ) {
    console.warn(`${MODULE_ID} | refused values on a search fire of "${macro.name}"`, args);
    return postResult(reqId, {
      ok: false,
      macro: macro.name,
      text: "Makro z wyszukiwarki odpala się bez parametrów — użyj kafelka"
    });
  }

  // The declaration is read back out of `item`, i.e. out of the console's own
  // stored board — never out of the request. The tablet says which values it
  // typed; it does not get to say which values the tile accepts, any more than it
  // gets to say which macros are on the board. A search fire has no item, so this
  // is `applyParams(undefined, null)`: an empty declaration, an empty scope, and
  // a call identical to the one a plain unparameterised tile has always made.
  const applied = applyParams(item?.params, args);
  if ( !applied.ok ) {
    console.warn(`${MODULE_ID} | refused parameters for "${macro.name}": ${applied.error}`, args);
    return postResult(reqId, { ok: false, macro: macro.name, text: applied.error });
  }
  const scope = applied.values;
  // What actually ran, for the console log and the tablet's toast. Empty for an
  // ordinary tile, so nothing about those lines changes.
  const shown = describeParams(item?.params, scope);
  // Point 4: an off-board run is the one thing the GM cannot see on their own
  // board, so it is the one that has to leave a trace in their own console.
  if ( via === "search" ) console.log(`${MODULE_ID} | search fire (not on the board): "${macro.name}"`);
  /** @param {string} text */
  const withParams = text => (shown ? [shown, text].filter(Boolean).join(" · ") : text);

  const isChat = macro.type === "chat";
  const capture = beginCapture(isChat);
  const started = performance.now();
  try {
    // A chat macro reads only scope.speaker (client/documents/macro.mjs:87) and
    // ignores the rest, so parameters on one are reported but never seen by the
    // command; a script macro receives each key as a variable of that name
    // (client/documents/macro.mjs:139-147). Passing {} where nothing is declared
    // is identical to the old no-argument call — execute() defaults to {} anyway.
    const result = await macro.execute(scope);
    // Macros that post asynchronously need a beat before we read the chat.
    await new Promise(r => setTimeout(r, CAPTURE_MS));
    const ms = Math.round(performance.now() - started);

    // A chat macro's failure only ever surfaces through the "error" hook; see
    // onCapturedError. Report it as the failure it is.
    if ( capture.error ) {
      return postResult(reqId, { ok: false, macro: macro.name, text: withParams(capture.error.message), ms });
    }

    let text = describeOutcome(result, capture.messages);
    if ( !text ) {
      // Nothing to show. Say which kind of nothing rather than implying a clean
      // silent success: another run was in flight and the output could not be
      // told apart, or a chat macro resolved undefined, which processMessage also
      // does when a hook cancels the message
      // (client/applications/sidebar/tabs/chat.mjs:867,883).
      if ( capture.ambiguous ) text = "Wykonane — wynik nieznany (kilka makr naraz)";
      else if ( isChat ) text = "Wysłane — wynik nieznany";
    }
    postResult(reqId, { ok: true, macro: macro.name, text: withParams(text), ms });
  } catch ( err ) {
    console.error(`${MODULE_ID} | macro "${macro.name}" failed`, err);
    ui.notifications.error(`GM Console: ${macro.name} — ${err.message}`);
    postResult(reqId, { ok: false, macro: macro.name, text: withParams(err.message) });
  } finally {
    endCapture(capture);
  }
}

/* -------------------------------------------- */
/*  Console commands                            */
/* -------------------------------------------- */

/*
 * A command is not a macro and never becomes one: no path below reaches
 * Macro#execute, and unpackFire strips the macroId off a command frame so it
 * cannot. What a command *is* is a write to something the GM already owns — a
 * flag, a Scene, a Playlist, a client setting.
 *
 * Which means the board, which is the authorisation list for a macro, has nothing
 * to say here. The equivalent question is the one Foundry itself asks, and each
 * handler asks it of the actual document, at the moment the tap arrives:
 *
 *   - Scene#activate throws for anyone who is not a GM
 *     (client/documents/scene.mjs:242), and activating is an update, so the test
 *     is game.user.isGM AND scene.canUserModify(game.user, "update").
 *   - A Playlist has no custom update permission, so canUserModify falls through
 *     to testUserPermission(user, "OWNER") (common/abstract/document.mjs:432-447).
 *     A full GM is OWNER of everything (line 416); an assistant is not.
 *   - A global volume is a client setting on this tab and belongs to whoever is
 *     sitting at it, so there is nothing to test beyond the connection itself —
 *     which is already master-token-only at the relay.
 *   - Running an encounter is Combat#update of {round, turn}, so the test is the
 *     one the tracker's own footer makes before it offers those buttons:
 *     canUserModify(user, "update", {round, turn}) (client/applications/sidebar/
 *     tabs/combat-tracker.mjs:224), plus the GM test its template makes. Ending one
 *     is a *delete*, which Combat leaves at the base "ASSISTANT"
 *     (common/abstract/document.mjs:145), so that is asked separately.
 *   - Damage and conditions are not Combat writes at all: the first is an update
 *     of the Actor and the second an ActiveEffect on it. So the document tested is
 *     the actor, which has no custom update permission and falls through to OWNER.
 *
 * And, as with a scene or a playlist, a request may only name what was published:
 * the encounter has to be the one in the state right now, and the combatant has to
 * be one of the rows that went out with it. A tap that was in flight while the GM
 * ended one fight and started another is refused rather than applied to the new one.
 *
 * The same predicates decide what is *published*, exactly as `canExecute` decides
 * what goes in `library`: a tablet can only name a document the console already
 * put in front of it, and naming one anyway is refused rather than looked up. And
 * as everywhere else, the tablet's claim about what it may do is never consulted;
 * a `viewer` device is stopped a layer earlier still, by the relay, which does not
 * grant it the "fire" capability at all (relay/server.mjs, ROLE_CAPS).
 */

/**
 * A document id as a bounded string, safe to look up *and* to put in a log line.
 *
 * boundedString already survives a value whose own toString throws — but the
 * refusal warnings below interpolate the id, and `{toString: 1}` in a template
 * literal throws from the refusal path itself. Refusing hostile input must not be
 * the thing that raises, so every id goes through here once and the result is what
 * gets both looked up and printed.
 * @param {unknown} id
 * @returns {string}
 */
function documentId(id) {
  return boundedString(id, "", MAX_MACRO_ID).trim();
}

/**
 * May this GM put this scene in front of the table?
 * @param {Scene} scene
 * @returns {boolean}
 */
function canControlScene(scene) {
  return !!scene && !!game.user?.isGM && scene.canUserModify(game.user, "update");
}

/**
 * May this GM work this playlist?
 * @param {Playlist} playlist
 * @returns {boolean}
 */
function canControlPlaylist(playlist) {
  return !!playlist && playlist.canUserModify(game.user, "update");
}

/**
 * The scene a request may name, or null — never "the scene it asked for".
 * @param {unknown} id
 * @returns {Scene|null}
 */
function requestedScene(id) {
  const scene = game.scenes?.get(documentId(id));
  return canControlScene(scene) ? scene : null;
}

/**
 * The playlist a request may name, or null.
 * @param {unknown} id
 * @returns {Playlist|null}
 */
function requestedPlaylist(id) {
  const playlist = game.playlists?.get(documentId(id));
  return canControlPlaylist(playlist) ? playlist : null;
}

/**
 * May this GM run this encounter?
 *
 * The same question the tracker's own footer asks before it offers the turn
 * controls: `canUserModify(user, "update", {round, turn})`
 * (client/applications/sidebar/tabs/combat-tracker.mjs:224). Combat overrides the
 * update permission with a test that lets a player past for those two fields alone
 * (common/documents/combat.mjs:76-84) — which is right for a player clicking "end
 * my turn" in their own browser and wrong for a device holding a credential, so
 * this console adds the GM test that the sidebar's own template adds
 * (templates/sidebar/tabs/combat/footer.hbs:5) and publishes nothing to anyone else.
 * @param {Combat} combat
 * @returns {boolean}
 */
function canControlCombat(combat) {
  return !!combat && !!game.user?.isGM && combat.canUserModify(game.user, "update", { round: 0, turn: 0 });
}

/**
 * May this GM write to this actor's sheet?
 *
 * Damage and conditions are not Combat writes at all — the first is an Actor
 * update and the second an ActiveEffect on it — so the permission that counts is
 * the actor's. Actor has no custom update permission, so canUserModify falls
 * through to testUserPermission(user, "OWNER") (common/abstract/document.mjs:
 * 432-447), which a full GM always passes (line 416).
 * @param {Actor} actor
 * @returns {boolean}
 */
function canControlActor(actor) {
  return !!actor && !!game.user?.isGM && actor.canUserModify(game.user, "update");
}

/**
 * The encounter a request may name, or null.
 *
 * Deliberately not `game.combats.get(id)`. Only the encounter this console is
 * publishing right now may be named, so a tap that was in flight while the GM
 * ended one fight and started another is refused instead of landing on the new
 * one — the same rule that keeps a fire to the tiles on the active board.
 * @param {unknown} id
 * @returns {Combat|null}
 */
function requestedCombat(id) {
  const wanted = documentId(id);
  const combat = currentCombat();
  if ( !combat || !canControlCombat(combat) || (combat.id !== wanted) ) return null;
  return combat;
}

/**
 * The combatant a request may name inside an encounter it already named, or null.
 *
 * Resolved out of the published slice of the turn order rather than out of the
 * whole collection, so what the tablet may act on is exactly what it was shown —
 * the same shape as looking a sound up inside its playlist.
 * @param {Combat} combat
 * @param {unknown} id
 * @returns {Combatant|null}
 */
function requestedCombatant(combat, id) {
  const wanted = documentId(id);
  if ( !combat || !wanted ) return null;
  const turns = (combat.turns ?? []).slice(0, MAX_COMBATANTS);
  return turns.find(c => c?.id === wanted) ?? null;
}

/**
 * Star or unstar a macro.
 * @param {object} payload
 * @returns {Promise<object>}  A result frame.
 */
async function commandFavorite(payload) {
  const macroId = documentId(payload.id);
  const macro = game.macros.get(macroId);
  // The same gate a search fire passes, for the same reason: only a macro this
  // console actually publishes may end up in a list this console publishes. It
  // also keeps the flag from filling with ids that name nothing.
  if ( !macro?.canExecute ) return { ok: false, text: "Nie ma takiego makra" };

  // Anything but an explicit false is "star it". The tablet only ever sends a
  // boolean, and the safe reading of a damaged one is the reversible direction.
  const on = payload.on !== false;
  const result = await setFavorite(macroId, on);
  if ( !result.ok ) return { ok: false, macro: macro.name, text: result.error };
  // setFlag raises updateUser, whose handler debounces a push 250 ms out. Force
  // one now instead: the star on every paired tablet is the only confirmation
  // the GM gets, and `force` covers a fingerprint that happens not to differ.
  await pushState(true);
  return { ok: true, macro: macro.name, text: on ? "Dodane do ulubionych" : "Usunięte z ulubionych" };
}

/**
 * Activate a scene — the single most disruptive thing this console can do, since
 * it moves every player's canvas and not just the GM's.
 *
 * Deliberately *only* activation, not viewing. "Look at this scene without moving
 * the table" is a thing the GM does at their own screen with the canvas in front
 * of them; a tablet across the table has no canvas to look at, so a `!view` would
 * be a button whose entire effect happens somewhere the tapper cannot see.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandScene(payload) {
  const scene = requestedScene(payload.id);
  if ( !scene ) {
    console.warn(`${MODULE_ID} | refused a scene this user may not activate: "${documentId(payload.id)}"`);
    return { ok: false, text: "Nie ma takiej sceny" };
  }
  // The name the panel used, not the document's — buildScenes publishes navName
  // when there is one, and a toast that calls the scene something else is a toast
  // about a different scene as far as the reader is concerned.
  const name = boundedString(scene.navName || scene.name, "", MAX_NAME);
  // Not an error, and not a no-op that reports success either: re-activating would
  // be a second database write and a second canvas draw for every player, to reach
  // the state everyone is already in.
  if ( scene.active ) return { ok: true, macro: name, text: "Ta scena już jest aktywna" };
  await scene.activate();
  return { ok: true, macro: name, text: "Scena aktywowana" };
}

/**
 * Start a playlist, or one track inside it.
 *
 * No fade argument, because Foundry has none to take: playAll() simply updates the
 * documents (client/documents/playlist.mjs:91-121) and the fade comes from the
 * stored field — PlaylistSound#fadeDuration reads `this.fade ?? this.parent?.fade`
 * (client/documents/playlist-sound.mjs:75-84) and _onStart fades in from silence
 * over it (line 250). So the console sets that field with `!fade` and lets
 * playback do what it already does, rather than inventing a parallel fade this
 * module would then have to keep in step with the sidebar's.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandPlay(payload) {
  const playlist = requestedPlaylist(payload.id);
  if ( !playlist ) {
    console.warn(`${MODULE_ID} | refused a playlist this user may not control: "${documentId(payload.id)}"`);
    return { ok: false, text: "Nie ma takiej playlisty" };
  }

  const soundId = documentId(payload.sound);
  if ( soundId ) {
    const sound = playlist.sounds.get(soundId);
    if ( !sound ) return { ok: false, macro: playlist.name, text: "Nie ma takiego utworu" };
    await playlist.playSound(sound);
    return { ok: true, macro: playlist.name, text: `▶ ${sound.name}` };
  }

  if ( !playlist.sounds.size ) return { ok: false, macro: playlist.name, text: "Ta playlista jest pusta" };
  // playAll() on a DISABLED playlist writes `playing: false` and starts nothing
  // (client/documents/playlist.mjs:98-100) — a soundboard is a rack of one-shots,
  // not a thing that plays. Say so instead of reporting a silent success.
  if ( playlist.mode === CONST.PLAYLIST_MODES.DISABLED ) {
    return { ok: false, macro: playlist.name, text: "To soundboard — wybierz konkretny dźwięk" };
  }
  await playlist.playAll();
  return { ok: true, macro: playlist.name, text: "▶ Gra" };
}

/**
 * Stop one playlist, or everything.
 *
 * The global stop is the reason this takes an optional id at all. It is the one
 * control at a table that has to work without reading anything first — the scene
 * ended, someone knocked, the music has to go — so it names nothing and stops
 * every playlist this GM may stop.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandStop(payload) {
  const wanted = documentId(payload.id);
  if ( wanted ) {
    const playlist = requestedPlaylist(wanted);
    if ( !playlist ) {
      console.warn(`${MODULE_ID} | refused a playlist this user may not control: "${wanted}"`);
      return { ok: false, text: "Nie ma takiej playlisty" };
    }
    await playlist.stopAll();
    return { ok: true, macro: playlist.name, text: "■ Zatrzymane" };
  }

  // Snapshot first: stopAll() updates the documents, and `playing` is derived from
  // them (client/documents/playlist.mjs:80-82), so iterating the live collection
  // while stopping would be reading a list that is changing underneath.
  const playing = (game.playlists?.contents ?? []).filter(p => p.playing && canControlPlaylist(p));
  if ( !playing.length ) return { ok: true, text: "Nic nie grało" };
  // Sequentially, not Promise.all: each is a separate database operation and
  // firing twenty at once at a busy world is how a stop button times out.
  for ( const playlist of playing ) await playlist.stopAll();
  return { ok: true, text: `■ Zatrzymano wszystko (${playing.length})` };
}

/**
 * Set a playlist's fade, in milliseconds.
 *
 * This is a stored document field, not a per-tap option, which is exactly why it
 * is worth exposing: set it once and every later play and stop of that playlist —
 * from the tablet, from the sidebar, from a macro — crossfades. The field is
 * `positive: true` (common/documents/playlist.mjs:51), so "no fade" is null and
 * never 0.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandFade(payload) {
  const playlist = requestedPlaylist(payload.id);
  if ( !playlist ) return { ok: false, text: "Nie ma takiej playlisty" };
  // typeof, not Number(): `Number(null)` is 0 and `Number("")` is 0, so a frame
  // that lost the field entirely would read as "no fade" and quietly rewrite the
  // GM's crossfade. A number is the only thing the tablet ever sends.
  const asked = payload.ms;
  if ( (typeof asked !== "number") || !Number.isFinite(asked) || (asked < 0) ) {
    return { ok: false, macro: playlist.name, text: "Zła długość przejścia" };
  }
  const ms = Math.min(Math.round(asked), MAX_FADE_MS);
  await playlist.update({ fade: ms > 0 ? ms : null });
  return { ok: true, macro: playlist.name, text: ms ? `Przejście ${(ms / 1000).toFixed(1)} s` : "Bez przejścia" };
}

/**
 * Set a volume: a global channel on this tab, or the tracks a playlist has up.
 *
 * Two different things behind one command because they are one thing to the
 * person holding the tablet ("quieter"), and because which one they mean is
 * decided by what they were touching, not by a second word to learn.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandVolume(payload) {
  // typeof, not Number(): `Number(null)` is 0, so a frame whose value did not
  // survive the trip would silence the table rather than being refused — the one
  // outcome that looks exactly like a working command.
  const value = payload.v;
  if ( (typeof value !== "number") || !Number.isFinite(value) ) return { ok: false, text: "Zła głośność" };
  const volume = alpha(value);

  const channel = boundedString(payload.ch, "", 32).trim();
  if ( channel ) {
    const setting = Object.hasOwn(VOLUME_SETTINGS, channel) ? VOLUME_SETTINGS[channel] : null;
    if ( !setting ) return { ok: false, text: "Nieznany kanał dźwięku" };
    // A client setting on this tab. No document changes, so nothing is published —
    // the frame this returns is the whole confirmation, which is the point: a
    // slider must not cost every paired tablet a full snapshot. AudioHelper's
    // volume hook does fire, but it only invalidates the audio slice, so the new
    // value rides the next push rather than causing one.
    await game.settings.set("core", setting, volume);
    return { ok: true, text: `${Math.round(volume * 100)}%`, volume, channel };
  }

  const playlist = requestedPlaylist(payload.id);
  if ( !playlist ) return { ok: false, text: "Nie ma takiej playlisty" };
  // Foundry has no per-playlist volume — volume is a PlaylistSound field
  // (common/documents/playlist-sound.mjs:50) — so "this playlist, quieter" means
  // the tracks it currently has up. That is also what keeps it cheap: one or two
  // embedded updates, never a write per track in a hundred-track playlist.
  const updates = playlist.sounds.filter(s => s.playing).map(s => ({ _id: s.id, volume }));
  if ( !updates.length ) return { ok: false, macro: playlist.name, text: "Nic tu nie gra" };
  await playlist.updateEmbeddedDocuments("PlaylistSound", updates);
  return { ok: true, macro: playlist.name, text: `${Math.round(volume * 100)}%`, volume };
}

/**
 * List one playlist's tracks, for the tablet that asked.
 *
 * The reason this is a command and not a slice of the published state: a world's
 * sounds run to the hundreds, they change almost never, and only the tablet that
 * expanded a playlist wants them. The relay routes a result back to the asking
 * device alone (relay/server.mjs, the POST /api/result handler), so this reaches
 * one screen instead of every paired one — and the broadcast keeps carrying only
 * what is playing.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandSounds(payload) {
  const playlist = requestedPlaylist(payload.id);
  if ( !playlist ) return { ok: false, text: "Nie ma takiej playlisty" };
  const sounds = [];
  for ( const sound of playlist.sounds ) {
    if ( sounds.length >= MAX_SOUNDS ) break;
    sounds.push({
      id: sound.id,
      name: boundedString(sound.name, "(bez nazwy)", MAX_NAME),
      volume: alpha(sound.volume),
      ...(sound.playing ? { playing: true } : {}),
      ...(sound.repeat ? { repeat: true } : {})
    });
  }
  // No `text`: this frame is an answer to a question, not a verdict on an action,
  // and a toast reading "18 utworów" over the list the GM is already looking at
  // would be noise. The page keys on `sounds` and consumes it silently.
  return { ok: true, id: playlist.id, sounds };
}

/* -------------------------------------------- */
/*  Combat commands                             */
/* -------------------------------------------- */

/**
 * How an encounter is named in a toast: its own title when the GM gave it one, and
 * where the fight is otherwise, because "Starcie" alone tells nobody anything.
 * @param {Combat} combat
 * @returns {string}
 */
function combatLabel(combat) {
  const name = boundedString(combat?.name, "", MAX_NAME).trim();
  return name || `Starcie · runda ${Number(combat?.round ?? 0)}`;
}

/**
 * Where the encounter stands now, for the line under the toast.
 * @param {Combat} combat
 * @returns {string}
 */
function turnLine(combat) {
  if ( !combat?.started ) return "Walka jeszcze się nie zaczęła";
  const who = boundedString(combat.combatant?.name, "", MAX_NAME);
  return `Runda ${Number(combat.round ?? 0)}${who ? ` · ${who}` : " · niczyja tura"}`;
}

/**
 * Step the encounter one turn forward or back.
 *
 * A plain tap on the tablet, with no hold. The recoverable direction argument that
 * lets the global stop be a plain tap applies here in both directions at once: the
 * undo for "next" is "previous" and vice versa, both are one tap, and both are
 * published side by side on the same row.
 *
 * Starting is folded in rather than given a command of its own, because it is what
 * "forward" means in a tracker on round 0 — but it must be Combat#startCombat and
 * not Combat#nextTurn. nextTurn on round 0 quietly becomes nextRound
 * (client/documents/combat.mjs:269), which sets the round to 1 without raising
 * `combatStart` or refreshing the effect registry (client/documents/combat.mjs:
 * 207-215) — the two things every duration-tracking system hangs off. A fight that
 * began without them is a fight whose effects never expire.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandTurn(payload) {
  const combat = requestedCombat(payload.id);
  if ( !combat ) {
    console.warn(`${MODULE_ID} | refused a turn change for an encounter that is not on the console: "${documentId(payload.id)}"`);
    return { ok: false, text: "To starcie już się nie toczy" };
  }
  // Two literals and nothing else, for the reason commandFade takes no Number():
  // a direction that did not survive the trip must be refused, not rounded towards
  // one of the two things it might have meant.
  const direction = payload.d;
  if ( (direction !== 1) && (direction !== -1) ) {
    return { ok: false, macro: combatLabel(combat), text: "Nie wiadomo, w którą stronę" };
  }

  if ( direction === 1 ) {
    if ( !combat.started ) {
      await combat.startCombat();
      return { ok: true, macro: combatLabel(combat), text: turnLine(combat) };
    }
    await combat.nextTurn();
  } else {
    // previousTurn on round 0 returns without writing anything
    // (client/documents/combat.mjs:305). Say so rather than report a step back
    // that never happened.
    if ( !combat.started ) return { ok: true, macro: combatLabel(combat), text: "Walka jeszcze się nie zaczęła" };
    await combat.previousTurn();
  }
  return { ok: true, macro: combatLabel(combat), text: turnLine(combat) };
}

/**
 * End the encounter.
 *
 * Combat#endCombat() is not called, on purpose: it is a DialogV2.confirm whose yes
 * branch is `this.delete()` (client/documents/combat.mjs:324-332). That dialog
 * opens on the GM's laptop — the screen the tablet exists so nobody has to walk
 * back to — and would leave the tap unanswered until somebody found it. So the
 * console deletes the document itself and the *tablet* asks the question, with the
 * deliberate hold, in front of the person who tapped.
 *
 * That hold is not decoration. Deleting a Combat throws away the initiative order,
 * every combatant's place in it and the round count, and no tap puts them back —
 * unlike a wrong turn, which is one tap back, and unlike damage, which is a number
 * applied the other way. This is the one control on the combat sheet where being
 * wrong costs the table a re-roll of initiative, so it is the one that is guarded.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandEndCombat(payload) {
  const combat = requestedCombat(payload.id);
  if ( !combat ) {
    console.warn(`${MODULE_ID} | refused an end for an encounter that is not on the console: "${documentId(payload.id)}"`);
    return { ok: false, text: "To starcie już się nie toczy" };
  }
  // Deleting is a different permission from updating: Combat declares none of its
  // own for it, so it falls back to the base "ASSISTANT" (common/abstract/
  // document.mjs:145), which is a role test rather than an ownership one. Asked
  // here rather than assumed from canControlCombat, which asked about `update`.
  if ( !combat.canUserModify(game.user, "delete") ) {
    return { ok: false, macro: combatLabel(combat), text: "Brak uprawnień do zakończenia starcia" };
  }
  const name = combatLabel(combat);
  await combat.delete();
  return { ok: true, macro: name, text: "Starcie zakończone" };
}

/**
 * Apply damage or healing to one combatant.
 *
 * The tablet sends a signed number and nothing else. It never names an attribute,
 * a path or a document field: which field this number touches is worked out here,
 * by readVitals, from the token's own bars — the same resolution that decided what
 * to publish in the first place. So the worst a forged payload can do is a wrong
 * amount on a combatant the console already published, and never a write to some
 * other part of the actor.
 *
 * No hold guard, and that is a decision rather than an omission. A hold exists to
 * stop a control a pocket or a sleeve could fire; this one cannot be fired that
 * way, because it takes a number that somebody has to type first, and the console
 * refuses a zero and a missing one outright. What a hold would actually buy here
 * is a pause before a *wrong number*, and a hold does not check numbers. So the
 * amount is the guard, and the deliberate gesture is spent where a stray tap really
 * would cost something nobody can give back — ending the encounter.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandHitPoints(payload) {
  const combat = requestedCombat(payload.id);
  if ( !combat ) return { ok: false, text: "To starcie już się nie toczy" };
  const combatant = requestedCombatant(combat, payload.who);
  if ( !combatant ) {
    console.warn(`${MODULE_ID} | refused a combatant that is not on the console: "${documentId(payload.who)}"`);
    return { ok: false, macro: combatLabel(combat), text: "Nie ma takiego uczestnika" };
  }
  const name = boundedString(combatant.name, "", MAX_NAME);
  const actor = combatant.actor;
  if ( !canControlActor(actor) ) return { ok: false, macro: name, text: "Nie możesz zmieniać tej postaci" };

  const vitals = readVitals(combat, combatant);
  // The same answer the state gave, re-derived now: a system that shows nothing on
  // the tablet must also refuse to be written through it.
  if ( !vitals ) return { ok: false, macro: name, text: "Ten system nie pokazuje tu punktów życia" };
  if ( !vitals.editable ) return { ok: false, macro: name, text: "Tego pola nie da się stąd zmienić" };

  // typeof, not Number(): `Number(null)` is 0 and a zero is refused below, so a
  // frame that lost its value would be refused either way — but this says which.
  const asked = payload.d;
  if ( (typeof asked !== "number") || !Number.isFinite(asked) ) {
    return { ok: false, macro: name, text: "Zła wartość" };
  }
  const delta = Math.trunc(Math.min(Math.max(asked, -MAX_HP_DELTA), MAX_HP_DELTA));
  if ( !delta ) return { ok: false, macro: name, text: "Podaj ile" };

  // Foundry's own generic path, and the one a system overrides when it has rules
  // of its own about taking damage — temporary hit points, damage reduction, an
  // automatic "dead" status. Core clamps a bar to [0, max] and fires a cancellable
  // `modifyTokenAttribute` hook on the way (client/documents/actor.mjs:414-427).
  await actor.modifyTokenAttribute(vitals.attribute, delta, true, vitals.type === "bar");

  // Read back rather than compute: whatever the system did to the number is the
  // number the GM needs to see, and a clamp or a rule of its own is exactly the
  // case where our arithmetic would be wrong.
  const after = readVitals(combat, combatant) ?? vitals;
  const total = (after.max !== null) ? `${after.value}/${after.max}` : `${after.value}`;
  return { ok: true, macro: name, text: `${delta > 0 ? "+" : ""}${delta} → ${total}` };
}

/**
 * Put a condition on a combatant, or take it off.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandCondition(payload) {
  const combat = requestedCombat(payload.id);
  if ( !combat ) return { ok: false, text: "To starcie już się nie toczy" };
  const combatant = requestedCombatant(combat, payload.who);
  if ( !combatant ) return { ok: false, macro: combatLabel(combat), text: "Nie ma takiego uczestnika" };
  const name = boundedString(combatant.name, "", MAX_NAME);
  const actor = combatant.actor;
  if ( !canControlActor(actor) ) return { ok: false, macro: name, text: "Nie możesz zmieniać tej postaci" };

  // Matched by scanning the catalogue, never by indexing it — see statusCatalogue.
  // Actor#toggleStatusEffect throws on an id it does not know
  // (client/documents/actor.mjs:554), and refusing hostile input must not be the
  // thing that raises.
  const wanted = documentId(payload.status);
  const status = statusCatalogue().find(s => (s.id === wanted) && offersStatus(s, actor));
  if ( !status ) {
    console.warn(`${MODULE_ID} | refused an unknown status effect: "${wanted}"`);
    return { ok: false, macro: name, text: "Nie ma takiego stanu" };
  }

  // Anything but an explicit false means "put it on", exactly as a star does: the
  // tablet only ever sends a boolean, and the safe reading of a damaged one is the
  // direction that is one more tap to undo.
  const on = payload.on !== false;
  await actor.toggleStatusEffect(status.id, { active: on });
  return { ok: true, macro: name, text: `${statusLabel(status)} — ${on ? "nałożone" : "zdjęte"}` };
}

/**
 * List the conditions this world offers, for the tablet that asked.
 *
 * A command and not a slice of the state, for the reason `!sounds` is: the
 * catalogue is a world-level constant of a few dozen entries that changes
 * essentially never, only the device that opened a combatant wants it, and the
 * combat slice is the one thing here republished on every single turn. What the
 * broadcast does carry is which conditions are actually on — a handful of ids per
 * row — so the sheet marks a fetched catalogue against live state rather than
 * against the answer it happened to get.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandConditions(payload) {
  const combat = requestedCombat(payload.id);
  if ( !combat ) return { ok: false, text: "To starcie już się nie toczy" };
  const combatant = requestedCombatant(combat, payload.who);
  if ( !combatant ) return { ok: false, text: "Nie ma takiego uczestnika" };
  const actor = combatant.actor;

  const conds = [];
  for ( const status of statusCatalogue() ) {
    if ( conds.length >= MAX_CONDITION_LIST ) break;
    if ( !offersStatus(status, actor) ) continue;
    conds.push({
      id: boundedString(status.id, "", MAX_NAME),
      name: statusLabel(status) || boundedString(status.id, "", MAX_NAME)
    });
  }
  conds.sort((a, b) => collator().compare(a.name, b.name));
  // No `text`, for the same reason a track listing carries none: this answers a
  // question the sheet asked and is not a verdict on anything.
  return { ok: true, id: combat.id, who: combatant.id, conds };
}

/* -------------------------------------------- */
/*  Chat feed command                           */
/* -------------------------------------------- */

/**
 * The recent chat with the private messages filled in, for the tablet that asked.
 *
 * The one command here whose authorisation is not a question about a document,
 * because there is no document to ask about: "may this device read a whisper" is a
 * question about the *device*, and the console cannot see devices at all — the
 * relay does not tell it which one sent a frame, on purpose.
 *
 * So this leans on the boundary that already exists rather than inventing a second
 * one. A `viewer` is granted "connect" and nothing else (relay/server.mjs,
 * ROLE_CAPS), so its POST /api/fire is refused with a 403 before any of this runs
 * and no fire frame is ever emitted; a `console` device is the GM's own, the one
 * already trusted to run arbitrary board macros and rewrite the board. That is the
 * same split every other command relies on, and it is enforced two layers below
 * this file rather than by anything the page claims about itself.
 *
 * What this adds on top is that the answer goes to one screen: the relay routes a
 * result by the waiting device's token (relay/server.mjs, the POST /api/result
 * handler), so a whisper fetched by the GM's tablet does not reach the one lying
 * face-up on the table — which is the whole reason the broadcast could not carry it.
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function commandFeed(payload) {
  // Belt and braces, and cheap. Every other path into this module is already
  // GM-only — the connection needs the master token and ready() returns early for
  // anyone else — but this is the one handler whose whole job is to hand over
  // things a non-GM must not have, so it says so itself.
  if ( !game.user?.isGM ) return { ok: false, text: "Tylko MG może czytać ukryte wiadomości" };
  // No `text`: this answers a question the sheet asked and is not a verdict on an
  // action, exactly as a track listing and a condition catalogue are not.
  return { ok: true, feed: buildFeed(true).feed };
}

/**
 * Every console command, by name. A table rather than a chain so that adding one
 * is adding one line here plus a handler, and so an unknown name is refused in
 * exactly one place.
 * @type {Record<string, (payload: object) => Promise<object>>}
 */
const COMMANDS = {
  fav: commandFavorite,
  scene: commandScene,
  play: commandPlay,
  stop: commandStop,
  fade: commandFade,
  vol: commandVolume,
  sounds: commandSounds,
  turn: commandTurn,
  endcombat: commandEndCombat,
  hp: commandHitPoints,
  cond: commandCondition,
  conds: commandConditions,
  feed: commandFeed
};

/**
 * Handle a `fire` frame that is an instruction to the console rather than a macro.
 *
 * Nothing here runs anything, and nothing here reaches game.macros.execute. It is
 * answered on the ordinary result channel so the tablet gets the same round trip,
 * the same latency figure and the same toast it gets for a run.
 * @param {string} reqId
 * @param {object} request  As unpacked by unpackFire.
 */
async function runCommand(reqId, { command, payload, damaged }) {
  // Same rule as a damaged parameter tail: a command whose payload did not
  // survive the trip must fail rather than fall through to a default, since the
  // default for "star this" would be starring the wrong thing — and the default
  // for "stop this playlist" would be stopping every one of them.
  if ( damaged ) {
    console.warn(`${MODULE_ID} | a console command arrived unreadable`, command);
    return postResult(reqId, { ok: false, text: "Polecenie nie dotarło w całości" });
  }
  // Object.hasOwn, not a bare lookup: "constructor" and "toString" are names too,
  // and a frame naming one must be an unknown command rather than a call into
  // Object.prototype.
  if ( !Object.hasOwn(COMMANDS, command) ) {
    console.warn(`${MODULE_ID} | refused an unknown console command: "${command}"`);
    return postResult(reqId, { ok: false, text: "Nieznane polecenie konsoli" });
  }

  try {
    postResult(reqId, await COMMANDS[command](payload));
  } catch ( err ) {
    // Everything a handler touches can reject for reasons that are Foundry's and
    // not the tablet's — a database write refused, a scene mid-migration. The
    // tablet gets the message rather than a silence it would time out on.
    console.error(`${MODULE_ID} | console command "${command}" failed`, err);
    postResult(reqId, { ok: false, text: err.message });
  }
}

/**
 * @param {string} reqId    Echoed back exactly as received: request ids belong to
 *                          the relay, which routes the answer by them. Nothing
 *                          here mints or reinterprets one.
 * @param {object} payload
 */
async function postResult(reqId, payload) {
  const cfg = config();
  if ( !cfg ) return;
  try {
    const res = await fetch(`${cfg.base}/api/result?token=${encodeURIComponent(cfg.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reqId, ...payload })
    });
    // fetch rejects only on a network failure, so a 401/403 arrives here as a
    // perfectly resolved promise and the tablet would sit waiting in silence.
    if ( !res.ok ) throw new Error(`relay said ${res.status}`);
  } catch ( err ) {
    console.warn(`${MODULE_ID} | could not report result`, err);
  }
}

/* -------------------------------------------- */
/*  Relay transport                             */
/* -------------------------------------------- */

/**
 * Read connection config, returning null when the link is not usable.
 * @returns {{base: string, token: string}|null}
 */
export function config() {
  if ( !game.settings.get(MODULE_ID, "enabled") ) return null;
  const base = game.settings.get(MODULE_ID, "relayUrl").trim().replace(/\/+$/, "");
  const token = game.settings.get(MODULE_ID, "token").trim();
  // No token means "not paired yet", not "a credential worth trying". Connecting
  // with an empty one earns a 401 the moment the GM types the relay URL, which
  // latches authRejected and leaves a permanent red "your token was rejected"
  // toast on screen before any token has ever existed — and blocks reconnecting
  // once one does. The pairing window reads the settings itself precisely so it
  // still works while this returns null.
  if ( !base || !token ) return null;
  return { base, token };
}

/**
 * Why the link is not up, or "" when it is up or deliberately off.
 *
 * Three settings and all three are `scope: "client"`, which is the right scope —
 * a relay address and a device token belong to the browser sitting in front of the
 * GM, not to the world — but it means a *new browser or profile is a new setup*,
 * with the same world, the same boards and the same paired tablets behind it. That
 * state used to be completely silent: `config()` returned null because there is no
 * URL, and "needs pairing" was false for exactly the same reason, so nothing
 * connected, nothing was published and nothing said so. Meanwhile the relay still
 * holds the last snapshot some other browser pushed, so the tablet goes on drawing
 * a live-looking console of a session nobody is publishing to.
 * @returns {""|"unconfigured"|"unpaired"}
 */
function linkState() {
  // Off on purpose is not a problem to report. The GM unticked it.
  if ( !game.settings.get(MODULE_ID, "enabled") ) return "";
  if ( !game.settings.get(MODULE_ID, "relayUrl").trim() ) return "unconfigured";
  if ( !game.settings.get(MODULE_ID, "token").trim() ) return "unpaired";
  return "";
}

/**
 * The last state announceLink() spoke about, so it speaks once per state and not
 * once per call. `null` rather than "" so the first call always announces,
 * including the first call in a session that is already fine — which announces
 * nothing, and latches that.
 * @type {string|null}
 */
let announcedLink = null;

/**
 * Say once, on the GM's own screen, that this browser is not publishing.
 *
 * Called from reconnect(), which is every settings change plus `ready` — so the
 * notice appears when the tab opens unconfigured, appears again if the GM clears
 * the URL later, and does not repeat while nothing has changed. The alternative
 * shapes were both wrong: a notice per reconnect nags on every keystroke-driven
 * onChange, and a notice only on `ready` misses the GM who empties the field.
 */
function announceLink() {
  const state = linkState();
  if ( state === announcedLink ) return;
  announcedLink = state;
  if ( state === "unpaired" ) ui.notifications.info(game.i18n.localize("GMCONSOLE.Notify.NoToken"));
  else if ( state === "unconfigured" ) {
    // Not localised through lang/: this string is new and the language files are
    // not this module's to extend from here. Same Polish as every other message
    // the console writes to the GM.
    ui.notifications.warn("GM Console: ta przeglądarka nie ma ustawionego adresu relaya, więc nic tu nie jest"
      + " publikowane — tablet może nadal pokazywać starą zawartość. Ustawienia są osobne dla każdej"
      + " przeglądarki: wpisz adres relaya w ustawieniach modułu.");
  }
}

/**
 * Rebuild the named slices and publish, once, 250 ms from now.
 *
 * The invalidation happens immediately and the push is debounced, which is the
 * only order that works: one Playlist#playAll raises several document hooks, and
 * a slice invalidated after the push had already been coalesced away would sit
 * stale until something unrelated moved.
 * @param {...string} names  Slices that may have changed. None means "all of them",
 *                           which is what a caller with no idea should say.
 */
function schedulePush(...names) {
  if ( names.length ) invalidate(...names);
  else slices.clear();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushState(), 250);
}

/**
 * Coalescing window for chat, in milliseconds.
 *
 * Chat gets a scheduler of its own because it is the only slice whose source can
 * fire twenty times inside one combat round, and because of what a push costs: the
 * relay keeps one snapshot and replaces it (relay/server.mjs, the POST /api/state
 * handler), so a message worth a hundred and fifty bytes re-sends the board, the
 * library, the scenes and the encounter with it. Nothing in this module can make
 * that frame smaller — only rarer.
 *
 * 1.2 s is chosen against how the feed is read rather than against the wire: it is
 * a second screen someone glances at, so a roll landing "within about a second" is
 * indistinguishable from instant, while an area-of-effect macro posting a dozen
 * messages must cost one frame and not a dozen. The ordinary 250 ms debounce would
 * still be five frames for that burst.
 */
const FEED_PUSH_MS = 1200;
let feedTimer = null;
/**
 * When the last chat-driven push went out, so a lull is not made to wait. On the
 * monotonic clock — see monotonicNow.
 *
 * Starts at minus infinity, i.e. "never", which is the only value that means what
 * a zero used to. A zero was "long enough ago" only because it was being compared
 * against the wall clock, where it stands for 1970; against a clock whose origin is
 * the moment this tab opened it stands for *now*, and the first message of the
 * session would have been held back by the whole window for no reason.
 */
let feedPushedAt = -Infinity;

/**
 * A clock that only ever moves forwards.
 *
 * `Date.now()` does not: it is the wall clock, and an NTP correction, a VM resume
 * or a GM fixing their system time steps it in either direction. A backward step
 * makes the difference below come out larger than any real interval, so the feed's
 * window computed a wait of up to that whole step — and `if ( feedTimer ) return`
 * meant every message arriving during it rode a frame that was minutes away. The
 * chat feed simply stopped. `performance.now()` is monotonic by specification and
 * is what this kind of interval wants; the fallback is for a Node harness old
 * enough not to expose it, where the wall clock is all there is anyway.
 * @returns {number}  Milliseconds since some fixed, unspecified point.
 */
function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Publish the chat feed, at most once per FEED_PUSH_MS.
 *
 * Leading edge after a quiet spell, trailing edge during a burst: the first message
 * after nothing goes out immediately (the wait computes to zero), and everything
 * that arrives while the window is open rides one frame at the end of it. So a busy
 * round costs a bounded number of frames per second no matter how loud it gets,
 * which is the property that matters — the alternative is a console whose bandwidth
 * is decided by how many dice the players pick up.
 *
 * The invalidation happens now and the push happens later, which is the only order
 * that works — see schedulePush. Nothing else is invalidated: the board, the
 * library, the scenes and the encounter are cached slices and are re-serialised but
 * never rebuilt, and none of them can have changed because a message was posted.
 */
function scheduleFeedPush() {
  invalidate("feed");
  // A frame is already booked; this message rides it rather than booking a second.
  if ( feedTimer ) return;
  feedTimer = setTimeout(() => {
    feedTimer = null;
    feedPushedAt = monotonicNow();
    pushState();
  }, Math.max(0, FEED_PUSH_MS - (monotonicNow() - feedPushedAt)));
}

/**
 * A fresh publishing-session id.
 *
 * Time plus randomness rather than a counter: a counter would restart at the same
 * value every time the tab reloads, which is precisely the case `gen` exists to
 * tell apart. randomID is Foundry's own, with a fallback because this is evaluated
 * while the module is still loading.
 * @returns {string}
 */
function newPushGen() {
  const random = globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${random}`;
}

/**
 * Did the relay say it stored this push?
 *
 * A whitelist, not a blacklist, and that is the whole design. This used to name
 * the refusals it knew — `accepted: false`, `superseded: true`, the word
 * "superseded" in the body — and read everything else as success, so the relay
 * could only ever be *added to* in one direction: a refusal it learned to express
 * some new way ("a different GM owns this session") arrived here as an answer
 * matching none of the known refusals, and the console recorded the push as
 * stored. It then never sent that state again, and the tablet held a console that
 * had been rejected. Refusing something the relay actually accepted costs one
 * redundant push; accepting something it refused costs the session.
 *
 * So only these are acceptance:
 *  - `accepted: true`, the contract (relay/server.mjs answers this on 200), or
 *  - a 2xx with no `accepted` field at all *and* nothing that looks like a
 *    refusal, which is the relay that predates the contract and answers a bare
 *    `{ok: true}` or an empty body. That tolerance is deliberate — the module and
 *    the relay are versioned separately and a GM will run one of each across an
 *    upgrade — but it is the only tolerance, and any newer relay says `accepted`.
 *
 * Everything else, including a shape nobody here has seen, is a refusal.
 * @param {number} status   HTTP status.
 * @param {string} answer   The response body, as text.
 * @returns {boolean}
 */
function pushAccepted(status, answer) {
  // 409 is the natural status for "a newer state already won", whatever the body
  // says; anything outside 2xx was never a stored state either.
  if ( (status < 200) || (status > 299) ) return false;

  const text = String(answer ?? "").trim();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // A pre-contract relay's non-JSON answer. Exactly two forms are known to have
    // meant success, and an unrecognised sentence is not read as one of them.
    return !text || /^ok$/i.test(text);
  }

  // The contract. Present but not literally `true` — false, "no", a reason string,
  // an object describing who won — is a refusal, and so is a body that is not a
  // plain object: a bare scalar carries no verdict, and an array of them says
  // nothing about which one this push got.
  if ( !body || (typeof body !== "object") || Array.isArray(body) ) return false;
  if ( "accepted" in body ) return body.accepted === true;

  // No `accepted`: a relay older than the contract. Take `ok: true` (or an answer
  // with no verdict in it) and refuse anything carrying a refusal-shaped field,
  // whatever its vocabulary — this is the branch a newer relay never reaches.
  if ( ("superseded" in body) || ("error" in body) || ("refused" in body) ) return false;
  if ( "status" in body ) return body.status === "ok";
  return body.ok !== false;
}

/**
 * Why the relay would not store a push, in its own words.
 *
 * Two reasons mean two different things and only one of them is a problem:
 * `superseded` says a newer snapshot of *ours* got there first, which is the queue
 * working; `not-publisher` says another GM tab holds the publishing post
 * (relay/server.mjs, electPublisher) and will hold it for as long as its stream is
 * open, so nothing this tab sends can land until the post changes hands. Read for
 * the log only — the verdict is pushAccepted's, and an answer this cannot parse is
 * still a refusal there.
 * @param {string} answer
 * @returns {{reason: string, publisher: string}}
 */
function pushRefusal(answer) {
  let body;
  try {
    body = JSON.parse(String(answer ?? ""));
  } catch {
    body = null;
  }
  return {
    reason: (typeof body?.error === "string") ? body.error.slice(0, 40) : "unknown",
    publisher: (typeof body?.publisher === "string") ? body.publisher.slice(0, 40) : ""
  };
}

/**
 * The refusal this tab has already reported, so a second window does not write a
 * line per push for as long as it is open. Reset the moment a push is accepted.
 * @type {string}
 */
let lastRefusal = "";

/**
 * Publish the console to the relay, one push at a time.
 *
 * The queue is the point. Pushes are raised by three independent schedulers and
 * the relay stores whichever body it finishes reading last, so overlapping them
 * put the console's idea of what the tablets hold out of step with what they
 * actually held — see `pushChain`. Serialising also makes `seq` mean what it says:
 * the bodies leave in the order they were built.
 *
 * The state is built when this push's turn comes rather than when it was asked
 * for, so a push that waited publishes the world as it is now and not as it was
 * when something queued it.
 * @param {boolean} [force]  Send even when nothing changed.
 * @returns {Promise<void>}  Settles when *this* push has been answered.
 */
export async function pushState(force = false) {
  const run = pushChain.then(() => sendState(force), () => sendState(force));
  // The chain must not be a promise anybody can reject: one failed push would
  // otherwise reject every push queued behind it, which is the opposite of what a
  // retry queue is for.
  pushChain = run.then(() => {}, () => {});
  return run;
}

/**
 * One push. Only ever called from the queue in pushState.
 * @param {boolean} force
 * @returns {Promise<void>}
 */
async function sendState(force) {
  const cfg = config();
  if ( !cfg ) return;
  // A forced push is one of four rare things — the stream came up, the relay asked
  // for a resync, a layout was saved, a star was toggled — and every one of them
  // means "I am not sure what the tablet has". Rebuild the lot: the cost is one
  // walk of the boards and macros at moments that already involve a round trip,
  // and the alternative is every future caller of pushState(true) having to
  // remember which slice it invalidated.
  if ( force ) slices.clear();
  const state = buildState();
  // updatedAt always differs, so compare everything else. Computed before `seq` and
  // `gen` go on: those change on every push by design and would make every
  // fingerprint unique, which is the comparison this exists to make possible.
  const fingerprint = JSON.stringify({ ...state, updatedAt: 0 });
  if ( !force && (fingerprint === lastPayload) ) return;
  const body = JSON.stringify({ ...state, seq: ++pushSeq, gen: pushGen });

  try {
    const res = await fetch(`${cfg.base}/api/state?token=${encodeURIComponent(cfg.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    // 409 is an answer, not a transport failure: it says a newer state won.
    if ( !res.ok && (res.status !== 409) ) throw new Error(`relay said ${res.status}`);
    const answer = await res.text().catch(() => "");
    if ( !pushAccepted(res.status, answer) ) {
      // The relay is holding something other than this. Forget the fingerprint so
      // the next push actually goes out instead of matching a state that was
      // never stored — the exact wedge this whole mechanism exists to prevent.
      lastPayload = "";
      // Said once per refusal, not once per push. `not-publisher` lasts as long as
      // the other tab's stream does, so a line per push would be a console full of
      // one fact. There is no retry here and deliberately so: the next attempt is
      // whatever changes the world next, and the handover itself always arrives as
      // a `sync` — the relay asks every GM for a snapshot whenever a GM stream
      // opens or closes, which is the only moment the post can move.
      const { reason, publisher } = pushRefusal(answer);
      const mark = `${reason}/${publisher}`;
      if ( mark !== lastRefusal ) {
        lastRefusal = mark;
        console.warn(`${MODULE_ID} | the relay refused a state push (seq ${pushSeq}, ${reason})`
          + (publisher ? ` — session "${publisher}" is publishing` : ""));
      }
      return;
    }
    lastRefusal = "";
    // Recorded only now, and only for a push the relay confirmed. Assigning it
    // before the request meant a 401 poisoned the fingerprint: the relay never got
    // this state, yet every later identical push matched and returned early, so the
    // tablet's board froze for good with nothing in the log to say why.
    lastPayload = fingerprint;
  } catch ( err ) {
    console.warn(`${MODULE_ID} | failed to push state`, err);
    lastPayload = "";
  }
}

/** Close and forget the live stream. The only place `stream` is ever cleared. */
function closeStream() {
  if ( !stream ) return;
  stream.close();
  stream = null;
}

export function disconnect() {
  // Bump first: any async continuation already past its own await is now stale
  // and will abort instead of resurrecting the connection behind our back.
  epoch++;
  clearTimeout(retryTimer);
  retryTimer = null;
  closeStream();
}

export function reconnect() {
  if ( !game.user?.isGM ) return;
  disconnect();
  retryDelay = 2000;
  lastPayload = "";
  // A new publishing session. The relay may be a different process than the one
  // that saw the last `seq` — the usual reason to reconnect deliberately is that
  // the GM pointed the module at another relay or rotated the token — and under a
  // `gen` it has never seen it accepts whatever arrives, so the first push after
  // this always lands. The counter itself is left alone: it only has to rise.
  pushGen = newPushGen();
  // A deliberate reconnect means the GM changed something (usually the token in
  // the pairing window), so give a previously rejected credential a fresh start.
  authRejected = false;
  announceLink();
  connect();
}

function connect() {
  const cfg = config();
  if ( !cfg ) return;
  if ( authRejected ) return;

  // Never assign over a live stream: two EventSources both receive every 'fire'
  // and one tap runs the macro twice. Callers are expected to have disconnected
  // already; this makes that not matter.
  closeStream();
  const generation = ++epoch;

  // `gen` names this publishing session on the stream itself. Additive — a relay
  // that does not read it is unaffected — and it is what lets the relay pin the
  // publishing post to the same stream it picks for `fire`, rather than electing
  // the two independently. Safe to read here: pushGen is minted at load and again
  // in reconnect(), both before this line, and never between two pushes.
  const es = new EventSource(`${cfg.base}/api/events?role=gm&token=${encodeURIComponent(cfg.token)}`
    + `&gen=${encodeURIComponent(pushGen)}`);
  stream = es;

  es.addEventListener("open", () => {
    retryDelay = 2000;
    // A stream that actually opened proves this credential is good. Clear the
    // latch: during a token rotation the relay drops the old GM streams *before*
    // it answers the rotate, so a 401 for the dead token can still be in flight
    // while this healthy one comes up, and latching it would kill the link until
    // a reload. The epoch check in verifyThenRetry is the primary guard; this is
    // the one that also covers a latch set from any other direction.
    authRejected = false;
    console.log(`${MODULE_ID} | connected to ${cfg.base}`);
    pushState(true);
  });

  es.addEventListener("fire", event => {
    const data = parse(event);
    if ( data ) executeMacro(String(data.reqId), unpackFire(data));
  });

  // Latency probe: answer immediately, run nothing.
  es.addEventListener("probe", event => {
    const data = parse(event);
    if ( data ) postResult(String(data.reqId), { ok: true, probe: true });
  });

  es.addEventListener("layout", event => {
    const data = parse(event);
    // Report instead of swallowing: a rejected layout means the tablet's save
    // silently did nothing, and the GM is the only one who can see why.
    const reqId = String(data?.reqId ?? "");
    saveLayout(reqId, data?.groups, data?.board).catch(err => {
      console.error(`${MODULE_ID} | rejected a layout from the relay`, err);
      ui.notifications.warn(game.i18n.localize("GMCONSOLE.Notify.LayoutRejected"));
      // The tablet is holding the only copy of this edit and has to be told the
      // save did not happen, or it will drop it as saved when its ack times out.
      if ( reqId ) postResult(reqId, { ok: false, text: "Układ odrzucony przez konsolę" });
    });
  });

  es.addEventListener("sync", () => pushState(true));

  es.addEventListener("devices", event => {
    const data = parse(event);
    if ( data ) Hooks.callAll("gmConsoleDevices", data.devices ?? []);
  });

  es.addEventListener("error", () => {
    // A stream that has already been superseded must not restart anything.
    if ( stream !== es ) return;
    closeStream();
    clearTimeout(retryTimer);
    verifyThenRetry(generation);
  });
}

/**
 * An SSE error event carries no status, so a rotated token and a flaky network
 * look identical and the loop would retry forever in silence. Probe /api/ping —
 * the same thing the tablet page does — and give up loudly when the credential
 * is the problem, since no amount of retrying will fix that.
 * @param {number} generation  The connection epoch this check belongs to.
 */
async function verifyThenRetry(generation) {
  const cfg = config();
  if ( !cfg ) return;
  try {
    const res = await fetch(`${cfg.base}/api/ping?token=${encodeURIComponent(cfg.token)}`, { cache: "no-store" });
    // Everything below acts on a snapshot of the world taken before the await.
    // If the credential changed meanwhile — the usual case, because rotation
    // kills this stream and only then hands over the new token — this answer is
    // about the *old* one and both the retry and the abandon would be wrong.
    if ( generation !== epoch ) return;
    // 401: the relay does not know this token at all — reset, or rotated elsewhere.
    if ( res.status === 401 ) return abandon("GMCONSOLE.Notify.TokenRejected");
    if ( res.ok ) {
      // A device token pings fine but is refused the gm role, so the stream can
      // never open. Same dead end, different cause.
      const { level } = await res.json().catch(() => ({}));
      if ( generation !== epoch ) return;
      if ( level && (level !== "master") ) return abandon("GMCONSOLE.Notify.NotMaster");
    }
  } catch {
    // Relay unreachable — a transient outage. Keep retrying, keep quiet.
  }
  if ( generation !== epoch ) return;
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

/**
 * Stop reconnecting and tell the GM once. Cleared by reconnect().
 * @param {string} messageKey  Localization key explaining what went wrong.
 */
function abandon(messageKey) {
  if ( authRejected ) return;
  authRejected = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  const message = game.i18n.localize(messageKey);
  console.warn(`${MODULE_ID} | ${message}`);
  ui.notifications.error(message, { permanent: true });
}

function parse(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

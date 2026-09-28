// Wire protocol shared by the client and the server.
//
// Both sides import this file, which is the only reliable way to keep a
// hand-rolled protocol honest: a message name can never be misspelled on one
// side only, because there is exactly one spelling of it.
//
// Transport is JSON over a WebSocket. That is not the most compact option, but
// snapshots are already trimmed to short keys and rounded numbers in gamesim.js,
// and a co-op shooter with a handful of players is nowhere near the bandwidth
// where a binary format would start to pay for its complexity.

/**
 * Match modes. A room is one or the other for its whole life: switching
 * mid-match would mean respawning everyone into a different rule set, so the
 * lobby is where the choice belongs. A joining client is told which it got
 * rather than asking for one -- the room was created by whoever hosted it.
 */
export const MODE = {
  COOP: 'coop',           // shared waves, one pot, revives
  FFA: 'ffa',             // no monsters; everyone shoots everyone
};

export function normalizeMode(mode) {
  return mode === MODE.FFA ? MODE.FFA : MODE.COOP;
}

/**
 * Who can find a room.
 *
 * Public rooms are listed for anyone on the server and joined with a click;
 * private ones are reachable only by someone who was told the six-character code.
 * Hosting is private by default. A host has to make the separate, visible
 * choice to publish their display name and room code in the lobby browser.
 */
export const VISIBILITY = {
  PUBLIC: 'public',
  PRIVATE: 'private',
};

export function normalizeVisibility(v) {
  return v === VISIBILITY.PUBLIC ? VISIBILITY.PUBLIC : VISIBILITY.PRIVATE;
}

/**
 * How often a playing client checks in with the presence counter.
 *
 * Lives here rather than in the presence module because both halves have to
 * agree on it: the client sends at this rate and the server's TTL is a multiple
 * of it, so a value edited on one side only would either drop live players from
 * the count or hold departed ones in it.
 */
export const BEAT_SECONDS = 20;

/** Kills that win a free-for-all. */
export const FFA_KILL_TARGET = 20;
/** Seconds a dead player sits out before dropping back in. */
export const FFA_RESPAWN = 4;
/** Seconds the winner is shown before the room resets for another round. */
export const FFA_POST_MATCH = 12;

/** Client -> server. */
export const C2S = {
  JOIN: 'join',           // { room, name, mode, visibility, cid } -- mode/visibility: host only
  STATE: 'state',         // { pos, yaw, pitch, health, alive, weapon, moving }
  DAMAGE: 'damage',       // { id, amount, headshot }
  HIT_PLAYER: 'hitp',     // { id, amount, headshot } -- FFA only
  EXPLOSION: 'explosion', // { x, y, z, radius, damage }
  DOWN: 'down',           // {}  -- "my health hit zero"
  CHAT: 'chat',           // { text }
  READY: 'ready',         // { ready }
  PING: 'ping',           // { t }
  BUY: 'buy',             // { item, cost }
  SNAP: 'snap',           // {}  -- the five-stone wave wipe
  VENDING: 'vending',     // {}  -- request the one-shot banana-machine event
};

/** Server -> client. */
export const S2C = {
  WELCOME: 'welcome',     // { id, room, seed, host, mode, state }
  SNAPSHOT: 'snap',       // { s: <sim snapshot>, e: [events], t }
  PLAYER_JOIN: 'pjoin',   // { id, name }
  PLAYER_LEAVE: 'pleave', // { id, name }
  CHAT: 'chat',           // { id, name, text }
  PONG: 'pong',           // { t }
  BUY_OK: 'buyok',        // { item } -- the pot covered it, apply the effect
  ERROR: 'error',         // { message }
};

/** Snapshots per second sent to each client. */
export const SNAPSHOT_HZ = 20;
/** Client state reports per second sent up to the server. */
export const STATE_HZ = 20;

/** Rooms are addressed by a short human-readable code. */
// Six symbols retain the read-aloud UX while raising the search space from
// roughly one million rooms to more than one billion. Four-character private
// rooms were practical to enumerate against a public server.
export const ROOM_CODE_LENGTH = 6;
/** Ambiguous glyphs are left out so a code can be read aloud over voice chat. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  }
  return s;
}

export function normalizeRoomCode(code) {
  return String(code || '').trim().toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

/** Names are shown to other players, so they get trimmed and bounded. */
export function sanitizeName(name) {
  const s = String(name ?? '').replace(/[^\w \-.]/g, '').trim().slice(0, 16);
  return s || 'PLAYER';
}

/**
 * A client's own durable id, used only to count players.
 *
 * Restricted to the shape the client actually generates -- hex and dashes --
 * rather than merely bounded, because this string is a Map key on the server
 * and the only reason to send anything else is to find out what happens. An id
 * that fails the shape is dropped, not repaired: presence falls back to
 * counting the seat, which costs an accurate merge of one player's menu and
 * their room, and nothing else.
 */
export function sanitizeClientId(cid) {
  // Tested whole rather than truncated to fit: slicing an over-long id would
  // turn rubbish into a well-formed id, and worse, could map two different
  // oversized strings onto the same one. The length bound is inside the
  // pattern so there is exactly one rule about what an id may be.
  const s = String(cid ?? '').trim();
  return /^[a-f0-9-]{8,64}$/i.test(s) ? s : '';
}

/**
 * Strip control characters, then bound the length. The client renders chat with
 * textContent and never innerHTML, so this is belt-and-braces rather than the
 * only thing standing between a player and an injected tag.
 */
export function sanitizeChat(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127) continue;   // control characters
    out += ch;
    if (out.length >= 160) break;
  }
  return out.trim();
}

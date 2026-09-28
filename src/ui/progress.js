// Progress that survives a run: best score, best wave, lifetime totals.
//
// This is deliberately a record rather than a meta-progression tree. Unlocking
// permanent power across runs would flatten the difficulty curve the waves are
// built around -- a player who has ground out five runs would start wave one
// already strong, and the early waves would stop teaching anything. What
// carries over is the number to beat.
//
// localStorage can be unavailable (private windows, embedded webviews, a user
// who has blocked storage), so every access is guarded and failure is silent:
// not being able to save a high score should never stop the game running.

const KEY = 'bs.progress.v1';

const EMPTY = {
  bestScore: 0,
  bestWave: 0,
  runs: 0,
  kills: 0,
  headshots: 0,
  bosses: 0,
  playtime: 0,
  /** Weapon camos: which finishes this account owns, and which is worn. */
  camos: ['standard'],
  camo: 'standard',
};

const NUMERIC_FIELDS = [
  'bestScore', 'bestWave', 'runs', 'kills', 'headshots', 'bosses', 'playtime',
];

/** Turn an untrusted storage record into the shape the HUD and armoury use. */
export function normaliseProgress(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value : {};
  const out = { ...EMPTY };

  for (const field of NUMERIC_FIELDS) {
    const n = Number(source[field]);
    const integer = Math.floor(n);
    out[field] = Number.isSafeInteger(integer) && integer >= 0
      ? integer : EMPTY[field];
  }

  const camos = Array.isArray(source.camos)
    ? source.camos.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  // De-duplicate corrupted saves and retain the one finish every build owns.
  out.camos = [...new Set(['standard', ...camos])];
  out.camo = typeof source.camo === 'string' && out.camos.includes(source.camo)
    ? source.camo : 'standard';
  return out;
}

export class Progress {
  constructor() {
    this.data = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...EMPTY };
      return normaliseProgress(JSON.parse(raw));
    } catch {
      return { ...EMPTY };
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable; the run still counts, it just is not recorded */
    }
  }

  /**
   * Fold a finished run into the record.
   * @returns {{score:boolean, wave:boolean}} which bests were beaten
   */
  recordRun({ score, wave, kills, headshots, bosses, seconds }) {
    const d = this.data;
    const beatScore = score > d.bestScore;
    const beatWave = wave > d.bestWave;

    if (beatScore) d.bestScore = score;
    if (beatWave) d.bestWave = wave;
    d.runs += 1;
    d.kills += kills || 0;
    d.headshots += headshots || 0;
    d.bosses += bosses || 0;
    d.playtime += Math.round(seconds || 0);

    this.save();
    return { score: beatScore, wave: beatWave };
  }

  /** Rows for the menu and the death screen. */
  summaryHTML() {
    const d = this.data;
    if (d.runs === 0) return '';
    const mins = Math.floor(d.playtime / 60);
    return `
      BEST SCORE <b>${d.bestScore.toLocaleString()}</b><br>
      BEST WAVE <b>${d.bestWave}</b><br>
      RUNS <b>${d.runs}</b> · KILLS <b>${d.kills.toLocaleString()}</b><br>
      BOSSES FELLED <b>${d.bosses}</b> · PLAYED <b>${mins}m</b>
    `;
  }
}

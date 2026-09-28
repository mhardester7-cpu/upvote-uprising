// One explicit, versioned acknowledgement before the player can start a game,
// create an account, join a room, or send room/chat data. The anonymous live
// headcount is basic service telemetry disclosed in the policy and starts on
// page load. Bumping POLICY_VERSION asks returning players to accept materially
// changed terms again instead of silently treating old acceptance as agreement
// to a new policy.

export const POLICY_VERSION = '2026-08-27-play-counter';
export const CONSENT_KEY = `deadfall.legal.${POLICY_VERSION}`;

function browserStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__probe__');
      return localStorage;
    }
  } catch { /* use an in-memory acknowledgement for this page load */ }
  return null;
}

export function hasLegalConsent(storage = browserStorage()) {
  try { return storage?.getItem(CONSENT_KEY) === 'accepted'; }
  catch { return false; }
}

export function saveLegalConsent(accepted, storage = browserStorage()) {
  try {
    if (accepted) storage?.setItem(CONSENT_KEY, 'accepted');
    else storage?.removeItem(CONSENT_KEY);
  } catch { /* storage-disabled visitors may still accept for this page load */ }
  return !!accepted;
}

export class LegalGate {
  constructor(checkbox, note, buttons, storage = browserStorage()) {
    this.checkbox = checkbox;
    this.note = note;
    this.buttons = buttons.filter(Boolean);
    this.storage = storage;
    this.sessionAccepted = hasLegalConsent(storage);

    if (checkbox) {
      checkbox.checked = this.sessionAccepted;
      checkbox.addEventListener('change', () => {
        this.sessionAccepted = saveLegalConsent(checkbox.checked, this.storage);
        this.refresh();
      });
    }
    this.refresh();
  }

  get accepted() { return this.sessionAccepted; }

  refresh() {
    for (const button of this.buttons) button.disabled = !this.accepted;
    if (this.note) {
      this.note.textContent = this.accepted
        ? 'READY TO PLAY'
        : 'ACCEPTANCE IS REQUIRED BEFORE PLAYING';
      this.note.classList.toggle('ok', this.accepted);
    }
  }
}

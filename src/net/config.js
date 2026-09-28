// Where the Supabase project lives.
//
// Fill these in to turn on accounts. Leave them empty and the game runs
// guest-only: everything still saves, it just saves to this browser instead of
// to a server, and the sign-in panel explains that rather than offering a
// button that cannot work.
//
// The anon key belongs in client code -- it identifies the project and grants
// nothing on its own. Row-level security is what protects a player's row, so
// apply supabase/migrations before pointing a build at a real project.
//
// A local override is read first so a developer can point at their own project
// without editing a tracked file:
//
//   localStorage.setItem('blockstrike.supabase',
//     JSON.stringify({ url: 'https://xxxx.supabase.co', anonKey: 'eyJ...' }));

// Public beta is deliberately guest-only for now. This flag is checked before
// even reading a local override, so account traffic cannot be switched back on
// accidentally from devtools. Hosted Supabase signups must also be disabled in
// the dashboard; a browser flag cannot secure the Auth API itself.
export const ACCOUNTS_ENABLED = false;

// This is public project metadata, not a secret. The game server uses the same
// publishable key only to read the public aggregate. Counter writes require a
// separate server-only environment secret; see server/playcounter.js.
export const PUBLIC_SUPABASE = Object.freeze({
  url: '',
  anonKey: '',
});

export function supabaseConfig() {
  if (!ACCOUNTS_ENABLED) return { url: '', anonKey: '' };
  try {
    const raw = localStorage.getItem('blockstrike.supabase');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.url && parsed?.anonKey) return parsed;
    }
  } catch { /* fall through to the built-in values */ }
  return PUBLIC_SUPABASE;
}

export function isConfigured() {
  const c = supabaseConfig();
  return !!(c.url && c.anonKey);
}

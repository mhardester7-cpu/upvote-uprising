// Launcher for the stable `main` build.
//
// This exists only so the process has a distinct command line. Several agents
// work on this repo at once, and a `pkill -f "node server.js"` from any of them
// to restart their own dev server also kills the one serving main -- which is
// the build being played. Starting it as `node serve-main.js` means that
// pattern no longer matches.
//
// server.js starts listening on import, so importing it is all that's needed.
import './server.js';

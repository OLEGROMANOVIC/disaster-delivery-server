// Compatibility entry point. Colyseus Cloud's rolling deploy can reuse the
// start path of a previously deployed app (e.g. the TypeScript template's
// build/index.js). Every such path simply starts the real server.
import '../server.js';

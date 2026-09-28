// dex.js / evo.js are browser scripts that assign to window.*; point window at the Worker global before they load
globalThis.window = globalThis;

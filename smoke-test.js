/* Stub-DOM smoke test: loads game.js in a fake browser environment to catch
 * top-level runtime errors (undefined refs, bad init). Does NOT exercise the
 * rAF game loop — only verifies the module loads and the boot path runs.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = fs.readFileSync(path.join(__dirname, "game.js"), "utf8");

function makeCanvas() {
  return {
    width: 800, height: 600,
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getContext: () => makeCtx(),
    addEventListener: () => {},
  };
}
function makeCtx() {
  const noop = () => {};
  return new Proxy({}, { get: () => noop, set: () => true });
}

const elements = {
  game: makeCanvas(),
  "touch-controls": { classList: { add: () => {}, remove: () => {} } },
};
const fireBtns = [
  { dataset: { base: "0" }, addEventListener: () => {} },
  { dataset: { base: "1" }, addEventListener: () => {} },
  { dataset: { base: "2" }, addEventListener: () => {} },
];

const listeners = {};
const sandbox = {
  console,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  localStorage: { getItem: () => null, setItem: () => {} },
  AudioContext: function () { return { createGain: () => ({ gain: {}, connect: () => {} }), destination: {}, currentTime: 0, sampleRate: 44100, createOscillator: () => ({ frequency: {}, connect: () => {}, start: () => {}, stop: () => {} }), createBuffer: () => ({ getChannelData: () => new Float32Array(1) }), createBufferSource: () => ({ connect: () => {}, start: () => {}, stop: () => {} }), createBiquadFilter: () => ({ frequency: {}, connect: () => {} }) }; },
  document: {
    getElementById: (id) => elements[id] || null,
    querySelectorAll: () => fireBtns,
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  },
  window: {
    innerWidth: 800, innerHeight: 600,
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    matchMedia: () => ({ matches: false }),
  },
};
sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let err = null;
try {
  vm.runInContext(file, sandbox, { filename: "game.js" });
} catch (e) {
  err = e;
}

if (err) {
  console.error("LOAD ERROR:", err.stack || err.message);
  process.exit(1);
}
console.log("game.js loaded OK. Listeners registered for:", Object.keys(listeners).join(", "));
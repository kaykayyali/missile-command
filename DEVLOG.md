# DEVLOG — Missile Command

## 2026-07-26 — v1: initial build

Built the complete core game in one pass to satisfy all four hard specs.

**What I built**
- Single-file `game.js` IIFE (~980 lines), vanilla JS + Canvas, no build step.
- Three bases (x ≈ 80/400/720) with per-base ammo pips, six cities between
  them, ground band, starfield.
- Core loop: enemy missiles spawn per wave from the top aimed at a live
  city/base, descend, and detonate the closest structure on impact. Player
  fires counter-missiles that travel to the crosshair and pop into an
  expanding fireball; any enemy missile inside the radius is destroyed and
  itself spawns a fireball (chain explosions).
- MIRVs (wave 3+): a missile may split into 2–3 warheads mid-flight. Smart
  bombs (wave 5+): pink missiles that steer away from nearby growing
  fireballs, with a small escape margin so they aren't trivially caught.
- Wave-end bonus (cities ×100 + unused ammo ×5), per-wave ammo refill for
  surviving bases, progressive difficulty via `buildWave(n)`.
- Start screen, "THE END" game-over screen with a hit-tested RESTART button
  (and Space/tap fallback), wave-cleared intermission.
- Controls: mouse aim+click, touch aim+tap + three on-screen base buttons,
  arrows/WASD aim + Space fire + 1/2/3 base-specific fire, `P` pause, `M` mute.
- Web Audio API SFX (launch sweep, filtered-noise explosions, hit thump,
  city-lost boom, wave blips, game-over drone) — all synthesized, no files.
- Responsive: canvas is 800×600 internal, CSS-scaled to fit viewport while
  keeping 4:3; touch buttons shown only on coarse pointers.
- High score persisted in `localStorage`.

**Why / decisions**
- Chose vanilla Canvas over Phaser: the game is a single screen with simple
  shapes; a framework would add a build step and a dependency for no gain.
- Single rAF loop guarded by `running` so restart can't double-fire the loop
  (the classic "double speed after restart" bug). `dt` clamped to 50 ms to
  avoid tunneling after tab-restore.
- Pause is a dedicated `_paused` flag, not a state change — early on I tried
  reusing `STATE.WAVE_END` for pause and it corrupted the wave-end timer. The
  flag never touches the state machine.

**Verified**
- `node --check game.js` passes.
- `node smoke-test.js` (stub-DOM harness) loads `game.js` without runtime
  errors; event listeners registered for keydown/keyup/resize.
- No headless browser available in this environment, so I could not
  screenshot the live page; relied on the stub-DOM load test + manual code
  review of the boot and restart paths.

**Rejected this pass**
- Hold-to-fire / autofire: deliberately omitted to keep the classic
  one-trigger-per-launch decision.
- Multiple independent particle systems: kept one array for sparks, debris,
  and score pops to stay simple.

## Iterations follow below.
# Missile Command

A web clone of the 1980 Atari arcade classic **Missile Command**, built with
vanilla JavaScript and the HTML5 Canvas. No frameworks, no build step, no
asset files — opening `index.html` in a browser is all you need. Sound effects
are synthesized live with the Web Audio API.

## How to play

You command three missile bases defending six cities against waves of incoming
ICBMs. Each wave the enemy rains missiles from the top of the screen; if they
reach the ground they destroy a city or a base. Lose all six cities and the
game is over.

Aim a crosshair and launch **counter-missiles** from your bases. A
counter-missile flies to the crosshair and detonates into an expanding
fireball. Any enemy missile caught inside the fireball is vaporized (and
itself becomes a fireball — chain explosions). Later waves add **MIRVs**
that split mid-flight into multiple warheads, and **smart bombs** (pink) that
steer away from nearby fireballs — trap them or expand the blast radius.

Each surviving base refills some ammo every wave. Score points for every
missile destroyed, plus an end-of-wave bonus for surviving cities and unused
ammo. Your high score is saved locally.

## Controls

| Action | Keyboard / Mouse | Touch |
|---|---|---|
| Aim crosshair | Mouse move or Arrow / WASD keys | Drag on the playfield |
| Fire from nearest base | Space or Click | Tap the playfield |
| Fire from a specific base | `1` / `2` / `3` | On-screen base buttons |
| Pause | `P` | — |
| Mute | `M` | — |
| Start / Restart | Space or Click / tap RESTART | Tap |

## Architecture

The whole game is a single self-contained IIFE in `game.js` (~980 lines, one
file, no dependencies).

- **Fixed internal resolution (800×600), CSS-scaled to the viewport.** All
  gameplay math runs in canvas-internal coordinates; pointer input is mapped
  back via `getBoundingClientRect`. This decouples simulation from display
  scaling and keeps the game responsive on any screen.
- **One requestAnimationFrame loop** guarded by a `running` flag, so a restart
  can never spawn a second loop. Frame `dt` is clamped to 50 ms to avoid
  physics tunneling when a tab is restored.
- **State machine:** `START → PLAYING → WAVE_END → PLAYING … → GAMEOVER`.
  A separate `_paused` flag gates the simulation during pause so the wave-end
  timer and spawn queue are never corrupted by pausing.
- **Entities** — bases, cities, player missiles, enemy missiles, explosions,
  particles — are plain object arrays updated each frame. Collision is
  point-in-circle (explosion radius vs. missile position); smart bombs get a
  small escape margin so dodging feels real.
- **Difficulty** is driven by `buildWave(n)`: missile count, fall speed,
  spawn gap, and the on-switches for MIRVs (wave 3+) and smart bombs (wave 5+)
  all scale with the wave number.
- **Audio** is fully synthesized via oscillators and filtered noise bursts —
  no audio files. The `AudioContext` is created lazily on first input to
  satisfy browser autoplay policies.
- **High score** persists in `localStorage` under `mc_highscore`.

## Files

- `index.html` — page shell, canvas, and touch fire-button overlay.
- `style.css` — layout and the responsive/touch-button styles.
- `game.js` — the game.
- `smoke-test.js` — a Node stub-DOM harness that verifies `game.js` loads
  without runtime errors (`node smoke-test.js`).
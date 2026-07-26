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

## Iter 1 — aim-assist launch line + firing-base highlight

**Changed:** added `firingBase()` (shared by `fireAtCrosshair` and the render
path). While playing, draw a faint dashed line from the base that would fire
to the crosshair plus a soft arc on that base; if no base has ammo, show a
"NO AMMO" warning at the crosshair.

**Why:** once bases start getting destroyed, the player can't tell which base
a click will spend from, and won't know they're out of ammo until they click
and nothing happens. The assist makes the resource decision visible.

**Observed:** removed duplicated base-selection logic — `fireAtCrosshair` now
delegates to `firingBase()`. `node --check` + smoke-test pass.

**Rejected:** drawing a full predicted ballistic arc — overkill; the straight
line reads fine and matches the instant-travel counter-missile.

## Iter 2 — screen shake on impacts

**Changed:** added a `shake` magnitude (px) that decays at 40 px/s; `render()`
translates the canvas by a random offset within `shake`. Triggered on
structure hits (+8), plain ground impacts (+2), and game over (16). Sky and
overlay fills expanded by 20 px on each side so shake never reveals canvas
edges.

**Why:** impact events need tactile weight; the flat "explosion + sound" alone
feels weightless for a city being vaporized.

**Observed:** shake capped at 14 (game over 16) so it never becomes nauseating.
Decays in all states so a shake started during play still finishes on the
game-over screen.

## Iter 3 — auto-pause on tab blur

**Changed:** `window` `blur` and `visibilitychange` (when hidden) call
`autoPause()`, which sets `_paused=true` if `state===PLAYING`.

**Why:** without this, a missile can "fall" and kill a city while the player is
in another tab — a cheap, unfair death. The dedicated `_paused` flag composes
with the manual P toggle without touching the state machine.

**Observed:** smoke-test now reports the `blur` and `visibilitychange`
listeners registered.

## Iter 4 — mute persistence + base labels

**Changed:** `muted` is loaded from / saved to `localStorage` (`mc_muted`).
Each base now shows its number (1/2/3) under the mound — also the keyboard
key for firing from that base.

**Why:** mute preference should survive reloads; base numbers teach the 1/2/3
key binding without forcing the player to read the start screen.

**Observed:** smoke-test stub returns `null` from `getItem`, so `muted=false`
default — fine.

## Iter 5 — difficulty curve tuning

**Changed:** rewrote `buildWave` and the spawn record so MIRV and smart-bomb
chances scale per wave (`mirvChanceBase` 0.18 + 0.04/wave capped at 0.5 from
wave 3; `smartChanceBase` 0.12 + 0.03/wave capped at 0.45 from wave 5) instead
of flat chances. Wave 1 is gentler: 6 missiles (was 8) at 60 px/s (was 70)
with a 1.7 s spawn gap (was 1.4). Added an explicit `speedCap` of 210 so late
waves stay dodgeable.

**Why:** the flat chances dumped every threat type at full intensity the
moment they unlocked; wave 1 was busier than it should be. Scaling gives a
readable ramp.

**Observed:** the spawn object now carries `mirvChance`/`smartChance`
per-wave instead of booleans, so `spawnEnemyMissile` rolls against the
wave-scaled values.

## Iter 6 — prefers-reduced-motion + particle cap

**Changed:** detect `prefers-reduced-motion: reduce` once at load. When set,
`addShake()` is a no-op and spark/debris burst counts are cut to 2–3. Added
a hard `PARTICLE_CAP` (220) that trims the oldest particles whenever a burst
is pushed.

**Why:** accessibility for motion-sensitive players, plus a safety ceiling so
a long busy wave can't balloon particle count and tank framerate.

**Observed:** `addShake()` replaces all direct `shake =` writes so the
reduced-motion gate is in one place.

## Iter 7 — 1:1 mouse aim + fire-state guard

**Changed:** `mousemove` now sets `crosshair.x = crosshair.tx = p.x` (and y)
for instant 1:1 aim instead of easing toward the target. All fire inputs
(mouse, touch, Space, 1/2/3, touch buttons) are now gated on
`state === PLAYING` so ammo can't be wasted during WAVE_END / START.

**Why:** eased aim felt laggy with a mouse — mouse users expect the crosshair
under the cursor. Firing during the wave-clear intermission silently burned
ammo before the next wave.

**Observed:** keyboard steering still uses the eased lerp (`updateCrosshair`),
so the two input modes keep their own feel.

## Iter 8 — combo / chain scoring

**Changed:** each kill increments `combo` and resets `comboTimer` to 1.6 s;
per-kill points are `MISSILE_POINTS + (combo-1)*COMBO_BONUS` (5 pts per combo
step). The streak decays and resets when the timer hits 0. HUD shows
`xN COMBO` (gold, alpha tied to remaining time) when combo > 1. Combo resets
at wave end.

**Why:** chain explosions are the signature skill expression of Missile
Command; scoring them explicitly rewards setting up cascades instead of
single picks.

**Observed:** the streak timer decays in all active states so it doesn't
freeze during the WAVE_END intermission then unfairly carry into the next
wave.

## Iter 9 — WAVE N start banner + NEW HIGH SCORE badge

**Changed:** `startWave` sets `waveBannerTimer = 1.8`; a fading gold "WAVE N"
banner renders centered at 35% height while it counts down. `endGame` records
`newHigh = score > highScore` (before updating the record); the game-over
screen shows a green "★ NEW HIGH SCORE ★" badge when true.

**Why:** wave starts needed a clear "the next one is beginning" beat; beating
your best score is the emotional payoff of a run and deserves a callout.

**Observed:** `newHigh` is computed before the high-score write so a tie
doesn't falsely flag a new record.

## Iter 10 — color-blind smart-bomb marker

**Changed:** smart bombs now render with a dashed trail and a diamond marker
instead of relying on the pink-vs-red color difference.

**Why:** the only distinguishing cue for smart bombs was hue (pink vs red),
which is invisible to red-green color-blind players and subtle even to others.
Shape + dash pattern is channel-independent.

## Iter 11 — start-screen attract animation

**Changed:** on `START`, accumulate `attractTimer`; every ~1.1 s spawn a
`decor: true` missile that descends to a random ground x and pops a small
explosion (no scoring, no structure damage). Decor missiles are skipped in
the explosion-collision loop so they can't be scored or chained. `updateMissiles`
and `updateExplosions` now run in the START/GAMEOVER branch so they animate.

**Why:** a static title screen is a weak first impression; the attract loop
signals "this is an action game" the moment the page loads.

**Observed:** had to guard the collision loop against decor missiles, otherwise
decor explosions would inflate `score` and `combo` on the title screen.

## Iter 12 — edge-case fixes (no-bases safeguard, freeze on game over)

**Changed:** the WAVE_END→next-wave transition now calls `endGame()` if zero
bases survive (unwinnable — no launchers to fire from), not only if zero
cities survive. `endGame()` clears `enemyMissiles`, `playerMissiles`, and
`spawnQueue` so the board freezes under the game-over overlay instead of
continuing to detonate.

**Why:** without the base safeguard, losing all three bases left the player in
a no-input death spiral that could drag on. Without the clear, in-flight
missiles kept "landing" and popping after the game was already over.

## Iter 13 — rebuild a city every 10000 points

**Changed:** all score gains go through `addScore(n)`, which checks a
`nextCityBonus` threshold (10000, then +10000 each time). On crossing, the
first destroyed city is rebuilt with a spark burst, a "CITY!" score pop, and
a two-note chime.

**Why:** this is the authentic 1980 Missile Command bonus-city mechanic; it
gives a skilled player a recovery path from early losses and makes sustained
play rewarding rather than a one-mistake-and-done slope.

**Observed:** `addScore` centralizes the threshold check so kills, wave
bonuses, and any future score source all qualify the player for a rebuilt
city.

## Iter 14 — persistent scorch craters

**Changed:** `hitGround` pushes a `{x, r:26}` crater when a structure dies;
`render` draws a darkened ellipse pair at each crater before drawing the
surviving structures. Craters persist for the whole game (cleared on reset).

**Why:** without craters, a destroyed base/city leaves a blank gap the same
color as the ground, erasing the visual history of the battle. Scorch marks
make the cost of mistakes legible at a glance.

## Iter 15 — cache explosion fireball sprite (perf)

**Changed:** pre-render the radial-gradient fireball once to a 256×256
offscreen canvas at load; `drawExplosions` now `drawImage`s it scaled to the
current diameter instead of allocating a fresh `createRadialGradient` per
explosion per frame. Wrapped in try/catch with a gradient fallback if sprite
creation fails.

**Why:** a busy late wave can have a dozen simultaneous fireballs; a dozen
per-frame gradient allocations is wasteful when the fireball look is static.

**Observed:** the per-explosion `hue` parameter is now unused (uniform
fireball) — acceptable; classic MC fireballs are uniform and the previous
hue variation (0 vs 20) was barely perceptible.

## Iter 16 — tappable on-screen mute button

**Changed:** the HUD "SND/MUTE" text is now a drawn, hit-tested button
(`muteBtnRect`); mouse-down and touch-start inside it call `toggleMute()`
before any fire/start logic. Persists via the existing `saveMute()`.

**Why:** touch users have no keyboard, so the `M` key was unreachable for them.
A visible tappable control closes that gap.

## Iter 17 — ammo display overflow when >10

**Changed:** base ammo pips still render up to 10, but if `b.ammo > 10` a
gold `xN` count is drawn above the pips.

**Why:** ammo can exceed 10 (start 10 + 5/wave refill), but the pip display
capped at 10, so a base holding 15 looked identical to one holding 10 —
misleading the player about how much they can spend.

## Iter 18 — tappable on-screen pause button

**Changed:** added a `pauseBtnRect()` button on the left side of the HUD,
shown only during PLAYING (or while paused). Mouse-down and touch-start
inside it call `togglePauseBtn()` (which mirrors the `P` key: toggles
`_paused` during PLAYING).

**Why:** parity with the mute button — touch users couldn't pause either.
Showing the button only when it's actionable avoids a dead control on the
start/game-over screens.

## Exhausted

I stopped after 18 iterations. Ideas considered and rejected, with reasons:

- **Per-wave score multiplier (x1.1 per wave):** rejected — the combo system
  (iter 8) and the 10k-city-bonus (iter 13) already reward sustained play; a
  third compounding reward would inflate late-game score without meaningful
  new decision-making.
- **Pre-rendered city/base sprites / richer art:** rejected — the current
  block-built skyline is readable and on-theme; detailed sprites would add
  asset weight and stray from the clean vector arcade look.
- **Background parallax / scrolling terrain:** rejected — Missile Command is
  a single fixed screen; parallax would imply motion the game doesn't have.
- **Hold-to-fire / autofire:** rejected again (as in v1) — one trigger per
  launch is the core resource-management tension; autofire removes it.
- **Online leaderboard:** rejected — out of scope (no backend, no auth) and
  the brief asks for a local single-file game; localStorage high score is the
  right ceiling.
- **Smart-bomb distinct whistle sound:** rejected — the dashed-trail +
  diamond marker (iter 10) is a sufficient cue; a unique sound would be nice
  but is low marginal value and clutters the mix.
- **Wave-end bonus breakdown (cities×100 + ammo×5):** rejected — the total
  bonus already pops as a `+N` score popup at wave end; a full breakdown line
  is informative but not worth the screen real estate during a 3 s intermission.
- **Counter-missile leading-target preview / predicted intercept:** rejected
  — counter-missiles travel instantly to the crosshair; there's no lead to
  predict. Iter 1's aim line already shows origin + destination.
- **Touch pinch-to-zoom or gesture aiming:** rejected — drag-to-aim + three
  fire buttons (current) is more precise than gestures for this game.
- **Difficulty modes (Easy/Hard) or endless mode toggle:** rejected — the
  wave curve (iter 5) already ramps smoothly; selectable modes would add UI
  and tuning surface for little gain in a game whose loop is inherently
  score-attack.
- **Rebuild destroyed *bases*:** rejected — authentic MC only rebuilds
  cities (iter 13); base loss is permanent and meaningful. Rebuilding bases
  would flatten the difficulty curve.
- **Animated crosshair pulse / expanding rings:** rejected — would compete
  visually with the fireball sprites; the static crosshair reads cleanly.

The remaining surface (sound variety, micro-animations, more HUD chrome)
would be polish without changing how the game plays or feels. I consider the
game genuinely exhausted of meaningful improvements within its scope.
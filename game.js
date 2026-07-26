/* =========================================================================
 * Missile Command — a clone of the 1980 Atari arcade game.
 *
 * Three bases defend six cities against incoming ICBMs. The player aims a
 * crosshair (mouse / touch / arrow keys) and launches counter-missiles from
 * the nearest base that still has ammo. Counter-missiles fly to the crosshair
 * and detonate into expanding fireballs; any enemy missile caught in a
 * fireball is destroyed (chained explosions). Later waves add MIRV splits and
 * "smart bombs" that dodge fireballs. Lose when all six cities fall.
 *
 * Stack: vanilla JS + HTML5 Canvas + Web Audio API. No build step, no assets.
 *
 * Layout (internal canvas is 800x600, CSS-scaled to the viewport):
 *   - Ground band at the bottom.
 *   - Three bases at x ≈ 80, 400, 720.
 *   - Six cities arranged between the bases.
 *
 * All gameplay logic lives in one requestAnimationFrame loop guarded by
 * `running` so a restart can never double-fire the loop.
 * ========================================================================= */

(() => {
"use strict";

// ----------------------- Constants & configuration -----------------------
const W = 800, H = 600;
const GROUND_Y = 540;          // y of the ground line
const BASE_Y = 520;            // vertical center of bases/cities
const BASE_X = [80, 400, 720]; // x of the three bases
const BASE_AMMO_START = 10;    // missiles per base per wave
const CITY_X = [160, 240, 320, 480, 560, 640];
const COUNTER_SPEED = 520;     // px/sec for player counter-missiles
const EXPLOSION_MAX = 70;      // max fireball radius
const EXPLOSION_GROW = 1;      // grow -> hold -> shrink lifetime, in seconds
const EXPLOSION_HOLD = 0.35;
const EXPLOSION_SHRINK = 0.55;
const SMART_DODGE_SPEED = 60;  // extra lateral speed a smart bomb uses to dodge
const WAVE_BONUS_AMMO = 5;     // ammo refilled per surviving base each wave
const CITY_BONUS = 100;        // score per surviving city at wave end
const AMMO_BONUS = 5;          // score per unused missile at wave end
const MISSILE_POINTS = 25;     // per enemy missile destroyed
const COMBO_WINDOW = 1.6;      // seconds a streak stays alive between kills
const COMBO_BONUS = 5;         // extra points per kill per combo step

// Tunable per-wave difficulty curve (see buildWave).
const WAVE = {
  baseMissiles: 6,      // missiles at wave 1 (gentle start)
  missilesGrowth: 3,    // +N missiles each wave
  speed: 60,            // px/sec enemy missile fall speed at wave 1
  speedGrowth: 9,       // +N speed each wave
  speedCap: 210,        // hard speed ceiling so late waves stay dodgeable
  spawnGap: 1.7,        // seconds between spawns at wave 1
  spawnGapShrink: 0.08, // gap reduction per wave (floored at 0.5)
  mirvFromWave: 3,      // wave at which splitting MIRVs appear
  mirvChanceBase: 0.18, // base MIRV split chance at wave 3
  mirvChanceGrow: 0.04, // +chance per wave after the MIRV on-wave
  mirvChanceCap: 0.5,
  smartFromWave: 5,     // wave at which smart bombs appear
  smartChanceBase: 0.12, // base smart-bomb chance at wave 5
  smartChanceGrow: 0.03,
  smartChanceCap: 0.45,
};

// ----------------------- Canvas / DOM -----------------------
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const touchControls = document.getElementById("touch-controls");
const fireButtons = [...document.querySelectorAll(".fire-btn")];

// ----------------------- Audio (Web Audio API, synthesized) -----------------------
let audioCtx = null;
let masterGain = null;
let muted = false;

// Respect the OS "reduce motion" preference: disables screen shake and
// trims particle bursts so the game stays calm for motion-sensitive players.
const reducedMotion = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) || false;
const PARTICLE_CAP = 220;

// Lazily create the AudioContext on first user gesture (browsers block autoplay).
function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(audioCtx.destination);
  } catch (e) { /* audio unsupported — game still runs */ }
}

function tone({ freq = 440, type = "sine", dur = 0.12, gain = 0.3, slideTo = null, when = 0 }) {
  if (!audioCtx || muted) return;
  const t0 = audioCtx.currentTime + when;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noiseBurst({ dur = 0.4, gain = 0.5, filterFreq = 800, when = 0 }) {
  // White noise run through a lowpass to make an explosion "boom".
  if (!audioCtx || muted) return;
  const t0 = audioCtx.currentTime + when;
  const len = Math.floor(audioCtx.sampleRate * dur);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filt = audioCtx.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.setValueAtTime(filterFreq, t0);
  filt.frequency.exponentialRampToValueAtTime(120, t0 + dur);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(masterGain);
  src.start(t0);
  src.stop(t0 + dur);
}

const SFX = {
  launch: () => tone({ freq: 700, slideTo: 1800, type: "sawtooth", dur: 0.18, gain: 0.18 }),
  explosion: () => noiseBurst({ dur: 0.5, gain: 0.6, filterFreq: 1200 }),
  hit: () => tone({ freq: 220, slideTo: 80, type: "square", dur: 0.3, gain: 0.25 }),
  cityLost: () => noiseBurst({ dur: 0.8, gain: 0.7, filterFreq: 600 }),
  waveStart: () => { tone({ freq: 440, dur: 0.12, gain: 0.2 }); tone({ freq: 660, dur: 0.18, gain: 0.2, when: 0.12 }); },
  gameOver: () => { tone({ freq: 330, slideTo: 80, type: "sawtooth", dur: 0.8, gain: 0.3 }); noiseBurst({ dur: 1.0, gain: 0.5, filterFreq: 400 }); },
  blip: () => tone({ freq: 880, dur: 0.05, gain: 0.15 }),
};

// ----------------------- Game state -----------------------
const STATE = { START: 0, PLAYING: 1, WAVE_END: 2, GAMEOVER: 3 };
let state = STATE.START;
let score = 0;
let highScore = 0;
let wave = 0;

let bases = [];      // {x, alive, ammo}
let cities = [];     // {x, alive}
let playerMissiles = [];
let enemyMissiles = [];
let explosions = [];
let particles = []; // score-pop / debris sparkles

const crosshair = { x: W / 2, y: H / 2, tx: W / 2, ty: H / 2 };
let pointerDown = false;

let waveDef = null;   // description of the current wave
let spawnQueue = [];  // pending spawns: {at, x, targetX}
let waveTimer = 0;     // counts down WAVE_END pause
let waveEndTimer = 0;
let lastTime = 0;
let shake = 0;        // current screen-shake magnitude in px; decays each frame
let combo = 0;        // consecutive-kill streak counter
let comboTimer = 0;   // seconds left before the combo resets
let waveBannerTimer = 0; // seconds the 'WAVE N' banner remains visible
let newHigh = false;     // set when the just-ended game beat the high score
let running = false;   // true while the rAF loop is active
let rafId = 0;

// Persisted high score.
function loadHighScore() {
  try { highScore = parseInt(localStorage.getItem("mc_highscore") || "0", 10) || 0; } catch (e) { highScore = 0; }
}
function saveHighScore() {
  try { localStorage.setItem("mc_highscore", String(highScore)); } catch (e) { /* ignore */ }
}
function loadMute() {
  try { muted = localStorage.getItem("mc_muted") === "1"; } catch (e) { muted = false; }
}
function saveMute() {
  try { localStorage.setItem("mc_muted", muted ? "1" : "0"); } catch (e) { /* ignore */ }
}

// ----------------------- Initialization / reset -----------------------
function resetGame() {
  score = 0;
  wave = 0;
  bases = BASE_X.map((x) => ({ x, alive: true, ammo: BASE_AMMO_START }));
  cities = CITY_X.map((x) => ({ x, alive: true }));
  playerMissiles = [];
  enemyMissiles = [];
  explosions = [];
  particles = [];
  spawnQueue = [];
  waveDef = null;
  waveTimer = 0;
  waveEndTimer = 0;
  shake = 0;
  combo = 0;
  comboTimer = 0;
  waveBannerTimer = 0;
  newHigh = false;
  crosshair.x = crosshair.tx = W / 2;
  crosshair.y = crosshair.ty = H * 0.4;
}

function startWave(n) {
  wave = n;
  bases.forEach((b) => { if (b.alive) b.ammo += WAVE_BONUS_AMMO; });
  waveDef = buildWave(n);
  spawnQueue = waveDef.spawns.slice();
  waveTimer = 0;
  waveBannerTimer = 1.8;
  SFX.waveStart();
}

function buildWave(n) {
  const count = WAVE.baseMissiles + (n - 1) * WAVE.missilesGrowth;
  const speed = Math.min(WAVE.speed + (n - 1) * WAVE.speedGrowth, WAVE.speedCap);
  const gap = Math.max(0.5, WAVE.spawnGap - (n - 1) * WAVE.spawnGapShrink);
  // MIRV and smart-bomb chances scale with wave so the late game escalates
  // without dumping every threat type on the player at once.
  const mirvChance = n >= WAVE.mirvFromWave
    ? Math.min(WAVE.mirvChanceCap, WAVE.mirvChanceBase + (n - WAVE.mirvFromWave) * WAVE.mirvChanceGrow)
    : 0;
  const smartChance = n >= WAVE.smartFromWave
    ? Math.min(WAVE.smartChanceCap, WAVE.smartChanceBase + (n - WAVE.smartFromWave) * WAVE.smartChanceGrow)
    : 0;

  const spawns = [];
  let t = 0.8 + Math.random() * 0.4; // first spawn offset
  for (let i = 0; i < count; i++) {
    const target = pickTarget();
    const startX = 40 + Math.random() * (W - 80);
    spawns.push({
      at: t,
      x: startX,
      targetX: target,
      speed,
      mirvChance,
      smartChance,
    });
    // Occasionally cluster two missiles closer together at higher waves.
    const jitter = (n >= 4 && Math.random() < 0.3) ? gap * 0.3 : gap;
    t += jitter * (0.7 + Math.random() * 0.6);
  }
  return { spawns, count, speed, gap, mirvChance, smartChance };
}

function pickTarget() {
  // Prefer targeting surviving cities, then bases, for player pressure.
  const liveCities = cities.filter((c) => c.alive);
  const liveBases = bases.filter((b) => b.alive);
  const pool = liveCities.length && Math.random() < 0.75 ? liveCities : (liveBases.length ? liveBases : liveCities);
  if (!pool.length) return W / 2;
  return pool[(Math.random() * pool.length) | 0].x;
}

// ----------------------- Spawning enemy missiles -----------------------
function spawnEnemyMissile(def) {
  const startX = def.x;
  const targetX = def.targetX;
  const dx = targetX - startX;
  const dy = GROUND_Y - 30;
  const dist = Math.hypot(dx, dy);
  const speed = def.speed;
  const isSmart = def.smartChance > 0 && Math.random() < def.smartChance;
  const m = {
    x: startX, y: 30,
    vx: (dx / dist) * speed,
    vy: (dy / dist) * speed,
    targetX,
    isSmart,
    trail: [],
    splitAt: def.mirvChance > 0 && Math.random() < def.mirvChance ? (0.35 + Math.random() * 0.2) : null,
    age: 0,
    alive: true,
  };
  enemyMissiles.push(m);
}

function splitMirv(m) {
  // Split one descending missile into 2-3 warheads aimed at nearby targets.
  const n = 2 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const targetX = Math.max(20, Math.min(W - 20, m.targetX + (Math.random() * 200 - 100)));
    const dx = targetX - m.x;
    const dy = GROUND_Y - m.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = Math.hypot(m.vx, m.vy);
    enemyMissiles.push({
      x: m.x, y: m.y,
      vx: (dx / dist) * speed, vy: (dy / dist) * speed,
      targetX, isSmart: false, trail: [], splitAt: null, age: 0, alive: true,
    });
  }
  SFX.blip();
}

// ----------------------- Firing counter-missiles -----------------------
function fireFromBase(baseIndex, tx, ty) {
  // If the requested base is dead or out of ammo, fall back to the nearest
  // base that can still fire, so explicit-base inputs (keys 1/2/3, touch
  // buttons) keep working after a base is lost.
  const requested = bases[baseIndex];
  let chosen = requested;
  if (!requested || !requested.alive || requested.ammo <= 0) {
    const alts = bases.filter((bb) => bb.alive && bb.ammo > 0)
      .sort((a, c) => Math.abs(a.x - tx) - Math.abs(c.x - tx));
    if (!alts.length) return; // nothing left to fire
    chosen = alts[0];
  }
  chosen.ammo--;
  const sx = chosen.x, sy = BASE_Y;
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.hypot(dx, dy) || 1;
  playerMissiles.push({
    x: sx, y: sy,
    vx: (dx / dist) * COUNTER_SPEED,
    vy: (dy / dist) * COUNTER_SPEED,
    tx, ty, dist, traveled: 0, trail: [],
  });
  SFX.launch();
}

function fireAtCrosshair() {
  const b = firingBase();
  if (!b) return;
  fireFromBase(bases.indexOf(b), crosshair.x, crosshair.y);
}

// The base that would fire given the current crosshair — nearest alive base
// that still has ammo. Shared by fireAtCrosshair and the aim-assist render.
function firingBase() {
  const aliveBases = bases.filter((bb) => bb.alive && bb.ammo > 0);
  if (!aliveBases.length) return null;
  aliveBases.sort((a, c) => Math.abs(a.x - crosshair.x) - Math.abs(c.x - crosshair.x));
  return aliveBases[0];
}

// ----------------------- Explosions -----------------------
function createExplosion(x, y, maxR = EXPLOSION_MAX, hue = 30) {
  explosions.push({
    x, y, r: 2, maxR, hue,
    t: 0,
    phase: "grow", // grow -> hold -> shrink
    growT: EXPLOSION_GROW, holdT: EXPLOSION_HOLD, shrinkT: EXPLOSION_SHRINK,
    alive: true,
  });
  SFX.explosion();
  // A few sparks for juice (trimmed under reduced-motion).
  const sparks = reducedMotion ? 2 : 8;
  for (let i = 0; i < sparks; i++) {
    particles.push({
      x, y, vx: (Math.random() * 2 - 1) * 120, vy: (Math.random() * 2 - 1) * 120,
      life: 0.5, max: 0.5, kind: "spark", hue,
    });
  }
  trimParticles();
}

// ----------------------- Particles (score pops, debris) -----------------------
function popScore(x, y, amount) {
  particles.push({ x, y, vx: 0, vy: -40, life: 1.0, max: 1.0, kind: "score", text: "+" + amount });
}

function groundDebris(x) {
  const n = reducedMotion ? 3 : 12;
  for (let i = 0; i < n; i++) {
    particles.push({
      x, y: GROUND_Y,
      vx: (Math.random() * 2 - 1) * 160,
      vy: -Math.random() * 220 - 40,
      life: 0.8, max: 0.8, kind: "debris", hue: 30,
    });
  }
  trimParticles();
}

// Hard cap on live particles so a long, busy wave can't balloon particle count
// and tank framerate.
function trimParticles() {
  if (particles.length > PARTICLE_CAP) {
    particles.splice(0, particles.length - PARTICLE_CAP);
  }
}

// ----------------------- Update -----------------------
function update(dt) {
  // Screen shake decays smoothly regardless of game state.
  if (shake > 0) shake = Math.max(0, shake - dt * 40);
  // Combo streak timer decays in active states; expiring resets the streak.
  if (comboTimer > 0) {
    comboTimer -= dt;
    if (comboTimer <= 0) combo = 0;
  }
  if (waveBannerTimer > 0) waveBannerTimer -= dt;
  if (state === STATE.START || state === STATE.GAMEOVER) {
    // idle animations: keep particles drifting
    updateParticles(dt);
    return;
  }

  if (state === STATE.WAVE_END) {
    waveEndTimer -= dt;
    updateParticles(dt);
    updateMissiles(dt);
    updateExplosions(dt);
    if (waveEndTimer <= 0) {
      const liveCities = cities.filter((c) => c.alive).length;
      if (liveCities === 0) {
        endGame();
      } else {
        startWave(wave + 1);
        state = STATE.PLAYING;
      }
    }
    return;
  }

  // PLAYING
  waveTimer += dt;

  // Process spawn queue.
  while (spawnQueue.length && spawnQueue[0].at <= waveTimer) {
    spawnEnemyMissile(spawnQueue.shift());
  }

  updateMissiles(dt);
  updateExplosions(dt);
  updateParticles(dt);
  updateCrosshair(dt);

  // Wave clear: nothing left to spawn, no enemy missiles alive.
  if (spawnQueue.length === 0 && enemyMissiles.length === 0) {
    awardWaveBonus();
    waveEndTimer = 3.0;
    state = STATE.WAVE_END;
  }
}

function updateCrosshair(dt) {
  // Ease crosshair toward target (smooth keyboard movement & clamp).
  const k = 1 - Math.pow(0.0001, dt); // framerate-independent lerp factor
  crosshair.x += (crosshair.tx - crosshair.x) * k;
  crosshair.y += (crosshair.ty - crosshair.y) * k;
  crosshair.tx = Math.max(8, Math.min(W - 8, crosshair.tx));
  crosshair.ty = Math.max(8, Math.min(GROUND_Y - 8, crosshair.ty));
}

function updateMissiles(dt) {
  // Player missiles — fly to target then detonate.
  for (let i = playerMissiles.length - 1; i >= 0; i--) {
    const m = playerMissiles[i];
    m.trail.push({ x: m.x, y: m.y });
    if (m.trail.length > 18) m.trail.shift();
    const step = Math.hypot(m.vx, m.vy) * dt;
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.traveled += step;
    if (m.traveled >= m.dist) {
      createExplosion(m.tx, m.ty);
      playerMissiles.splice(i, 1);
    }
  }

  // Enemy missiles — descend, possibly split, hit ground targets.
  for (let i = enemyMissiles.length - 1; i >= 0; i--) {
    const m = enemyMissiles[i];
    m.age += dt;
    m.trail.push({ x: m.x, y: m.y });
    if (m.trail.length > 40) m.trail.shift();

    if (m.splitAt !== null && m.age >= m.splitAt) {
      m.alive = false;
      splitMirv(m);
      enemyMissiles.splice(i, 1);
      continue;
    }

    // Smart bombs dodge the nearest growing explosion.
    if (m.isSmart) {
      const danger = explosions.reduce((best, e) => {
        if (e.phase !== "grow" && e.phase !== "hold") return best;
        const d = Math.hypot(e.x - m.x, e.y - m.y) - e.r;
        if (d > 0 && d < 90 && (best === null || d < best.d)) return { d, e };
        return best;
      }, null);
      if (danger) {
        // Steer laterally away from the explosion while still descending.
        const away = m.x < danger.e.x ? -1 : 1;
        m.vx += away * SMART_DODGE_SPEED * dt;
        // Re-normalize toward a target that leads it to ground.
        const sp = Math.hypot(m.vx, m.vy) || 1;
        const dy = GROUND_Y - m.y;
        const wantSpeed = Math.min(sp, 200);
        const dirx = m.vx / sp, diry = m.vy / sp;
        m.vx = dirx * wantSpeed;
        m.vy = Math.max(diry * wantSpeed, 40);
      }
    }

    m.x += m.vx * dt;
    m.y += m.vy * dt;

    // Reached the ground line → hit a target.
    if (m.y >= GROUND_Y) {
      m.y = GROUND_Y;
      hitGround(m.x);
      enemyMissiles.splice(i, 1);
      continue;
    }
    // Drift off the sides: clamp and let it continue.
    if (m.x < 0 || m.x > W) { enemyMissiles.splice(i, 1); }
  }
}

function hitGround(x) {
  // Destroy whichever city or base is closest to the impact x.
  let best = null, bestD = 30;
  for (const c of cities) {
    if (!c.alive) continue;
    const d = Math.abs(c.x - x);
    if (d < bestD) { bestD = d; best = c; }
  }
  for (const b of bases) {
    if (!b.alive) continue;
    const d = Math.abs(b.x - x);
    if (d < bestD) { bestD = d; best = b; }
  }
  if (best) {
    if ("ammo" in best) {
      best.alive = false;
      best.ammo = 0;
      SFX.hit();
    } else {
      best.alive = false;
      SFX.cityLost();
    }
    createExplosion(best.x, GROUND_Y - 6, 60, 0);
    groundDebris(best.x);
    addShake(8); // structure hit = heavy shake
  } else {
    // Missed everything — small ground puff.
    createExplosion(x, GROUND_Y - 4, 30, 30);
    addShake(2);
  }
}

function updateExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.t += dt;
    if (e.phase === "grow") {
      e.r = (e.t / e.growT) * e.maxR;
      if (e.t >= e.growT) { e.phase = "hold"; e.t = 0; e.r = e.maxR; }
    } else if (e.phase === "hold") {
      if (e.t >= e.holdT) { e.phase = "shrink"; e.t = 0; }
    } else {
      e.r = e.maxR * (1 - e.t / e.shrinkT);
      if (e.t >= e.shrinkT) { e.alive = false; explosions.splice(i, 1); continue; }
    }

    // Collision with enemy missiles (only while the fireball has size).
    if (e.r > 4) {
      for (let j = enemyMissiles.length - 1; j >= 0; j--) {
        const m = enemyMissiles[j];
        // Smart bombs can escape the edge; give them a small margin.
        const margin = m.isSmart ? 6 : 0;
        if (Math.hypot(m.x - e.x, m.y - e.y) <= e.r + margin) {
          createExplosion(m.x, m.y, 36, 20);
          enemyMissiles.splice(j, 1);
          // Combo: each kill within COMBO_WINDOW extends the streak; longer
          // streaks award a small per-kill bonus, rewarding chain explosions.
          combo++;
          comboTimer = COMBO_WINDOW;
          const bonus = (combo - 1) * COMBO_BONUS;
          const pts = MISSILE_POINTS + bonus;
          score += pts;
          popScore(m.x, m.y, pts);
        }
      }
    }
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === "debris" || p.kind === "spark") p.vy += 320 * dt; // gravity
    if (p.kind === "debris" && p.y > GROUND_Y) p.life = 0;
  }
}

function awardWaveBonus() {
  const liveCities = cities.filter((c) => c.alive).length;
  const ammoLeft = bases.reduce((s, b) => s + (b.alive ? b.ammo : 0), 0);
  const bonus = liveCities * CITY_BONUS + ammoLeft * AMMO_BONUS;
  if (bonus > 0) {
    score += bonus;
    popScore(W / 2, H / 2 - 40, bonus);
    SFX.blip();
  }
  if (score > highScore) { highScore = score; saveHighScore(); }
  combo = 0;
  comboTimer = 0;
}

function endGame() {
  state = STATE.GAMEOVER;
  setPause(false);
  addShake(16);
  newHigh = score > highScore;
  if (newHigh) { highScore = score; saveHighScore(); }
  SFX.gameOver();
}

// ----------------------- Rendering -----------------------
function render() {
  ctx.save();
  if (shake > 0) {
    ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
  }
  // Sky
  ctx.fillStyle = "#05060d";
  ctx.fillRect(-20, -20, W + 40, H + 40);

  // Stars (deterministic, drawn each frame for the twinkle-less retro look)
  drawStars();

  // Ground
  ctx.fillStyle = "#1a2030";
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.fillStyle = "#2a3550";
  ctx.fillRect(0, GROUND_Y, W, 4);

  drawCities();
  drawBases();
  drawMissileTrails();
  drawExplosions();
  drawParticles();
  drawCrosshair();
  drawHUD();

  if (state === STATE.START) drawStartScreen();
  else if (state === STATE.GAMEOVER) drawGameOverScreen();
  else if (state === STATE.WAVE_END) drawWaveEnd();
  if (waveBannerTimer > 0 && state === STATE.PLAYING) drawWaveBanner();
  if (_paused && state === STATE.PLAYING) drawPauseOverlay();
  ctx.restore();
}

function drawWaveBanner() {
  const a = Math.min(1, waveBannerTimer / 1.8);
  ctx.globalAlpha = a;
  ctx.fillStyle = "#ffce5c";
  ctx.textAlign = "center";
  ctx.font = "bold 40px 'Courier New', monospace";
  ctx.fillText("WAVE " + wave, W / 2, H * 0.35);
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

function drawPauseOverlay() {
  ctx.fillStyle = "rgba(5,6,13,0.6)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#9fffd6";
  ctx.textAlign = "center";
  ctx.font = "bold 36px 'Courier New', monospace";
  ctx.fillText("PAUSED", W / 2, H / 2);
  ctx.font = "14px 'Courier New', monospace";
  ctx.fillText("press P to resume", W / 2, H / 2 + 30);
}

const stars = Array.from({ length: 60 }, () => ({
  x: Math.random() * W, y: Math.random() * (GROUND_Y - 40),
  s: Math.random() * 1.5 + 0.3, b: Math.random(),
}));

function drawStars() {
  for (const s of stars) {
    ctx.globalAlpha = 0.4 + s.b * 0.5;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(s.x, s.y, s.s, s.s);
  }
  ctx.globalAlpha = 1;
}

function drawCities() {
  for (const c of cities) {
    if (!c.alive) continue;
    ctx.fillStyle = "#39c0ff";
    // little skyline of three blocks
    const x = c.x, y = BASE_Y;
    ctx.fillRect(x - 14, y - 6, 8, 14);
    ctx.fillRect(x - 4, y - 12, 8, 20);
    ctx.fillRect(x + 6, y - 8, 8, 16);
    ctx.fillStyle = "#7fdcff";
    ctx.fillRect(x - 2, y - 10, 4, 4);
  }
}

function drawBases() {
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i];
    ctx.fillStyle = b.alive ? "#ffce5c" : "#3a3a44";
    // Mound
    ctx.beginPath();
    ctx.moveTo(b.x - 26, BASE_Y);
    ctx.lineTo(b.x - 18, BASE_Y - 14);
    ctx.lineTo(b.x + 18, BASE_Y - 14);
    ctx.lineTo(b.x + 26, BASE_Y);
    ctx.closePath();
    ctx.fill();
    if (b.alive) {
      // Ammo pips
      ctx.fillStyle = "#ff7a3c";
      for (let a = 0; a < Math.min(b.ammo, 10); a++) {
        ctx.fillRect(b.x - 14 + (a % 5) * 6, BASE_Y - 12 + (a < 5 ? 0 : -5), 4, 4);
      }
    }
    // Base number label (1/2/3) — also the keyboard key for that base.
    ctx.fillStyle = b.alive ? "rgba(207,232,255,0.5)" : "rgba(120,120,130,0.4)";
    ctx.font = "10px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), b.x, BASE_Y + 14);
    ctx.textAlign = "left";
  }
}

function drawMissileTrails() {
  // Enemy trails (red). Smart bombs get a dashed trail + diamond marker so
  // they're distinguishable without relying on the pink/red color difference
  // (color-blind support).
  ctx.lineWidth = 1.5;
  for (const m of enemyMissiles) {
    ctx.save();
    if (m.isSmart) ctx.setLineDash([3, 3]);
    ctx.strokeStyle = m.isSmart ? "#ff5cff" : "#ff4040";
    ctx.beginPath();
    for (let i = 0; i < m.trail.length; i++) {
      const p = m.trail[i];
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(m.x, m.y);
    ctx.stroke();
    ctx.restore();
    if (m.isSmart) {
      // diamond marker
      ctx.fillStyle = "#ff5cff";
      ctx.beginPath();
      ctx.moveTo(m.x, m.y - 4);
      ctx.lineTo(m.x + 4, m.y);
      ctx.lineTo(m.x, m.y + 4);
      ctx.lineTo(m.x - 4, m.y);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = "#ff7070";
      ctx.fillRect(m.x - 1.5, m.y - 1.5, 3, 3);
    }
  }
  // Player trails (cyan)
  ctx.strokeStyle = "#5cffd6";
  for (const m of playerMissiles) {
    ctx.beginPath();
    for (let i = 0; i < m.trail.length; i++) {
      const p = m.trail[i];
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(m.x, m.y);
    ctx.stroke();
    ctx.fillStyle = "#aaffe9";
    ctx.fillRect(m.x - 1.5, m.y - 1.5, 3, 3);
  }
}

function drawExplosions() {
  for (const e of explosions) {
    const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, Math.max(1, e.r));
    g.addColorStop(0, "rgba(255,255,210,0.95)");
    g.addColorStop(0.4, "rgba(255,170,60,0.8)");
    g.addColorStop(0.8, "rgba(255,80,30,0.4)");
    g.addColorStop(1, "rgba(120,20,10,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(e.x, e.y, Math.max(1, e.r), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawParticles() {
  for (const p of particles) {
    const a = Math.max(0, p.life / p.max);
    if (p.kind === "score") {
      ctx.globalAlpha = a;
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 14px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText(p.text, p.x, p.y);
      ctx.textAlign = "left";
    } else if (p.kind === "spark") {
      ctx.globalAlpha = a;
      ctx.fillStyle = "#ffcf6a";
      ctx.fillRect(p.x, p.y, 2, 2);
    } else { // debris
      ctx.globalAlpha = a;
      ctx.fillStyle = "#ff9a3c";
      ctx.fillRect(p.x, p.y, 2, 2);
    }
  }
  ctx.globalAlpha = 1;
}

function drawCrosshair() {
  if (state !== STATE.PLAYING && state !== STATE.WAVE_END) return;
  const { x, y } = crosshair;

  // Aim assist: a faint dashed line from the base that would fire to the
  // crosshair, plus a soft ring on that base. Lets the player see which
  // base/ammo a click will spend — important once bases start getting lost.
  const b = firingBase();
  if (b) {
    ctx.save();
    ctx.strokeStyle = "rgba(159,255,214,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(b.x, BASE_Y - 14);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Highlight the firing base.
    ctx.strokeStyle = "rgba(159,255,214,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(b.x, BASE_Y - 14, 16, Math.PI, 0);
    ctx.stroke();
    ctx.restore();
  } else {
    // No ammo anywhere — warn the player at the crosshair.
    ctx.fillStyle = "#ff5050";
    ctx.font = "10px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText("NO AMMO", x, y - 16);
    ctx.textAlign = "left";
  }

  ctx.strokeStyle = "#9fffd6";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 12, y); ctx.lineTo(x - 4, y);
  ctx.moveTo(x + 4, y); ctx.lineTo(x + 12, y);
  ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 4);
  ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 12);
  ctx.stroke();
  ctx.strokeRect(x - 2, y - 2, 4, 4);
}

function drawHUD() {
  ctx.fillStyle = "#cfe8ff";
  ctx.font = "16px 'Courier New', monospace";
  ctx.textAlign = "left";
  ctx.fillText("SCORE  " + String(score).padStart(6, "0"), 12, 24);
  ctx.textAlign = "center";
  ctx.fillText("WAVE " + wave, W / 2, 24);
  ctx.textAlign = "right";
  ctx.fillText("HI " + String(highScore).padStart(6, "0"), W - 12, 24);
  ctx.textAlign = "left";

  // Mute indicator
  ctx.fillStyle = muted ? "#ff5050" : "#39c0ff";
  ctx.fillText(muted ? "MUTE [M]" : "SND [M]", W - 110, 44);

  // Combo indicator (only while a streak is live and > 1).
  if (combo > 1) {
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(255,206,92,${0.6 + 0.4 * Math.min(1, comboTimer)})`;
    ctx.font = "bold 18px 'Courier New', monospace";
    ctx.fillText("x" + combo + " COMBO", W / 2, 50);
    ctx.textAlign = "left";
  }
}

function drawStartScreen() {
  overlay();
  ctx.fillStyle = "#ffce5c";
  ctx.textAlign = "center";
  ctx.font = "bold 44px 'Courier New', monospace";
  ctx.fillText("MISSILE COMMAND", W / 2, H / 2 - 60);
  ctx.fillStyle = "#cfe8ff";
  ctx.font = "16px 'Courier New', monospace";
  ctx.fillText("Defend your six cities. Aim and fire counter-missiles.", W / 2, H / 2 - 10);
  ctx.fillText("Mouse / Touch: aim & fire  |  Arrows: aim  |  Space: fire", W / 2, H / 2 + 18);
  ctx.fillText("1 / 2 / 3: fire from a specific base   |   M: mute   |   P: pause", W / 2, H / 2 + 42);
  ctx.fillStyle = "#9fffd6";
  ctx.font = "bold 20px 'Courier New', monospace";
  ctx.fillText("CLICK or PRESS SPACE to begin", W / 2, H / 2 + 90);
}

function drawGameOverScreen() {
  overlay();
  ctx.fillStyle = "#ff5050";
  ctx.textAlign = "center";
  ctx.font = "bold 48px 'Courier New', monospace";
  ctx.fillText("THE END", W / 2, H / 2 - 40);
  ctx.fillStyle = "#cfe8ff";
  ctx.font = "20px 'Courier New', monospace";
  ctx.fillText("Score: " + score, W / 2, H / 2 + 4);
  ctx.fillText("Wave reached: " + wave, W / 2, H / 2 + 32);
  ctx.fillStyle = "#ffce5c";
  ctx.fillText("High Score: " + highScore, W / 2, H / 2 + 60);
  if (newHigh) {
    ctx.fillStyle = "#9fffd6";
    ctx.font = "bold 16px 'Courier New', monospace";
    ctx.fillText("★ NEW HIGH SCORE ★", W / 2, H / 2 + 84);
  }

  // Restart button (drawn; hit-tested in input handler).
  const btn = restartBtnRect();
  ctx.fillStyle = "#1b2440";
  ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
  ctx.strokeStyle = "#9fffd6";
  ctx.lineWidth = 2;
  ctx.strokeRect(btn.x, btn.y, btn.w, btn.h);
  ctx.fillStyle = "#9fffd6";
  ctx.font = "bold 18px 'Courier New', monospace";
  ctx.fillText("RESTART", btn.x + btn.w / 2, btn.y + btn.h / 2 + 6);

  ctx.fillStyle = "#7f9fbf";
  ctx.font = "12px 'Courier New', monospace";
  ctx.fillText("(or press SPACE)", W / 2, btn.y + btn.h + 22);
}

function drawWaveEnd() {
  ctx.fillStyle = "rgba(5,6,13,0.5)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#9fffd6";
  ctx.textAlign = "center";
  ctx.font = "bold 28px 'Courier New', monospace";
  ctx.fillText("WAVE " + wave + " CLEARED", W / 2, H / 2 - 20);
  ctx.fillStyle = "#cfe8ff";
  ctx.font = "16px 'Courier New', monospace";
  ctx.fillText("Next wave in " + Math.ceil(waveEndTimer) + "...", W / 2, H / 2 + 10);
}

function overlay() {
  ctx.fillStyle = "rgba(5,6,13,0.75)";
  ctx.fillRect(-20, -20, W + 40, H + 40);
}

function restartBtnRect() {
  const w = 180, h = 44;
  return { x: W / 2 - w / 2, y: H / 2 + 90, w, h };
}

// ----------------------- Main loop -----------------------
function loop(ts) {
  if (!running) return;
  if (!lastTime) lastTime = ts;
  let dt = (ts - lastTime) / 1000;
  lastTime = ts;
  if (dt > 0.05) dt = 0.05; // clamp huge gaps (tab was hidden) to avoid tunneling
  if (_paused && state === STATE.PLAYING) {
    render(); // keep drawing the paused overlay; skip simulation
  } else {
    update(dt);
    render();
  }
  rafId = requestAnimationFrame(loop);
}

function startLoop() {
  if (running) return;
  running = true;
  lastTime = 0;
  rafId = requestAnimationFrame(loop);
}
function stopLoop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

// ----------------------- Input -----------------------
// Map a page/client coordinate to canvas-internal coordinates.
function toCanvas(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const sx = W / r.width, sy = H / r.height;
  return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
}

// Mouse aim + click to fire. Mouse aims 1:1 (instant) for a responsive feel;
// keyboard steering still uses the eased lerp toward the target.
canvas.addEventListener("mousemove", (e) => {
  const p = toCanvas(e.clientX, e.clientY);
  crosshair.tx = crosshair.x = p.x;
  crosshair.ty = crosshair.y = p.y;
});
canvas.addEventListener("mousedown", (e) => {
  ensureAudio();
  if (state === STATE.START) { beginGame(); return; }
  if (state === STATE.GAMEOVER) { handleRestartClick(e); return; }
  if (state === STATE.PLAYING) fireAtCrosshair();
});
canvas.addEventListener("mouseup", () => { pointerDown = false; });

// Touch aim + tap to fire; hold for repeated fire is intentionally absent to
// preserve the classic one-trigger-per-launch feel.
canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  ensureAudio();
  if (e.touches.length) {
    const t = e.touches[0];
    const p = toCanvas(t.clientX, t.clientY);
    crosshair.tx = p.x; crosshair.ty = p.y;
    // Move crosshair instantly on first touch for responsiveness.
    crosshair.x = p.x; crosshair.y = p.y;
  }
  if (state === STATE.START) { beginGame(); return; }
  if (state === STATE.GAMEOVER) { handleRestartTouch(e); return; }
  if (state === STATE.PLAYING) fireAtCrosshair();
}, { passive: false });
canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (e.touches.length) {
    const t = e.touches[0];
    const p = toCanvas(t.clientX, t.clientY);
    crosshair.tx = p.x; crosshair.ty = p.y;
  }
}, { passive: false });

// Touch fire buttons — fire from a chosen base at the current crosshair.
fireButtons.forEach((btn) => {
  btn.addEventListener("touchstart", (e) => {
    e.preventDefault();
    ensureAudio();
    if (state !== STATE.PLAYING) return;
    const idx = parseInt(btn.dataset.base, 10);
    fireFromBase(idx, crosshair.tx, crosshair.ty);
  }, { passive: false });
  btn.addEventListener("click", (e) => {
    ensureAudio();
    if (state !== STATE.PLAYING) return;
    const idx = parseInt(btn.dataset.base, 10);
    fireFromBase(idx, crosshair.tx, crosshair.ty);
  });
});

// Keyboard: arrows/WASD to aim, space to fire, 1/2/3 to fire specific bases.
// A clean `_paused` flag gates update(); pause never touches `state`, so the
// WAVE_END timer and spawn queue stay consistent across a pause/resume.
let _paused = false;
let keys = {};
function setPause(v) { _paused = v; }

// Add screen-shake, no-op when the player prefers reduced motion.
function addShake(n) { if (!reducedMotion) shake = Math.min(14, shake + n); }

window.addEventListener("keydown", (e) => {
  ensureAudio();
  keys[e.code] = true;
  if (e.code === "Space") {
    e.preventDefault();
    if (state === STATE.START) { beginGame(); return; }
    if (state === STATE.GAMEOVER) { restart(); return; }
    if (state === STATE.PLAYING) fireAtCrosshair();
  } else if (e.code === "KeyM") {
    muted = !muted;
    saveMute();
  } else if (e.code === "KeyP") {
    if (state === STATE.PLAYING) setPause(!_paused);
  } else if (e.code === "Digit1") { if (state === STATE.PLAYING) fireFromBase(0, crosshair.tx, crosshair.ty); }
  else if (e.code === "Digit2") { if (state === STATE.PLAYING) fireFromBase(1, crosshair.tx, crosshair.ty); }
  else if (e.code === "Digit3") { if (state === STATE.PLAYING) fireFromBase(2, crosshair.tx, crosshair.ty); }
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

// Keyboard crosshair steering, layered on top of updateCrosshair via a
// function reassignment so the smooth lerp still applies after steering.
const _baseUpdateCrosshair = updateCrosshair;
updateCrosshair = function (dt) {
  const v = 380; // aim speed, px/sec
  if (keys["ArrowLeft"] || keys["KeyA"]) crosshair.tx -= v * dt;
  if (keys["ArrowRight"] || keys["KeyD"]) crosshair.tx += v * dt;
  if (keys["ArrowUp"] || keys["KeyW"]) crosshair.ty -= v * dt;
  if (keys["ArrowDown"] || keys["KeyS"]) crosshair.ty += v * dt;
  _baseUpdateCrosshair(dt);
};

function beginGame() {
  resetGame();
  setPause(false);
  startWave(1);
  state = STATE.PLAYING;
  startLoop();
}

function restart() {
  resetGame();
  setPause(false);
  startWave(1);
  state = STATE.PLAYING;
  // Loop should already be running; if not, start it.
  if (!running) startLoop();
}

function handleRestartClick(e) {
  const p = toCanvas(e.clientX, e.clientY);
  const b = restartBtnRect();
  if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) restart();
}
function handleRestartTouch(e) {
  if (!e.changedTouches.length) return;
  const t = e.changedTouches[0];
  const p = toCanvas(t.clientX, t.clientY);
  const b = restartBtnRect();
  if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) restart();
  else restart(); // any tap on game over restarts
}

// ----------------------- Responsive canvas -----------------------
// Auto-pause if the tab loses focus or is hidden, so the player can't lose a
// city to a missile that "fell" while they were away. Uses the dedicated
// `_paused` flag so it composes cleanly with the manual P-toggle.
function autoPause() {
  if (state === STATE.PLAYING) setPause(true);
}
window.addEventListener("blur", autoPause);
window.addEventListener("visibilitychange", () => { if (document.hidden) autoPause(); });
function resize() {
  const vw = window.innerWidth, vh = window.innerHeight;
  // Keep the 4:3 aspect ratio, fit within viewport.
  const scale = Math.min(vw / W, vh / H);
  const cw = Math.floor(W * scale), ch = Math.floor(H * scale);
  canvas.style.width = cw + "px";
  canvas.style.height = ch + "px";
  // Touch buttons only matter on coarse pointers.
  if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
    touchControls.classList.add("show");
  } else {
    touchControls.classList.remove("show");
  }
}
window.addEventListener("resize", resize);

// ----------------------- Boot -----------------------
loadHighScore();
loadMute();
resetGame();
resize();
render(); // draw the start screen once
startLoop(); // loop runs from the start so the start screen animates

})();
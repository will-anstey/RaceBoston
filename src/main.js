// Race Boston - bootstrap, game state machine and main loop.

import * as THREE from 'three';
import { loadMap, RC } from './mapdata.js';
import { RoadGraph } from './roadgraph.js';
import { buildWorld } from './world.js';
import { Sky, PRESET_NAMES } from './sky.js';
import { globalUniforms } from './materials.js';
import { CollisionWorld, SURF } from './collision.js';
import { Vehicle, HANDLING } from './vehicle.js';
import { buildPlayerCar, setNightLights } from './carmodel.js';
import { ChaseCamera } from './camera.js';
import { Input } from './input.js';
import { AudioFX } from './audio.js';
import { HUD, MapArt, Minimap, BigMap } from './hud.js';
import { Missions } from './missions.js';
import { Traffic } from './traffic.js';
import { Menu, CARS } from './menu.js';
import { SkidMarks } from './effects.js';
import { clamp, smoothstep, loadJSON, saveJSON, nextFrame } from './util.js';

const STEP = 1 / 120;
const isTouch = matchMedia('(pointer: coarse)').matches;
const DEFAULT_SETTINGS = {
  quality: isTouch ? 'medium' : 'high', traffic: 26, tod: 'day', metric: false,
  sound: true, arrow: true, labels: true, car: 'coupe',
};
const QUALITY = {
  low: { pr: 1, shadow: 0, trees: 380, draw: 1400 },
  medium: { pr: 1.25, shadow: 1024, trees: 520, draw: 2000 },
  high: { pr: 1.75, shadow: 2048, trees: 720, draw: 2700 },
  ultra: { pr: 2, shadow: 4096, trees: 950, draw: 3300 },
};
const CITY_OF = {
  Cambridge: ['Cambridgeport', 'East Cambridge', 'Central Square', 'Inman Square', 'Wellington-Harrington', 'Mid-Cambridge', 'The Port', 'Riverside', 'MIT', 'Kendall Square', 'Cambridge'],
  Somerville: ['East Somerville', 'Union Square', 'Prospect Hill', 'Spring Hill', 'Brickbottom', 'Inner Belt', 'Somerville'],
  Brookline: ['Brookline Village', 'Pill Hill', 'Brookline'],
};
const ROAD_KIND = ['Highway', 'Highway', 'Avenue', 'Street', 'Street', 'Side street', 'Lane', 'Service road'];

class Game {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...loadJSON('rb.settings', {}) };
    this.state = 'loading';
    this.acc = 0;
    this.fps = 60;
    this.sinking = 0;
    this.lastSafe = null;
    this.safeTimer = 0;
    this.locTimer = 0;
    this.areaCandidate = null;
    this.areaTimer = 0;
    this.lastArea = null;
    this.cullTimer = 0;
    this.impactCooldown = 0;
    this.inputOverride = null;
    this.frame = 0;
  }

  async init() {
    const canvas = document.getElementById('view');
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.4, 3600);
    this.camera.position.set(0, 200, 400);
    this.sky = new Sky(renderer, this.scene);
    this.sky.setPreset(this.settings.tod);
    this.applyQuality();

    const bar = document.getElementById('load-bar'), txt = document.getElementById('load-text');
    const progress = (p, t) => { bar.style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%'; if (t) txt.textContent = t; };
    progress(0.02, 'Downloading Boston…');
    const map = (this.map = await loadMap('data/boston.json', (p) => progress(0.02 + p * 0.33, 'Downloading Boston…')));
    progress(0.36, 'Connecting streets');
    await nextFrame();
    const graph = (this.graph = new RoadGraph(map));
    const world = (this.world = await buildWorld(map, graph, this.scene, (p, t) => progress(0.38 + p * 0.45, t)));
    progress(0.85, 'Mapping obstacles');
    await nextFrame();
    this.collision = new CollisionWorld(map, world);
    progress(0.9, 'Drawing the map');
    await nextFrame();
    const art = new MapArt(map, graph);

    this.input = new Input();
    this.audio = new AudioFX();
    this.audio.muted = !this.settings.sound;
    this.hud = new HUD();
    this.minimap = new Minimap(document.getElementById('minimap'), art);
    this.bigmap = new BigMap(document.getElementById('bigmap'), document.getElementById('bigmap-canvas'), art, map.landmarks);
    this.bigmap.onPick = (x, z, lm) => this.missions.setWaypoint(x, z, lm);
    this.bigmap.onClear = () => this.missions.setWaypoint(null);
    this.chase = new ChaseCamera(this.camera);
    this.missions = new Missions(this);
    this.traffic = new Traffic(this);
    this.traffic.setDensity(this.settings.traffic);
    this.menu = new Menu(this);

    this.skids = new SkidMarks(this.scene);
    // Soft fill light so the player's car reads at night.
    this.carGlow = new THREE.PointLight(0xc8d4ff, 0, 14, 1.6);
    this.scene.add(this.carGlow);
    this.headlight = new THREE.SpotLight(0xfff1d6, 0, 85, 0.62, 0.55, 1.5);
    this.headlight.castShadow = false;
    this.scene.add(this.headlight, this.headlight.target);

    this.selectCar(this.settings.car, true);
    const spawn = this.missions.stopPos('Public Garden') || { x: 0, z: 0 };
    this.spawn = spawn;
    this.placeCar(spawn.x, spawn.z, 0);
    this.respawn();
    this.applyTimeOfDay();

    progress(0.96, 'Warming up engines');
    await nextFrame();
    this.renderer.compile(this.scene, this.camera);
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'play') this.pause(); });
    if (isTouch) document.getElementById('touch').classList.remove('hidden');
    progress(1, 'Ready');
    document.getElementById('loading').classList.add('done');
    this.state = 'menu';
    this.menu.show('main');
    this.last = performance.now();
    this.ready = true;
    requestAnimationFrame((t) => this.loop(t));
  }

  // -------------------------------------------------------------- setup
  applyQuality() {
    const q = QUALITY[this.settings.quality] || QUALITY.high;
    this.q = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr));
    this.renderer.shadowMap.enabled = q.shadow > 0;
    this.sky.shadowExtent = q.shadow >= 4096 ? 170 : 120;
    this.sky.setShadowQuality(q.shadow);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  applyTimeOfDay() {
    this.sky.setPreset(this.settings.tod);
    const night = this.sky.nightAmount;
    setNightLights(night > 0.3);
    this.headlight.intensity = night > 0.3 ? 260 * night : 0;
    if (this.playerModel) this.playerModel.head.emissiveIntensity = night > 0.3 ? 4 : 0.8;
  }

  setSetting(key, value) {
    this.settings[key] = value;
    saveJSON('rb.settings', this.settings);
    if (key === 'quality') this.applyQuality();
    if (key === 'traffic') this.traffic.setDensity(value);
    if (key === 'tod') this.applyTimeOfDay();
    if (key === 'sound') this.audio.setMuted(!value);
  }

  selectCar(id, initial = false) {
    const def = CARS.find((c) => c.id === id) || CARS[0];
    this.settings.car = def.id;
    if (!initial) saveJSON('rb.settings', this.settings);
    const old = this.car;
    if (this.playerModel) this.scene.remove(this.playerModel.root);
    this.playerModel = buildPlayerCar(def.model, def.color);
    this.scene.add(this.playerModel.root);
    const spec = this.playerModel.spec;
    this.car = new Vehicle(HANDLING[def.handling], {
      wheelR: spec.wheelR, radius: spec.W / 2 + 0.03,
      circles: [-(spec.L / 2 - spec.W / 2 - 0.05), 0, spec.L / 2 - spec.W / 2 - 0.05],
    });
    if (old) this.car.reset(old.x, old.z, old.heading);
    this.applyTimeOfDay();
  }

  placeCar(x, z, heading) {
    // Nudge along the heading until no collision circle overlaps a wall.
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    const out = {};
    for (const d of [0, 1.5, -1.5, 3, -3, 5, -5, 8, -8]) {
      const px = x + fx * d, pz = z + fz * d;
      const free = this.car.h.circles.every((o) => !this.collision.resolveCircle(px + fx * o, pz + fz * o, this.car.h.radius, out) || out.kind === 4);
      if (free) { x = px; z = pz; break; }
    }
    this.car.reset(x, z, heading);
    this.sinking = 0;
    this.chase?.snap();
    this.updatePlayerModel();
  }

  // Put the car back on the nearest road, facing along it.
  respawn(useSafe = false) {
    const g = this.graph;
    let x = this.car.x, z = this.car.z, h = this.car.heading;
    if (useSafe && this.lastSafe) ({ x, z, h } = this.lastSafe);
    const r = g.nearestRoad(x, z, 300, (rd) => rd.cls <= RC.LIVING) || g.nearestRoad(x, z, 3000);
    if (r) {
      const road = this.map.roads[r.road];
      const a = road.nodes[r.seg], b = road.nodes[r.seg + 1];
      let hh = Math.atan2(g.nx(b) - g.nx(a), -(g.nz(b) - g.nz(a)));
      if (!road.oneway && Math.cos(hh - h) < 0) hh += Math.PI;
      const off = road.oneway ? 0 : Math.min(road.width / 4, 3);
      x = r.x + Math.cos(hh) * off;
      z = r.z + Math.sin(hh) * off;
      h = hh;
    }
    this.placeCar(x, z, h);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.bigmap.open) this.bigmap.show(true, this.car.x, this.car.z);
  }

  // -------------------------------------------------------------- states
  begin(mode, arg) {
    this.audio.init();
    this.menu.hide();
    this.bigmap.show(false);
    this.state = 'play';
    this.hud.show(true);
    this.hud.fadeHint();
    this.input.clearActions();
    this.resumeTime = performance.now();
    this.modeArg = arg;
    if (mode === 'race') this.missions.startRace(arg);
    else if (mode === 'taxi') this.missions.startTaxi();
    else this.missions.startFree();
    if (mode !== 'race' && this.state === 'play' && this.car.speed < 0.1) this.chase.snap();
  }

  pause() {
    if (this.state !== 'play') return;
    this.state = 'paused';
    this.bigmap.show(false);
    this.menu.show('pause');
  }

  resume() {
    this.menu.hide();
    this.state = 'play';
    this.input.clearActions();
    this.resumeTime = performance.now();
  }

  restart() {
    const m = this.missions.mode;
    if (m === 'race') this.begin('race', this.missions.race?.def.id || this.modeArg);
    else if (m === 'taxi') this.begin('taxi');
    else this.begin('free');
  }

  toMenu() {
    this.missions.clear();
    this.state = 'menu';
    this.hud.show(false);
    this.bigmap.show(false);
    this.menu.show('main');
  }

  showResults(r) {
    if (this.state !== 'play') return;
    this.state = 'results';
    this.hud.setMission(null);
    this.hud.show(false);
    this.menu.show('results', r);
  }

  // ---------------------------------------------------------------- loop
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    this.frame++;
    globalUniforms.uTime.value = now / 1000;
    this.input.update(dt);
    this.menu.pollPad();
    this.handleActions();

    const playing = this.state === 'play' && !this.bigmap.open;
    if (playing) this.updatePlay(dt);
    else if (this.state === 'menu') this.updateAttract(dt);

    // City keeps moving behind the menus.
    if (this.state === 'menu' || playing) this.traffic.update(dt);
    if (playing) {
      if (this.car.impact > this.frameImpact) this.frameImpact = this.car.impact;
      this.handleImpacts(dt);
      this.chase.lookBack = this.input.state.lookBack;
      this.chase.update(dt, this.car, this.collision);
    }
    this.updatePlayerModel();
    this.sky.update(this.camera, this.state === 'menu' ? this.attractFocus : new THREE.Vector3(this.car.x, 0, this.car.z));
    this.updateHeadlight();
    this.updateVisibility(dt);
    if (this.state === 'play' || this.state === 'paused' || this.state === 'results') this.updateHUD(dt);
    if (this.bigmap.open) this.bigmap.draw(this.car, { ...this.missions.overlays(), cars: this.traffic.positions() });
    this.audio.update(this.car, this.effectiveInput || this.input.state, playing && !this.sinking);
    this.renderer.render(this.scene, this.camera);
  }

  handleActions() {
    const inp = this.input;
    const playing = this.state === 'play';
    if (inp.take('fullscreen')) {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    }
    if (inp.take('mute')) { this.setSetting('sound', !this.settings.sound); this.hud.toast(this.settings.sound ? 'Sound on' : 'Sound off', '', 1200); }
    if (!playing) { inp.clearActions(); return; }
    if (inp.take('pause')) {
      if (performance.now() - (this.resumeTime || 0) < 250) return;
      if (this.bigmap.open) this.bigmap.show(false);
      else this.pause();
      return;
    }
    if (inp.take('map')) this.bigmap.show(!this.bigmap.open, this.car.x, this.car.z);
    if (this.bigmap.open) { inp.clearActions(); return; }
    if (inp.take('camera')) { const name = this.chase.cycle(); this.hud.toast(name, 'Camera', 1200); }
    if (inp.take('reset')) { if (!(this.missions.race && !this.missions.race.started)) this.respawn(); }
    if (inp.take('time')) {
      const i = PRESET_NAMES.indexOf(this.settings.tod);
      this.setSetting('tod', PRESET_NAMES[(i + 1) % PRESET_NAMES.length]);
      this.hud.toast(this.settings.tod[0].toUpperCase() + this.settings.tod.slice(1), 'Time of day', 1400);
    }
    inp.clearActions();
  }

  updatePlay(dt) {
    let inp = this.input.state;
    if (this.inputOverride && this.input.enabled) inp = { ...inp, ...this.inputOverride };
    if (this.sinking) inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, horn: false };
    this.effectiveInput = inp;
    this.frameImpact = 0;
    this.acc = Math.min(this.acc + dt, STEP * 10);
    while (this.acc >= STEP) {
      this.car.step(STEP, inp, this.collision);
      if (this.car.impact > this.frameImpact) { this.frameImpact = this.car.impact; this.frameImpactKind = this.car.impactKind; }
      this.acc -= STEP;
    }
    const car = this.car, cw = this.collision;
    // Water: sink, then respawn on the last safe road position.
    if (this.sinking) {
      this.sinking += dt;
      car.vx *= 0.9; car.vz *= 0.9;
      if (this.sinking > 1.7) { this.respawn(true); this.hud.message('Back on dry land', '', 1200); }
    } else if (cw.isWater(car.x, car.z)) {
      this.sinking = 0.001;
      this.audio.splash();
      this.hud.message('Splash!', 'Into the drink', 1500, '#7fc8ff');
    } else {
      const surf = cw.surfaceAt(car.x, car.z);
      if (surf & SURF.BLDG) { this.stuckIn = (this.stuckIn || 0) + dt; if (this.stuckIn > 0.4) { this.stuckIn = 0; this.respawn(); } }
      else this.stuckIn = 0;
      this.safeTimer -= dt;
      if (this.safeTimer <= 0 && surf & SURF.ROAD && car.speed > 1.5) {
        this.safeTimer = 0.5;
        this.lastSafe = { x: car.x, z: car.z, h: car.heading };
      }
    }
    this.skids.update(car, !this.sinking && !!(cw.surfaceAt(car.x, car.z) & (SURF.ROAD | SURF.PAVED)));
    this.missions.update(dt);
  }

  handleImpacts(dt) {
    this.impactCooldown -= dt;
    const imp = this.frameImpact || 0;
    if (imp > 2.2 && this.impactCooldown <= 0) {
      this.impactCooldown = 0.18;
      this.audio.crash(imp / 18);
      this.chase.bump(Math.min(1, imp / 14));
    }
  }

  updateAttract(dt) {
    const t = performance.now() / 1000;
    const cx = -150, cz = 60, R = 560;
    const a = t * 0.045;
    this.camera.position.set(cx + Math.sin(a) * R, 200 + Math.sin(t * 0.1) * 25, cz + Math.cos(a) * R);
    this.attractFocus = this.attractFocus || new THREE.Vector3();
    this.attractFocus.set(cx, 0, cz);
    this.camera.lookAt(cx, 40, cz);
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
  }

  updatePlayerModel() {
    const m = this.playerModel, c = this.car;
    if (!m) return;
    const sinkY = this.sinking ? -Math.min(1.6, this.sinking * 1.1) : 0;
    m.root.position.set(c.x, sinkY, c.z);
    m.root.rotation.set(this.sinking ? Math.min(0.25, this.sinking * 0.2) : 0, -c.heading, 0, 'YXZ');
    m.body.rotation.set(c.pitch, 0, c.roll);
    for (const w of m.wheels) {
      if (w.front) w.pivot.rotation.y = -c.steer;
      w.mesh.rotation.x = -c.wheelSpin;
    }
    const inp = this.effectiveInput || this.input.state;
    const braking = this.state === 'play' && ((inp.brake > 0 && c.vF > 0.5) || inp.handbrake);
    const night = this.sky.nightAmount > 0.3;
    m.tail.emissiveIntensity = braking ? 4 : night ? 1.4 : 0.35;
  }

  updateHeadlight() {
    const c = this.car;
    const on = this.sky.nightAmount > 0.3;
    this.headlight.visible = on;
    this.carGlow.visible = on;
    this.carGlow.intensity = 60 * this.sky.nightAmount;
    this.carGlow.position.set(c.x - c.fx * 1.5, 4.2, c.z - c.fz * 1.5);
    if (!on) return;
    this.headlight.position.set(c.x + c.fx * 2.7, 0.75, c.z + c.fz * 2.7);
    this.headlight.target.position.set(c.x + c.fx * 24, 0, c.z + c.fz * 24);
    this.headlight.target.updateMatrixWorld();
  }

  updateVisibility(dt) {
    const cam = this.camera.position;
    this.cullTimer -= dt;
    if (this.cullTimer <= 0) {
      this.cullTimer = 0.2;
      const draw = Math.min(this.q.draw, this.sky.fogFar + 250);
      for (const m of this.world.buildingChunks) {
        const c = m.userData.center;
        m.visible = Math.hypot(c.x - cam.x, c.z - cam.z) - m.userData.radius < draw;
      }
      const td = this.q.trees;
      for (const t of this.world.treeChunks) {
        const c = t.userData.center;
        t.visible = Math.hypot(c.x - cam.x, c.z - cam.z) < td + 150;
      }
    }
    const showLabels = this.settings.labels;
    for (const s of this.world.labels) {
      const d = Math.hypot(s.position.x - cam.x, s.position.z - cam.z);
      const a = showLabels ? smoothstep(45, 110, d) * (1 - smoothstep(650, 950, d)) : 0;
      s.visible = a > 0.01;
      s.material.opacity = a;
    }
  }

  updateHUD(dt) {
    const c = this.car, hud = this.hud;
    hud.setSpeed(c.speed, this.settings.metric);
    hud.setGear(c.vF < -0.5 ? 'R' : this.audio.gear ? String(this.audio.gear) : 'D');
    hud.setBoost(c.boost, c.boosting);
    this.locTimer -= dt;
    if (this.locTimer <= 0) {
      this.locTimer = 0.25;
      this.updateLocation(0.25);
    }
    if (this.frame % 2 === 0 || this.fps > 50) {
      this.minimap.draw(c.x, c.z, this.chase.mode === 3 ? this.chase.heading : c.heading, c.speed, { ...this.missions.overlays(), cars: this.traffic.positions() });
    }
  }

  updateLocation(dt) {
    const c = this.car, map = this.map;
    const r = this.graph.nearestRoad(c.x, c.z, 30);
    let name = '';
    if (r) {
      const road = map.roads[r.road];
      name = road.name || ROAD_KIND[road.cls];
    }
    let area = null, bd = Infinity;
    for (const p of map.places) {
      if (p.rank === 0 || /Historic District/i.test(p.name)) continue;
      const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
      if (d < bd) { bd = d; area = p.name; }
    }
    if (bd > 1600 ** 2) area = null;
    let city = 'Boston';
    for (const [k, list] of Object.entries(CITY_OF)) if (list.includes(area)) city = k;
    if (area === city) area = null;
    this.hud.setStreet(name, area ? `${area} · ${city}` : city);
    const key = area || city;
    if (key !== this.areaCandidate) { this.areaCandidate = key; this.areaTimer = 0; }
    else if (key !== this.lastArea) {
      this.areaTimer += dt;
      if (this.areaTimer > 1.5) {
        if (this.lastArea !== null) this.hud.toast(key, area ? city : 'Welcome to', 2600);
        this.lastArea = key;
      }
    }
  }

  // ------------------------------------------------------- test helpers
  debugState() {
    const c = this.car;
    const info = this.renderer.info.render;
    return {
      state: this.state, mode: this.missions.mode, x: c.x, z: c.z, heading: c.heading, speed: c.speed, vF: c.vF, vR: c.vR,
      boost: c.boost, sinking: this.sinking, impact: this.frameImpact, fps: Math.round(this.fps), calls: info.calls, tris: info.triangles,
      street: this.hud.streetName.textContent, area: this.hud.streetArea.textContent, traffic: this.traffic.cars.length,
      race: this.missions.race ? { next: this.missions.race.next, time: this.missions.race.time, started: this.missions.race.started, done: this.missions.race.done } : null,
      taxi: this.missions.taxi ? { stage: this.missions.taxi.stage, money: this.missions.taxi.money, clock: this.missions.taxi.clock } : null,
      route: this.missions.route ? this.missions.route.length : 0,
    };
  }
}

const game = new Game();
window.RB = { game };
game.init().catch((err) => {
  console.error(err);
  const t = document.getElementById('load-text');
  t.textContent = 'Failed to start: ' + err.message + ' (serve this folder over http, e.g. python3 -m http.server)';
  t.style.color = '#ff8a8a';
});

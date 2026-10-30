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
import { StreetSigns } from './signs.js';
import { updateLandmarks } from './landmarks.js';
import { Trains } from './trains.js';
import { TrainMode, lineName } from './trainmode.js';
import { FlyCam } from './fly.js';
import { Planes } from './planes.js';
import { updateLightMaterial } from './airport.js';
import { clamp, smoothstep, loadJSON, saveJSON, nextFrame } from './util.js';

const STEP = 1 / 150;
const isTouch = matchMedia('(pointer: coarse)').matches;
const DEFAULT_SETTINGS = {
  quality: isTouch ? 'medium' : 'high', traffic: 26, tod: 'day', metric: false,
  sound: true, arrow: true, labels: true, car: 'coupe', trains: 2, planes: 2,
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
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance' }));
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
    this.signs = new StreetSigns(map, graph, this.scene, this.collision);
    progress(0.9, 'Drawing the map');
    await nextFrame();
    const art = new MapArt(map, graph);

    this.input = new Input();
    this.audio = new AudioFX();
    this.audio.muted = !this.settings.sound;
    this.hud = new HUD();
    this.minimap = new Minimap(document.getElementById('minimap'), art);
    this.bigmap = new BigMap(document.getElementById('bigmap'), document.getElementById('bigmap-canvas'), art, map.landmarks);
    // In fly mode a click on the map jumps there; otherwise it sets a waypoint.
    this.bigmap.onPick = (x, z, lm) => {
      if (this.state === 'fly') { this.fly.teleport(x, z); this.bigmap.show(false); }
      else this.missions.setWaypoint(x, z, lm);
    };
    this.bigmap.onClear = () => this.missions.setWaypoint(null);
    this.chase = new ChaseCamera(this.camera);
    this.missions = new Missions(this);
    this.traffic = new Traffic(this);
    this.traffic.setDensity(this.settings.traffic);
    this.trains = new Trains(this);
    this.trains.setDensity(this.settings.trains);
    this.trainMode = new TrainMode(this);
    this.planes = new Planes(this, world.airport);
    this.planes.setDensity(this.settings.planes);
    this.fly = new FlyCam(this.camera, canvas, this.input);
    this.fly.terrain = this.map.terrain;
    this.initDragLook(canvas);
    this.focusPt = { x: 0, y: 0, z: 0 };
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
    document.addEventListener('visibilitychange', () => { if (document.hidden && (this.state === 'play' || this.state === 'fly')) this.pause(); });
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
    if (key === 'trains') this.trains.setDensity(value);
    if (key === 'planes') this.planes.setDensity(value);
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

  placeCar(x, z, heading, y = this.map.terrain.h(x, z)) {
    // Nudge along the heading until no collision circle overlaps a wall.
    const fx = Math.sin(heading), fz = -Math.cos(heading);
    const out = {}, g = {};
    // Probe from just above the requested height so a tunnel under a street
    // (or a deck over one) is found rather than the other level.
    for (const d of [0, 1.5, -1.5, 3, -3, 5, -5, 8, -8]) {
      const px = x + fx * d, pz = z + fz * d;
      const py = this.collision.groundHeight(px, pz, y + 0.2, g);
      const free = this.car.h.circles.every((o) => !this.collision.resolveCircle(px + fx * o, pz + fz * o, this.car.h.radius, out, py) || out.kind === 4);
      if (free) { x = px; z = pz; break; }
    }
    this.car.reset(x, z, heading, this.collision.groundHeight(x, z, y + 0.2, g));
    this.sinking = 0;
    this.chase?.snap();
    this.updatePlayerModel();
  }

  // Put the car back on the nearest road, facing along it.
  respawn(useSafe = false) {
    const g = this.graph;
    let x = this.car.x, z = this.car.z, h = this.car.heading, y = this.car.y;
    if (useSafe && this.lastSafe) ({ x, z, h, y } = this.lastSafe);
    const r = g.nearestRoad3D(x, z, y, 300, (rd) => rd.cls <= RC.LIVING) || g.nearestRoad3D(x, z, y, 3000);
    if (r) {
      const road = this.map.roads[r.road];
      const a = road.nodes[r.seg], b = road.nodes[r.seg + 1];
      let hh = Math.atan2(g.nx(b) - g.nx(a), -(g.nz(b) - g.nz(a)));
      if (!road.oneway && Math.cos(hh - h) < 0) hh += Math.PI;
      const off = road.oneway ? 0 : Math.min(road.width / 4, 3);
      x = r.x + Math.cos(hh) * off;
      z = r.z + Math.sin(hh) * off;
      h = hh;
      y = r.y;
    }
    this.placeCar(x, z, h, y);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.bigmap.open) this.bigmap.show(true, this.car.x, this.car.z);
  }

  // -------------------------------------------------------------- states
  begin(mode, arg) {
    this.leaveFly();
    this.endTrain();
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
    if (this.state !== 'play' && this.state !== 'fly' && this.state !== 'train') return;
    this.pausedFrom = this.state;
    if (this.state === 'fly') this.fly.exit();
    this.state = 'paused';
    this.bigmap.show(false);
    this.menu.show('pause');
  }

  resume() {
    this.menu.hide();
    this.state = this.pausedFrom === 'fly' || this.pausedFrom === 'train' ? this.pausedFrom : 'play';
    if (this.state === 'fly') this.fly.active = true;
    this.input.clearActions();
    this.resumeTime = performance.now();
  }

  // ------------------------------------------------------------ fly mode
  beginFly() {
    this.endTrain();
    this.audio.init();
    this.menu.hide();
    this.bigmap.show(false);
    if (this.missions.mode !== 'free' || this.state === 'menu') this.missions.startFree();
    const fromMenu = this.state === 'menu';
    this.state = 'fly';
    this.pausedFrom = null;
    this.hud.show(true);
    this.input.clearActions();
    const c = this.car;
    c.vx = c.vz = c.vF = c.vR = c.yawRate = 0;
    if (!fromMenu) {
      // Start a little above and behind wherever the camera was.
      this.camera.position.y = Math.max(this.camera.position.y + 12, 14);
    }
    this.fly.enter();
    this.camera.near = 1;
    this.camera.far = 9000;
    this.camera.updateProjectionMatrix();
    this.missions.arrow.visible = false;
    this.hud.toast('Fly mode', 'Click to look · WASD · Enter drops the car', 3400);
  }

  // Switch back to driving. dropCar: put the car on the road below the camera.
  exitFly(dropCar) {
    if (this.state !== 'fly') return;
    this.leaveFly();
    if (dropCar) this.dropCarAtCamera();
    this.state = 'play';
    this.pausedFrom = null;
    this.chase.snap();
    this.input.clearActions();
    this.resumeTime = performance.now();
  }

  // Restore driving camera settings (safe to call any time).
  leaveFly() {
    if (!this.fly.active && this.state !== 'fly' && this.pausedFrom !== 'fly') return;
    this.fly.exit();
    this.pausedFrom = null;
    this.camera.near = 0.4;
    this.camera.far = 3600;
    this.camera.updateProjectionMatrix();
    this.sky.setFogBoost(0);
  }

  dropCarAtCamera() {
    const f = this.fly.focus({});
    const ground = this.map.terrain.h(this.fly.x, this.fly.z);
    const level = this.fly.y < ground - 2 ? this.fly.y : this.map.terrain.h(f.x, f.z);
    const g = this.graph;
    const r = g.nearestRoad3D(f.x, f.z, level, 400, (rd) => rd.cls <= RC.LIVING) || g.nearestRoad3D(f.x, f.z, level, 3000);
    if (!r) return;
    const road = this.map.roads[r.road];
    const a = road.nodes[r.seg], b = road.nodes[r.seg + 1];
    let h = Math.atan2(g.nx(b) - g.nx(a), -(g.nz(b) - g.nz(a)));
    if (!road.oneway && Math.cos(h - this.fly.yaw) < 0) h += Math.PI;
    const off = road.oneway ? 0 : Math.min(road.width / 4, 3);
    this.placeCar(r.x + Math.cos(h) * off, r.z + Math.sin(h) * off, h, r.y);
  }

  updateFly(dt) {
    this.fly.update(dt, this.map.meta.play);
    this.sky.setFogBoost(Math.max(0, this.fly.y));
    this.missions.arrow.visible = false;
  }

  // Point the world streams around: the car, the fly camera's view, or the menu orbit.
  focusPoint() {
    const f = this.focusPt;
    if (this.state === 'menu' && this.attractFocus) { f.x = this.attractFocus.x; f.y = 0; f.z = this.attractFocus.z; }
    else if (this.state === 'fly' || (this.state === 'paused' && this.pausedFrom === 'fly')) this.fly.focus(f);
    else if (this.trainMode.active) this.trainMode.pose(f);
    else { f.x = this.car.x; f.y = this.car.y; f.z = this.car.z; }
    return f;
  }

  restart() {
    if (this.trainMode.active) { this.beginTrain(this.trainMode.run.index); return; }
    const m = this.missions.mode;
    if (m === 'race') this.begin('race', this.missions.race?.def.id || this.modeArg);
    else if (m === 'taxi') this.begin('taxi');
    else this.begin('free');
  }

  toMenu() {
    this.leaveFly();
    this.endTrain();
    this.missions.clear();
    this.state = 'menu';
    this.hud.show(false);
    this.bigmap.show(false);
    this.menu.show('main');
  }

  showResults(r) {
    if (this.state !== 'play' && this.state !== 'train') return;
    this.state = 'results';
    this.hud.setMission(null);
    this.hud.show(false);
    this.menu.show('results', r);
  }

  // ---------------------------------------------------------- train mode
  beginTrain(index) {
    this.leaveFly();
    this.endTrain();
    this.audio.init();
    this.menu.hide();
    this.bigmap.show(false);
    this.missions.clear();
    this.missions.arrow.visible = false;
    this.state = 'train';
    this.pausedFrom = null;
    this.hud.show(true);
    this.input.clearActions();
    this.resumeTime = performance.now();
    this.playerModel.root.visible = false;
    this.car.vx = this.car.vz = this.car.vF = this.car.vR = this.car.yawRate = 0;
    this.trainMode.start(index);
    const r = this.trainMode.run;
    this.hud.toast(lineName(r.route.ref), 'W power · S brake · Space emergency · drag to look', 3600);
  }

  // Back to the car (safe to call any time).
  endTrain() {
    if (!this.trainMode.active) return;
    this.trainMode.stop();
    this.playerModel.root.visible = true;
    this.hud.setScore(null);
    this.chase.snap();
  }

  // Drag on the view to look around (car and train cameras); the view
  // eases back a moment after you let go.
  initDragLook(canvas) {
    let drag = null;
    const cam = () => (this.state === 'train' ? this.trainMode.camera : this.state === 'play' ? this.chase : null);
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !cam()) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const c = cam();
      if (c) c.drag((e.clientX - drag.x) * 0.0055, (e.clientY - drag.y) * 0.0045);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      this.chase.release();
      this.trainMode.camera.release();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
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
    const flying = this.state === 'fly' && !this.bigmap.open;
    const driving = this.state === 'train' && !this.bigmap.open;
    if (playing) this.updatePlay(dt);
    else if (flying) this.updateFly(dt);
    else if (driving) this.trainMode.update(dt, this.inputOverride && this.input.enabled ? { ...this.input.state, ...this.inputOverride } : this.input.state);
    else if (this.state === 'menu') this.updateAttract(dt);

    // City keeps moving behind the menus and while flying.
    const focus = this.focusPoint();
    if (this.state === 'menu' || playing || flying || driving) {
      this.traffic.update(dt, focus);
      this.trains.update(dt, focus);
      this.planes.update(dt, focus);
    }
    if (playing) {
      this.trains.collidePlayer(this.car);
      this.planes.collidePlayer(this.car);
      if (this.car.impact > this.frameImpact) this.frameImpact = this.car.impact;
      this.handleImpacts(dt);
      this.chase.lookBack = this.input.state.lookBack;
      this.chase.update(dt, this.car, this.collision);
    }
    if (this.trainMode.active && (driving || this.state === 'paused' || this.state === 'results')) {
      const t = this.trainMode.run.train, p = this.trains.sample(t, t.head, {});
      this.trainMode.camera.update(dt, this.trains, t, this.collision, p.y - this.map.terrain.h(p.x, p.z) < -4 && !this.world.openArea.at(p.x, p.z));
    }
    this.updatePlayerModel();
    this._focusV = (this._focusV || new THREE.Vector3()).set(focus.x, focus.y, focus.z);
    if (this.world.airport) updateLightMaterial(this.world.airport.lightMat, this.camera, this.renderer, this.scene.fog);
    if (this.planes.lightMat) updateLightMaterial(this.planes.lightMat, this.camera, this.renderer, this.scene.fog);
    this.sky.update(this.camera, this._focusV);
    this.updateHeadlight();
    this.updateVisibility(dt);
    this.signs.update(dt, focus.x, focus.z);
    updateLandmarks(this.world.landmarks, now / 1000);
    if (this.state === 'play' || this.state === 'paused' || this.state === 'results' || this.state === 'fly' || this.state === 'train') this.updateHUD(dt);
    if (this.bigmap.open) {
      const me = this.state === 'fly' ? { x: this.fly.x, z: this.fly.z, heading: this.fly.yaw } : this.trainMode.active ? this.trainMode.pose() : this.car;
      const ov = this.trainMode.active ? this.trainMode.overlays() : this.missions.overlays();
      this.bigmap.draw(me, { ...ov, cars: this.traffic.positions(), trains: this.trains.positions(), planes: this.planes.positions() });
    }
    this.audio.update(this.car, this.effectiveInput || this.input.state, playing && !this.sinking);
    const ear = this.state === 'fly' ? this.fly : this.trainMode.active ? this.trainMode.pose(this._ear || (this._ear = {})) : this.car;
    this.audio.setRumble(this.state === 'menu' ? 0 : this.trains.rumble(ear.x, ear.z) * (this.state === 'fly' ? Math.max(0, 1 - Math.max(0, this.fly.y) / 120) : 1));
    this.audio.setJet(this.state === 'menu' ? 0 : this.planes.noise(ear.x, ear.y ?? 0, ear.z));
    if (flying) this.audio.setWind(this.fly.speed);
    this.updateUnderground();
    this.renderer.render(this.scene, this.camera);
  }

  // Camera in a tunnel (below ground and not under an open cut): dim the
  // daylight, and draw the ground from below too, so a gap in the tunnel
  // shows earth rather than the city above (not near a cut, where the ground
  // over the opening would hide the sky).
  updateUnderground() {
    const p = this.camera.position, T = this.map.terrain, open = this.world.openArea;
    const depth = T.h(p.x, p.z) - p.y;
    const under = depth > (this.camUnder ? 1.5 : 2.5) && !open.at(p.x, p.z);
    if (under !== this.camUnder) { this.camUnder = under; this.sky.setUnderground(under); }
    const solid = under && !open.near(p.x, p.z, 60);
    const land = this.world.materials.land;
    if ((land.side === THREE.DoubleSide) !== solid) { land.side = solid ? THREE.DoubleSide : THREE.FrontSide; land.needsUpdate = true; }
  }

  handleActions() {
    const inp = this.input;
    const playing = this.state === 'play';
    if (inp.take('fullscreen')) {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    }
    if (inp.take('mute')) { this.setSetting('sound', !this.settings.sound); this.hud.toast(this.settings.sound ? 'Sound on' : 'Sound off', '', 1200); }
    const flying = this.state === 'fly';
    const driving = this.state === 'train';
    if (!playing && !flying && !driving) { inp.clearActions(); return; }
    if (inp.take('pause')) {
      if (performance.now() - (this.resumeTime || 0) < 250) return;
      if (this.bigmap.open) this.bigmap.show(false);
      else this.pause();
      return;
    }
    if (inp.take('map')) {
      const open = !this.bigmap.open;
      if (flying && open) this.fly.exit(); // release the mouse for the map
      const me = flying ? this.fly : driving ? this.trainMode.pose() : this.car;
      this.bigmap.show(open, me.x, me.z);
    }
    if (this.bigmap.open) { inp.clearActions(); return; }
    if (driving) {
      if (inp.take('camera')) this.hud.toast(this.trainMode.camera.cycle(), 'Camera', 1200);
      if (inp.take('time')) this.cycleTimeOfDay();
      if (inp.take('fly')) this.hud.toast('Fly mode is in Free Roam', 'Leave the train first (Esc)', 2000);
      inp.clearActions();
      return;
    }
    if (flying) {
      if (!this.fly.active) this.fly.active = true;
      if (inp.take('fly')) this.exitFly(false);
      else if (inp.take('confirm') || inp.take('reset')) this.exitFly(true);
      if (inp.take('time')) this.cycleTimeOfDay();
      inp.clearActions();
      return;
    }
    if (inp.take('fly')) {
      if (this.missions.mode === 'free') this.beginFly();
      else this.hud.toast('Fly mode is in Free Roam', 'Finish or quit the race first', 2000);
      inp.clearActions();
      return;
    }
    if (inp.take('camera')) { const name = this.chase.cycle(); this.hud.toast(name, 'Camera', 1200); }
    if (inp.take('reset')) { if (!(this.missions.race && !this.missions.race.started)) this.respawn(); }
    if (inp.take('time')) this.cycleTimeOfDay();
    inp.clearActions();
  }

  cycleTimeOfDay() {
    const i = PRESET_NAMES.indexOf(this.settings.tod);
    this.setSetting('tod', PRESET_NAMES[(i + 1) % PRESET_NAMES.length]);
    if (this.state === 'fly') this.sky.setFogBoost(Math.max(0, this.fly.y));
    this.hud.toast(this.settings.tod[0].toUpperCase() + this.settings.tod.slice(1), 'Time of day', 1400);
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
    } else if (!car.airborne && cw.isWater(car.x, car.z, car.y, car.onDeck)) {
      this.sinking = 0.001;
      this.audio.splash();
      this.hud.message('Splash!', 'Into the drink', 1500, '#7fc8ff');
    } else {
      const surf = cw.surfaceAt(car.x, car.z);
      if (surf & SURF.BLDG && car.y - cw.groundAt(car.x, car.z) > -1 && !car.onDeck) { this.stuckIn = (this.stuckIn || 0) + dt; if (this.stuckIn > 0.4) { this.stuckIn = 0; this.respawn(); } }
      else this.stuckIn = 0;
      this.safeTimer -= dt;
      if (this.safeTimer <= 0 && !car.airborne && (surf & SURF.ROAD || car.onDeck) && car.speed > 1.5) {
        this.safeTimer = 0.5;
        this.lastSafe = { x: car.x, z: car.z, h: car.heading, y: car.y };
      }
    }
    this.skids.update(car, !this.sinking && !car.airborne && (car.onDeck || !!(cw.surfaceAt(car.x, car.z) & (SURF.ROAD | SURF.PAVED))));
    this.missions.update(dt);
  }

  handleImpacts(dt) {
    this.impactCooldown -= dt;
    let imp = this.frameImpact || 0;
    if (this.car.landImpact > 6) { imp = Math.max(imp, this.car.landImpact * 0.8); this.car.landImpact = 0; }
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
    m.root.position.set(c.x, c.y + sinkY, c.z);
    m.root.rotation.set((this.sinking ? Math.min(0.25, this.sinking * 0.2) : 0) + c.slopePitch, -c.heading, c.slopeRoll, 'YXZ');
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
    this.carGlow.position.set(c.x - c.fx * 1.5, c.y + 4.2, c.z - c.fz * 1.5);
    if (!on) return;
    this.headlight.position.set(c.x + c.fx * 2.7, c.y + 0.75, c.z + c.fz * 2.7);
    this.headlight.target.position.set(c.x + c.fx * 24, c.y, c.z + c.fz * 24);
    this.headlight.target.updateMatrixWorld();
  }

  updateVisibility(dt) {
    const cam = this.camera.position;
    this.cullTimer -= dt;
    if (this.cullTimer <= 0) {
      this.cullTimer = 0.2;
      const draw = this.state === 'fly' ? Math.max(this.q.draw, this.sky.fogFar + 250) : Math.min(this.q.draw, this.sky.fogFar + 250);
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
    if (this.trainMode.active) {
      this.trainMode.hud(this.settings.metric);
      if (this.frame % 2 === 0 || this.fps > 50) {
        const p = this.trainMode.pose(this._pose || (this._pose = {}));
        const heading = this.trainMode.camera.mode === 0 ? p.heading + this.trainMode.camera.look.yaw : p.heading;
        this.minimap.draw(p.x, p.z, heading, this.trainMode.run.train.v, { ...this.trainMode.overlays(), cars: this.traffic.positions(), trains: this.trains.positions(), planes: this.planes.positions() });
      }
      return;
    }
    if (this.state === 'fly' || (this.state === 'paused' && this.pausedFrom === 'fly')) {
      const f = this.fly, metric = this.settings.metric;
      hud.setSpeed(f.speed, metric);
      hud.setGear('FLY');
      hud.setBoost(Math.log(f.base / 4) / Math.log(100), false);
      this.locTimer -= dt;
      if (this.locTimer <= 0) {
        this.locTimer = 0.25;
        const p = f.focus({});
        const T = this.map.terrain;
        this.updateLocation(0.25, p.x, p.z, f.y < T.h(f.x, f.z) - 2 ? f.y : T.h(p.x, p.z));
      }
      // Height above the ground under the camera.
      const above = f.y - this.map.terrain.h(f.x, f.z);
      const alt = metric ? `${Math.round(above)} m` : `${Math.round(above * 3.281)} ft`;
      hud.setMission({
        title: 'Fly mode', sub: `Altitude ${alt}`,
        extra: 'Click and move the mouse to look · WASD fly · Space/Q up and down · Shift fast · wheel speed<br>Enter drops the car here · G returns to the car · M map (click to jump)',
      });
      if (this.frame % 2 === 0 || this.fps > 50) {
        this.minimap.draw(f.x, f.z, f.yaw, Math.min(50, f.speed * 0.4), { ...this.missions.overlays(), cars: this.traffic.positions(), trains: this.trains.positions(), planes: this.planes.positions(), markers: [{ x: c.x, z: c.z, r: 6, color: '#ff4d5a', label: '' }] });
      }
      return;
    }
    hud.setSpeed(c.speed, this.settings.metric);
    hud.setGear(c.vF < -0.5 ? 'R' : this.audio.gear ? String(this.audio.gear) : 'D');
    hud.setBoost(c.boost, c.boosting);
    this.locTimer -= dt;
    if (this.locTimer <= 0) {
      this.locTimer = 0.25;
      this.updateLocation(0.25);
    }
    if (this.frame % 2 === 0 || this.fps > 50) {
      this.minimap.draw(c.x, c.z, this.chase.mode === 3 ? this.chase.heading : c.heading, c.speed, { ...this.missions.overlays(), cars: this.traffic.positions(), trains: this.trains.positions(), planes: this.planes.positions() });
    }
  }

  updateLocation(dt, x = this.car.x, z = this.car.z, y = this.car.y) {
    const c = { x, z, y }, map = this.map;
    const r = this.graph.nearestRoad3D(c.x, c.z, c.y, 30);
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
      state: this.state, mode: this.missions.mode, x: c.x, z: c.z, y: c.y, heading: c.heading, speed: c.speed, vF: c.vF, vR: c.vR,
      airborne: c.airborne, onDeck: c.onDeck, inCut: c.inCut,
      boost: c.boost, sinking: this.sinking, impact: this.frameImpact, fps: Math.round(this.fps), calls: info.calls, tris: info.triangles,
      street: this.hud.streetName.textContent, area: this.hud.streetArea.textContent, traffic: this.traffic.cars.length,
      race: this.missions.race ? { next: this.missions.race.next, time: this.missions.race.time, started: this.missions.race.started, done: this.missions.race.done } : null,
      taxi: this.missions.taxi ? { stage: this.missions.taxi.stage, money: this.missions.taxi.money, clock: this.missions.taxi.clock } : null,
      route: this.missions.route ? this.missions.route.length : 0,
      fly: this.state === 'fly' ? { x: this.fly.x, y: this.fly.y, z: this.fly.z, yaw: this.fly.yaw, speed: this.fly.speed } : null,
      trains: this.trains.trains.map((t) => ({ svc: t.svc.id, v: +t.v.toFixed(1), dwell: t.dwell > 0, cars: t.cars.length })),
      train: this.trainMode.active ? (() => {
        const r = this.trainMode.run, t = r.train, p = this.trains.sample(t, t.head, {});
        return { line: r.line.key, phase: r.phase, next: r.next, stops: r.stops.length, head: t.head, v: t.v, limit: r.limit, x: p.x, y: p.y, z: p.z, rel: p.y - this.map.terrain.h(p.x, p.z), results: r.results, overspeed: r.overspeed, trips: r.trips, mark: r.stops[r.next] ? r.stops[r.next].s : null, time: r.time };
      })() : null,
      planes: this.planes.stats(),
    };
  }
}

const game = new Game();
window.RB = { game };
game.init().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  const t = document.getElementById('load-text');
  t.textContent = 'Failed to start: ' + err.message + ' (serve this folder over http, e.g. python3 -m http.server)';
  t.style.color = '#ff8a8a';
});

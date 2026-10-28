// Game modes: free roam (landmark discovery + waypoints), checkpoint races
// and a timed taxi shift. Also owns GPS routing and 3D markers.

import * as THREE from 'three';
import { clamp, formatTime, formatDistance, loadJSON, saveJSON, mulberry32, wrapAngle } from './util.js';
import { RC } from './mapdata.js';

export const RACES = [
  {
    id: 'freedom', name: 'Freedom Trail Dash', blurb: 'Boston Common to Bunker Hill along the Freedom Trail.',
    stops: ['Boston Common', 'Massachusetts State House', 'Old State House', 'Faneuil Hall', 'Paul Revere House', 'Old North Church', 'USS Constitution', 'Bunker Hill Monument'],
  },
  {
    id: 'backbay', name: 'Back Bay Sprint', blurb: 'Public Garden to Fenway Park through Back Bay.',
    stops: ['Public Garden', 'Copley Square', 'Prudential Tower', 'Symphony Hall', 'Fenway Park'],
  },
  {
    id: 'river', name: 'Charles River Loop', blurb: 'Cross the Longfellow and Harvard bridges.',
    stops: ['Hatch Shell', 'Longfellow Bridge', 'Kendall Square', 'MIT', 'Harvard Bridge', 'Kenmore Square', 'Hatch Shell'],
  },
  {
    id: 'seaport', name: 'Seaport Shuffle', blurb: 'Waterfront blast around Fort Point and the Seaport.',
    stops: ['South Station', 'Tea Party Museum', 'Institute of Contemporary Art', 'Convention Center', "Children's Museum", 'New England Aquarium'],
  },
  {
    id: 'campus', name: 'Campus Crawl', blurb: 'Northeastern, BU and MIT via the museums and Fenway.',
    stops: ['Northeastern University', 'Museum of Fine Arts', 'Isabella Stewart Gardner Museum', 'Fenway Park', 'Boston University', 'MIT', 'Kendall Square'],
  },
  {
    id: 'garden', name: 'Garden to Garden', blurb: 'TD Garden to the Public Garden through downtown.',
    stops: ['TD Garden', 'Museum of Science', 'Mass General Hospital', 'City Hall', 'Chinatown Gate', 'Public Garden'],
  },
  {
    id: 'grand', name: 'The Grand Tour', blurb: 'An endurance run across the whole map.',
    stops: ['Fenway Park', 'Kenmore Square', 'Boston University', 'Harvard Bridge', 'Kendall Square', 'Longfellow Bridge', 'TD Garden', 'Bunker Hill Monument', 'Old North Church', 'New England Aquarium', 'South Station', 'Institute of Contemporary Art', 'Christian Science Plaza', 'Fenway Park'],
  },
];

const QUOTES = [
  'Fenway, and step on it!', "Take Storrow, it's wicked fast.", "Whatever you do, don't take the Pike.",
  "I'm late for the Sox game!", 'Can you avoid the Big Dig traffic?', 'Go around the rotary... twice if you have to.',
  'My Dunks is getting cold, kid.', "Pahk the cah anywhere close, I'll walk.", 'Just follow the Green Line, it never moves.',
  "Left on red? This is Boston, I won't tell.", "I've got a flight out of Logan in an hour!", 'Hurry, the Marathon starts soon!',
];

const MEDAL_SPEED = { gold: 16.5, silver: 13, bronze: 10 };
const CP_RADIUS = 13;

export class Missions {
  constructor(game) {
    this.g = game;
    this.mode = 'free';
    this.route = null;
    this.routeTarget = null;
    this.routeTimer = 0;
    this.discovered = new Set(loadJSON('rb.discovered', []));
    for (const l of game.map.landmarks) l.discovered = this.discovered.has(l.name);
    this.waypoint = null;
    this.landmarkByName = new Map(game.map.landmarks.map((l) => [l.name, l]));
    this.best = loadJSON('rb.best', {});
    this.taxiBest = loadJSON('rb.taxiBest', 0);
    this._buildMarkers();
    this.medalTimes = new Map();
  }

  // ------------------------------------------------------------ markers
  _buildMarkers() {
    const scene = this.g.scene;
    const beamMat = (color) => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; varying float vEdge;
        void main(){ vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vEdge = 1.0 - abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec2 vUv; varying float vEdge;
        void main(){
          float fade = pow(1.0 - vUv.y, 1.6);
          float edge = pow(vEdge, 2.5);
          float bands = 0.75 + 0.25 * sin(vUv.y * 60.0 - uTime * 5.0);
          float a = fade * (0.08 + 0.9 * edge) * bands;
          gl_FragColor = vec4(uColor * 1.4, a); }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
    });
    const make = (color, r) => {
      const g = new THREE.CylinderGeometry(r, r, 45, 48, 1, true);
      g.translate(0, 22.5, 0);
      const m = new THREE.Mesh(g, beamMat(color));
      m.renderOrder = 10;
      m.visible = false;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.6, r, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      ring.renderOrder = -20;
      m.add(ring);
      scene.add(m);
      return m;
    };
    this.markerNext = make(0xffc93c, CP_RADIUS);
    this.markerAfter = make(0x5ac8ff, CP_RADIUS * 0.6);
    this.markerAfter.material.uniforms.uColor.value.multiplyScalar(0.5);
    // Floating GPS arrow above the car.
    const arrow = new THREE.Group();
    const shape = new THREE.Shape();
    shape.moveTo(0, -1.6); shape.lineTo(1.1, 0.1); shape.lineTo(0.42, 0.1); shape.lineTo(0.42, 1.3);
    shape.lineTo(-0.42, 1.3); shape.lineTo(-0.42, 0.1); shape.lineTo(-1.1, 0.1); shape.closePath();
    const ag = new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false });
    ag.rotateX(Math.PI / 2);
    ag.translate(0, 0.15, 0);
    this.arrowMat = new THREE.MeshStandardMaterial({ color: 0xffc93c, emissive: 0xffa000, emissiveIntensity: 0.6, roughness: 0.4 });
    const am = new THREE.Mesh(ag, this.arrowMat);
    arrow.add(am);
    arrow.visible = false;
    scene.add(arrow);
    this.arrow = arrow;
  }

  _placeMarker(m, p, color) {
    if (!p) { m.visible = false; return; }
    m.visible = true;
    m.position.set(p.x, 0, p.z);
    if (color !== undefined) m.material.uniforms.uColor.value.setHex(color);
  }

  // ------------------------------------------------------------- routing
  setRouteTarget(x, z) {
    this.routeTarget = x == null ? null : { x, z };
    this.route = null;
    this.routeTimer = 0;
    if (this.routeTarget) this._updateRoute(0);
  }

  _updateRoute(dt) {
    const car = this.g.car;
    if (!this.routeTarget) { this.route = null; return; }
    this.routeTimer -= dt;
    let off = Infinity;
    if (this.route) {
      // Trim passed points and measure distance from the route.
      const r = this.route;
      let best = 0, bd = Infinity;
      for (let i = 0; i < Math.min(r.length - 1, 40); i++) {
        const d = distToSeg(car.x, car.z, r[i], r[i + 1]);
        if (d < bd) { bd = d; best = i; }
      }
      off = bd;
      if (best > 0) r.splice(0, best);
      if (r.length) r[0] = [car.x, car.z];
    }
    if ((off > 30 && this.routeTimer <= 0) || !this.route) {
      this.routeTimer = 1.2;
      const g = this.g.graph;
      const from = g.nearestNode(car.x, car.z, RC.SERVICE);
      const to = g.nearestNode(this.routeTarget.x, this.routeTarget.z, RC.LIVING, 400, true);
      const path = g.route(from, to);
      if (path) {
        this.route = [[car.x, car.z], ...path.map((n) => [g.nx(n), g.nz(n)]), [this.routeTarget.x, this.routeTarget.z]];
      } else this.route = [[car.x, car.z], [this.routeTarget.x, this.routeTarget.z]];
    }
  }

  routeRemaining() {
    if (!this.route) return 0;
    let s = 0;
    for (let i = 0; i + 1 < this.route.length; i++) s += Math.hypot(this.route[i + 1][0] - this.route[i][0], this.route[i + 1][1] - this.route[i][1]);
    return s;
  }

  // Point ~d meters ahead along the route (for the arrow).
  _routeAhead(d) {
    const r = this.route;
    if (!r || r.length < 2) return this.routeTarget ? [this.routeTarget.x, this.routeTarget.z] : null;
    let left = d;
    for (let i = 0; i + 1 < r.length; i++) {
      const L = Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]);
      if (L >= left) { const t = left / L; return [r[i][0] + (r[i + 1][0] - r[i][0]) * t, r[i][1] + (r[i + 1][1] - r[i][1]) * t]; }
      left -= L;
    }
    return r[r.length - 1];
  }

  // ------------------------------------------------------------- modes
  clear() {
    this.mode = 'free';
    this.race = null;
    this.taxi = null;
    this.setRouteTarget(null);
    this._placeMarker(this.markerNext, null);
    this._placeMarker(this.markerAfter, null);
    this.g.hud.setScore(null);
    this.g.hud.clearMessage();
    this.g.input.enabled = true;
  }

  startFree() {
    this.clear();
    if (this.waypoint) this.setRouteTarget(this.waypoint.x, this.waypoint.z);
  }

  setWaypoint(x, z, landmark) {
    if (this.mode !== 'free') return;
    this.waypoint = x == null ? null : { x, z, name: landmark ? landmark.name : null };
    this.setRouteTarget(this.waypoint ? x : null, this.waypoint ? z : null);
    if (this.waypoint) this.g.hud.toast(landmark ? landmark.name : 'Waypoint set', 'GPS', 2000);
  }

  stopPos(name) {
    const l = this.landmarkByName.get(name);
    if (!l) return null;
    const g = this.g.graph;
    let n = l.node;
    if (n < 0 || !g.inSCC[n]) n = g.nearestNode(l.x, l.z, RC.LIVING, 400, true);
    return { x: g.nx(n), z: g.nz(n), node: n, name };
  }

  // Precompute route length and medal times for a race.
  raceInfo(race) {
    if (this.medalTimes.has(race.id)) return this.medalTimes.get(race.id);
    const g = this.g.graph;
    const stops = race.stops.map((s) => this.stopPos(s)).filter(Boolean);
    let len = 0;
    for (let i = 0; i + 1 < stops.length; i++) {
      const p = g.route(stops[i].node, stops[i + 1].node);
      len += p ? g.pathLength(p) : Math.hypot(stops[i + 1].x - stops[i].x, stops[i + 1].z - stops[i].z) * 1.4;
    }
    const info = {
      length: len, stops,
      gold: len / MEDAL_SPEED.gold + 4, silver: len / MEDAL_SPEED.silver + 6, bronze: len / MEDAL_SPEED.bronze + 8,
    };
    this.medalTimes.set(race.id, info);
    return info;
  }

  medalFor(race, t) {
    const i = this.raceInfo(race);
    return t <= i.gold ? 'gold' : t <= i.silver ? 'silver' : t <= i.bronze ? 'bronze' : null;
  }

  startRace(id) {
    const race = RACES.find((r) => r.id === id);
    if (!race) return;
    this.clear();
    const info = this.raceInfo(race);
    const stops = info.stops;
    this.mode = 'race';
    this.race = { def: race, info, stops, next: 1, time: 0, countdown: 3.5, started: false, done: false, lastBeep: 4 };
    // Place car at the start pointing along the route to the first stop.
    const g = this.g.graph;
    const path = g.route(stops[0].node, stops[1].node) || [stops[0].node];
    let heading = 0;
    if (path.length > 1) heading = Math.atan2(g.nx(path[1]) - g.nx(path[0]), -(g.nz(path[1]) - g.nz(path[0])));
    this.g.placeCar(stops[0].x, stops[0].z, heading);
    this.g.input.enabled = false;
    this.setRouteTarget(stops[1].x, stops[1].z);
    this._showRaceMarkers();
    this.g.hud.toast(race.name, `Race · ${stops.length - 1} checkpoints · ${formatDistance(info.length, this.g.settings.metric)}`, 3200);
  }

  _showRaceMarkers() {
    const r = this.race;
    const last = r.next === r.stops.length - 1;
    this._placeMarker(this.markerNext, r.stops[r.next], last ? 0xff4d5a : 0xffc93c);
    this._placeMarker(this.markerAfter, r.stops[r.next + 1] || null);
  }

  startTaxi() {
    this.clear();
    this.mode = 'taxi';
    this.taxi = { clock: 60, money: 0, fares: 0, stage: 'pickup', pickup: null, drop: null, allotted: 0, fareTime: 0, crashes: 0, over: false, boardTimer: 0 };
    this._newFare();
    this.g.hud.toast('Taxi Shift', 'Pick up passengers · stop in the green zone', 3200);
  }

  _randomSpot(fromX, fromZ, minD, maxD, preferLandmark) {
    const g = this.g.graph, map = this.g.map;
    const rnd = Math.random;
    if (preferLandmark) {
      const cands = map.landmarks.filter((l) => { const d = Math.hypot(l.x - fromX, l.z - fromZ); return d > minD && d < maxD; });
      if (cands.length) {
        const l = cands[Math.floor(rnd() * cands.length)];
        const p = this.stopPos(l.name);
        if (p) return { ...p, label: l.name };
      }
    }
    for (let k = 0; k < 60; k++) {
      const a = rnd() * Math.PI * 2, d = minD + rnd() * (maxD - minD);
      const n = g.nearestNode(fromX + Math.sin(a) * d, fromZ - Math.cos(a) * d, RC.RESIDENTIAL, 200, true);
      if (n < 0) continue;
      const x = g.nx(n), z = g.nz(n);
      const dd = Math.hypot(x - fromX, z - fromZ);
      if (dd < minD * 0.8 || dd > maxD * 1.2) continue;
      const road = g.nearestRoad(x, z, 5);
      const name = road ? map.roads[road.road].name : '';
      return { x, z, node: n, label: name || 'the corner' };
    }
    return null;
  }

  _newFare() {
    const t = this.taxi, car = this.g.car;
    t.stage = 'pickup';
    t.pickup = this._randomSpot(car.x, car.z, 220, 750, Math.random() < 0.45);
    if (!t.pickup) t.pickup = this._randomSpot(car.x, car.z, 100, 1500, false);
    t.drop = null;
    this.setRouteTarget(t.pickup.x, t.pickup.z);
    this._placeMarker(this.markerNext, t.pickup, 0x4dff88);
    this._placeMarker(this.markerAfter, null);
  }

  // ------------------------------------------------------------- update
  update(dt) {
    const g = this.g, car = g.car, hud = g.hud;
    this.markerNext.material.uniforms.uTime.value += dt;
    this.markerAfter.material.uniforms.uTime.value += dt;
    // Landmark discovery in every mode.
    for (const l of g.map.landmarks) {
      if (l.discovered) continue;
      if (Math.abs(l.x - car.x) < 60 && Math.abs(l.z - car.z) < 60 && Math.hypot(l.x - car.x, l.z - car.z) < 55) {
        l.discovered = true;
        this.discovered.add(l.name);
        saveJSON('rb.discovered', [...this.discovered]);
        g.audio.discover();
        hud.toast(l.name, `Landmark discovered · ${this.discovered.size}/${g.map.landmarks.length}`, 3000);
      }
    }
    this._updateRoute(dt);
    if (this.mode === 'race') this._updateRace(dt);
    else if (this.mode === 'taxi') this._updateTaxi(dt);
    else this._updateFree();
    this._updateArrow(dt);
  }

  _updateFree() {
    const g = this.g;
    let extra = '';
    if (this.waypoint) {
      const d = Math.hypot(this.waypoint.x - g.car.x, this.waypoint.z - g.car.z);
      if (d < 25) {
        g.hud.toast(this.waypoint.name || 'Waypoint', 'Arrived', 2200);
        g.audio.checkpoint();
        this.setWaypoint(null);
      } else extra = `GPS · ${this.waypoint.name ? esc(this.waypoint.name) + ' · ' : ''}${formatDistance(this.routeRemaining(), g.settings.metric)}`;
    }
    this._placeMarker(this.markerNext, this.waypoint ? this.waypoint : null, 0xa35cff);
    g.hud.setMission({
      title: 'Free Roam',
      sub: `Landmarks discovered ${this.discovered.size}/${g.map.landmarks.length}`,
      extra: extra || 'Press M to open the map and set a waypoint',
    });
  }

  _updateRace(dt) {
    const r = this.race, g = this.g, hud = g.hud, car = g.car;
    if (r.done) return;
    if (!r.started) {
      r.countdown -= dt;
      const c = Math.ceil(r.countdown);
      if (c < r.lastBeep && c <= 3 && c >= 1) { r.lastBeep = c; hud.message(String(c), '', 800); g.audio.beep(false); }
      if (r.countdown <= 0) {
        r.started = true;
        g.input.enabled = true;
        hud.message('GO!', '', 900, '#7ee081');
        g.audio.beep(true);
      }
    } else r.time += dt;
    const target = r.stops[r.next];
    if (r.started && Math.hypot(car.x - target.x, car.z - target.z) < CP_RADIUS) {
      if (r.next === r.stops.length - 1) return this._finishRace();
      r.next++;
      g.audio.checkpoint();
      hud.message('Checkpoint', `${r.next - 1}/${r.stops.length - 1} · ${formatTime(r.time)}`, 1100, '#ffd447');
      this.setRouteTarget(r.stops[r.next].x, r.stops[r.next].z);
      this._showRaceMarkers();
    }
    const best = this.best[r.def.id];
    hud.setMission({
      title: `Race · ${r.def.name}`,
      sub: `Checkpoint ${r.next}/${r.stops.length - 1} · ${target.name}`,
      time: formatTime(r.time),
      extra: `<span class="medal gold"></span> ${formatTime(r.info.gold)} &nbsp; <span class="medal silver"></span> ${formatTime(r.info.silver)}` +
        (best ? ` &nbsp; Best ${formatTime(best)}` : '') + ` &nbsp; ${formatDistance(this.routeRemaining(), g.settings.metric)}`,
    });
  }

  _finishRace() {
    const r = this.race, g = this.g;
    r.done = true;
    const medal = this.medalFor(r.def, r.time);
    const prev = this.best[r.def.id];
    const record = !prev || r.time < prev;
    if (record) { this.best[r.def.id] = r.time; saveJSON('rb.best', this.best); }
    g.audio.finish();
    this._placeMarker(this.markerNext, null);
    this._placeMarker(this.markerAfter, null);
    this.setRouteTarget(null);
    g.hud.message('Finish!', `${formatTime(r.time)}${medal ? ' · ' + medal.toUpperCase() : ''}${record ? ' · NEW BEST' : ''}`, 2500, '#ffd447');
    setTimeout(() => {
      // Ignore if the player already moved on to something else.
      if (this.race === r && this.mode === 'race') g.showResults({ title: r.def.name, time: r.time, medal, record, prev, raceId: r.def.id });
    }, 1800);
  }

  _updateTaxi(dt) {
    const t = this.taxi, g = this.g, hud = g.hud, car = g.car;
    if (t.over) return;
    t.clock -= dt;
    t.fareTime += dt;
    if (g.car.impact > 6) t.crashes++;
    const target = t.stage === 'pickup' ? t.pickup : t.drop;
    const d = Math.hypot(car.x - target.x, car.z - target.z);
    if (d < 12 && car.speed < 3.5) {
      t.boardTimer += dt;
      if (t.boardTimer > 0.6) {
        t.boardTimer = 0;
        if (t.stage === 'pickup') {
          t.stage = 'drop';
          t.drop = this._randomSpot(car.x, car.z, 700, 2300, Math.random() < 0.7) || this._randomSpot(car.x, car.z, 300, 3000, false);
          const gr = g.graph;
          const p = gr.route(gr.nearestNode(car.x, car.z), t.drop.node);
          const len = p ? gr.pathLength(p) : Math.hypot(t.drop.x - car.x, t.drop.z - car.z) * 1.4;
          t.allotted = len / 13 + 8;
          t.tripLen = len;
          t.clock += t.allotted;
          t.fareTime = 0;
          t.crashes = 0;
          this.setRouteTarget(t.drop.x, t.drop.z);
          this._placeMarker(this.markerNext, t.drop, 0x5ac8ff);
          g.audio.checkpoint();
          hud.message(`To ${t.drop.label}`, `"${QUOTES[Math.floor(Math.random() * QUOTES.length)]}"`, 2600, '#7ee081');
        } else {
          const base = 3 + (t.tripLen / 1000) * 2.8;
          const spare = clamp((t.allotted - t.fareTime) / t.allotted, 0, 1);
          const tip = Math.max(0, base * 0.5 * spare - t.crashes * 1);
          const fare = base + tip;
          t.money += fare;
          t.fares++;
          t.clock += 6;
          g.audio.cash();
          hud.message(`+$${fare.toFixed(2)}`, tip > 0.5 ? `Tip $${tip.toFixed(2)}` : t.crashes ? 'No tip — rough ride' : 'Fare complete', 2000, '#7ee081');
          this._newFare();
        }
      }
    } else t.boardTimer = 0;
    if (t.clock <= 0) {
      t.over = true;
      t.clock = 0;
      g.audio.fail();
      const record = t.money > this.taxiBest;
      if (record) { this.taxiBest = t.money; saveJSON('rb.taxiBest', t.money); }
      this._placeMarker(this.markerNext, null);
      this.setRouteTarget(null);
      hud.message('Shift over', `$${t.money.toFixed(2)} · ${t.fares} fares`, 2500, '#ff6b6b');
      setTimeout(() => {
        if (this.taxi === t && this.mode === 'taxi') g.showResults({ title: 'Taxi Shift', money: t.money, fares: t.fares, record, taxi: true });
      }, 1800);
    }
    hud.setMission({
      title: 'Taxi Shift',
      sub: t.stage === 'pickup' ? `Pick up at ${t.pickup.label}` : `Drop off at ${t.drop.label}`,
      time: formatTime(t.clock),
      urgent: t.clock < 15,
      extra: `${formatDistance(this.routeRemaining(), g.settings.metric)} &nbsp; Stop in the zone to ${t.stage === 'pickup' ? 'pick up' : 'drop off'}`,
    });
    hud.setScore(`<div class="small">Fares ${t.fares}</div><div class="big">$${t.money.toFixed(2)}</div><div class="small">Best $${this.taxiBest.toFixed(2)}</div>`);
  }

  _updateArrow(dt) {
    const car = this.g.car;
    const show = !!this.routeTarget && this.g.settings.arrow !== false && !(this.race && !this.race.started);
    this.arrow.visible = show;
    if (!show) return;
    const p = this._routeAhead(28);
    if (!p) return;
    const ang = Math.atan2(p[0] - car.x, -(p[1] - car.z));
    const cur = this.arrow.userData.ang ?? ang;
    const na = cur + wrapAngle(ang - cur) * Math.min(1, dt * 8);
    this.arrow.userData.ang = na;
    // Hover just ahead of the roof, tilted toward the chase camera.
    this.arrow.position.set(car.x + car.fx * 2.2, 2.25 + Math.sin(performance.now() / 300) * 0.08, car.z + car.fz * 2.2);
    this.arrow.rotation.set(0, -na, 0, 'YXZ');
    this.arrow.rotateX(0.55);
    const col = this.mode === 'taxi' ? (this.taxi.stage === 'pickup' ? 0x4dff88 : 0x5ac8ff) : this.mode === 'free' ? 0xa35cff : 0xffc93c;
    this.arrowMat.color.setHex(col);
    this.arrowMat.emissive.setHex(col);
  }

  // Overlay data for minimap / big map.
  overlays() {
    const o = { route: this.route, markers: [], routeColor: '#a35cff' };
    if (this.mode === 'race' && this.race && !this.race.done) {
      const r = this.race;
      o.routeColor = '#ffc93c';
      for (let i = r.next; i < r.stops.length; i++) {
        const last = i === r.stops.length - 1;
        o.markers.push({ x: r.stops[i].x, z: r.stops[i].z, r: i === r.next ? 9 : 6, color: last ? '#ff4d5a' : i === r.next ? '#ffc93c' : '#5ac8ff', label: String(i), edge: i === r.next });
      }
    } else if (this.mode === 'taxi' && this.taxi && !this.taxi.over) {
      const t = this.taxi;
      const p = t.stage === 'pickup' ? t.pickup : t.drop;
      o.routeColor = t.stage === 'pickup' ? '#4dff88' : '#5ac8ff';
      o.markers.push({ x: p.x, z: p.z, r: 9, color: o.routeColor, label: t.stage === 'pickup' ? '+' : '$', edge: true });
    } else if (this.waypoint) {
      o.markers.push({ x: this.waypoint.x, z: this.waypoint.z, r: 8, color: '#a35cff', edge: true });
    }
    return o;
  }
}

function distToSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

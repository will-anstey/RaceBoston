// DOM HUD, rotating minimap and the full-screen map.

import { clamp, formatTime } from './util.js';
import { AREA, RC } from './mapdata.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.root = $('hud');
    this.speedEl = $('speed');
    this.unitEl = $('unit');
    this.gearEl = $('gear');
    this.streetName = document.querySelector('#street .s-name');
    this.streetArea = document.querySelector('#street .s-area');
    this.toastEl = $('toast');
    this.centerEl = $('center-msg');
    this.missionEl = $('mission');
    this.scoreEl = $('score');
    this.boostEl = $('boost');
    this.boostFill = $('boost-fill');
    this.hintEl = $('hint');
    this._cache = {};
    this._toastTimer = 0;
    this._msgTimer = 0;
  }

  _set(key, el, prop, value) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    el[prop] = value;
  }

  show(on) { this.root.classList.toggle('hidden', !on); }

  setSpeed(mps, metric) {
    this._set('speed', this.speedEl, 'textContent', String(Math.round(Math.abs(mps) * (metric ? 3.6 : 2.23694))));
    this._set('unit', this.unitEl, 'textContent', metric ? 'KM/H' : 'MPH');
  }
  setGear(g) { this._set('gear', this.gearEl, 'textContent', g); }
  setBoost(v, active) {
    this.boostFill.style.width = (clamp(v, 0, 1) * 100).toFixed(1) + '%';
    this.boostEl.classList.toggle('active', !!active);
  }
  setStreet(name, area) {
    this._set('street', this.streetName, 'textContent', name || '');
    this._set('area', this.streetArea, 'textContent', area || '');
  }

  toast(text, sub = '', ms = 2800) {
    this.toastEl.innerHTML = (sub ? `<small>${esc(sub)}</small>` : '') + esc(text);
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  message(text, sub = '', ms = 1600, color = '') {
    const el = this.centerEl;
    el.innerHTML = esc(text) + (sub ? `<span class="sub">${esc(sub)}</span>` : '');
    el.style.color = color;
    el.classList.toggle('long', text.length > 12);
    el.classList.remove('show', 'fade');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._msgTimer);
    if (ms > 0) this._msgTimer = setTimeout(() => { el.classList.remove('show'); el.classList.add('fade'); }, ms);
  }
  clearMessage() { clearTimeout(this._msgTimer); this.centerEl.classList.remove('show'); this.centerEl.classList.add('fade'); }

  setMission(m) {
    if (!m) { this.missionEl.classList.add('hidden'); this._cache.mkey = null; return; }
    this.missionEl.classList.remove('hidden');
    const q = (s) => this.missionEl.querySelector(s);
    this._set('mt', q('.m-title'), 'textContent', m.title || '');
    this._set('ms', q('.m-sub'), 'textContent', m.sub || '');
    this._set('mtime', q('.m-time'), 'textContent', m.time || '');
    this._set('mx', q('.m-extra'), 'innerHTML', m.extra || '');
    q('.m-time').classList.toggle('urgent', !!m.urgent);
    q('.m-time').style.display = m.time ? '' : 'none';
  }

  setScore(html) {
    if (!html) { this.scoreEl.classList.add('hidden'); this._cache.score = null; return; }
    this.scoreEl.classList.remove('hidden');
    this._set('score', this.scoreEl, 'innerHTML', html);
  }

  fadeHint() { setTimeout(() => (this.hintEl.style.opacity = '0'), 12000); }
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ------------------------------------------------------------- map art
const COLORS = {
  water: '#1d4a73', land: '#353c49', green: '#2f5236', paved: '#3f4654', building: '#4b5262',
  roadCase: '#20252e', motorway: '#e5a446', trunk: '#e8bf5a', primary: '#d9dee8', minor: '#9aa3b4', service: '#6c7586',
  rail: '#5d6373', path: '#56606f',
};
const GREEN_AREAS = new Set([AREA.PARK, AREA.GRASS, AREA.PITCH, AREA.GOLF, AREA.CEMETERY, AREA.WOOD, AREA.GARDEN, AREA.WETLAND, AREA.PLAYGROUND]);

export class MapArt {
  constructor(map, graph) {
    this.map = map;
    this.graph = graph;
    const b = (this.b = map.meta.play);
    this.mpp = 2.5;
    this.W = Math.ceil((b.maxX - b.minX) / this.mpp);
    this.H = Math.ceil((b.maxZ - b.minZ) / this.mpp);
    this.base = document.createElement('canvas');
    this.base.width = this.W;
    this.base.height = this.H;
    this._draw();
  }

  _poly(ctx, rings) {
    const { b, mpp } = this;
    ctx.beginPath();
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        const x = (r[i] - b.minX) / mpp, y = (r[i + 1] - b.minZ) / mpp;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
  }

  _draw() {
    const ctx = this.base.getContext('2d');
    const { map, b, mpp } = this;
    ctx.fillStyle = COLORS.water;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.fillStyle = COLORS.land;
    for (const p of map.land) { this._poly(ctx, p); ctx.fill('evenodd'); }
    for (const a of map.areas) {
      if (a.type === AREA.PIER) continue;
      ctx.fillStyle = GREEN_AREAS.has(a.type) ? COLORS.green : COLORS.paved;
      this._poly(ctx, a.rings); ctx.fill('evenodd');
    }
    ctx.fillStyle = COLORS.water;
    for (const p of map.water) { this._poly(ctx, p); ctx.fill('evenodd'); }
    ctx.fillStyle = COLORS.paved;
    for (const a of map.areas) if (a.type === AREA.PIER) { this._poly(ctx, a.rings); ctx.fill('evenodd'); }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const line = (pts, w, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = w;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const x = (pts[i] - b.minX) / mpp, y = (pts[i + 1] - b.minZ) / mpp;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    };
    for (const p of map.piers) line(p.pts, p.width / mpp, COLORS.paved);
    for (const p of map.paths) line(p.pts, Math.max(0.6, p.width / mpp), COLORS.path);
    for (const r of map.rail) line(r.pts, 1.2, COLORS.rail);
    ctx.fillStyle = COLORS.building;
    for (const bd of map.buildings) { if (bd.hidden) continue; this._poly(ctx, bd.rings); ctx.fill('evenodd'); }
    const nodes = map.nodes;
    const rp = (r) => { const a = new Float32Array(r.nodes.length * 2); r.nodes.forEach((n, i) => { a[2 * i] = nodes[2 * n]; a[2 * i + 1] = nodes[2 * n + 1]; }); return a; };
    // Tunnels first (dashed, under everything), then surface roads, then raised decks on top.
    const maxY = (r) => { let m = 0; for (const n of r.nodes) m = Math.max(m, map.nodeY[n]); return m; };
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.globalAlpha = 0.55;
    for (const r of map.roads) if (r.tunnel) line(rp(r), Math.max(1.5, r.width / mpp * 0.7), roadColor(r.cls));
    ctx.restore();
    const roads = map.roads.filter((r) => !r.tunnel).sort((a, c) => (maxY(a) > 1) - (maxY(c) > 1) || c.cls - a.cls);
    for (const r of roads) line(rp(r), (r.width + 2) / mpp, COLORS.roadCase);
    for (const r of roads) line(rp(r), r.width / mpp, roadColor(r.cls));
  }
}

function roadColor(cls) {
  return cls === RC.MOTORWAY ? COLORS.motorway : cls === RC.TRUNK ? COLORS.trunk : cls <= RC.SECONDARY ? COLORS.primary : cls <= RC.LIVING ? COLORS.minor : COLORS.service;
}

// Draws a marker/route overlay set in world coordinates on a transformed ctx.
function drawOverlays(ctx, o, pxPerM, rot) {
  if (o.route && o.route.length > 1) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(20,24,34,0.9)';
    ctx.lineWidth = 9 / pxPerM;
    ctx.beginPath();
    o.route.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.strokeStyle = o.routeColor || '#a35cff';
    ctx.lineWidth = 5.5 / pxPerM;
    ctx.stroke();
  }
  const dot = (x, z, r, fill, stroke, label) => {
    ctx.beginPath();
    ctx.arc(x, z, r / pxPerM, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.lineWidth = 2 / pxPerM; ctx.strokeStyle = stroke; ctx.stroke(); }
    if (label) {
      ctx.save();
      ctx.translate(x, z);
      ctx.rotate(rot);
      ctx.scale(1 / pxPerM, 1 / pxPerM);
      ctx.font = '700 11px Inter, Segoe UI, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#0b1220';
      ctx.fillText(label, 0, 0.5);
      ctx.restore();
    }
  };
  for (const c of o.cars || []) dot(c[0], c[1], 2.2, '#c7cfdd');
  for (const m of o.markers || []) dot(m.x, m.z, m.r || 6, m.color || '#ffd447', m.stroke ?? '#0b1220', m.label);
}

export class Minimap {
  constructor(canvas, art) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.art = art;
    this.radius = 170;
  }

  draw(px, pz, heading, speed, overlays) {
    const ctx = this.ctx, size = this.canvas.width;
    const { art } = this;
    const b = art.b, mpp = art.mpp;
    const targetR = 150 + clamp(speed, 0, 50) * 3.2;
    this.radius += (targetR - this.radius) * 0.05;
    const R = this.radius;
    const s = size / (2 * R);
    ctx.save();
    ctx.fillStyle = COLORS.water;
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-heading);
    ctx.scale(s, s);
    ctx.translate(-px, -pz);
    // Base image (clamped source rect).
    const E = R * 1.5;
    let x0 = px - E, z0 = pz - E, x1 = px + E, z1 = pz + E;
    x0 = Math.max(x0, b.minX); z0 = Math.max(z0, b.minZ); x1 = Math.min(x1, b.maxX); z1 = Math.min(z1, b.maxZ);
    if (x1 > x0 && z1 > z0) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(art.base, (x0 - b.minX) / mpp, (z0 - b.minZ) / mpp, (x1 - x0) / mpp, (z1 - z0) / mpp, x0, z0, x1 - x0, z1 - z0);
    }
    // Crisp vector roads on top.
    const g = art.graph, sg = g.segGrid, segs = sg.segs, roads = art.map.roads;
    const n = sg.query(px, pz, E);
    ctx.lineCap = 'round';
    const passes = [[RC.SERVICE, RC.SERVICE, COLORS.service], [RC.TERTIARY, RC.LIVING, COLORS.minor], [RC.PRIMARY, RC.SECONDARY, COLORS.primary], [RC.TRUNK, RC.TRUNK, COLORS.trunk], [RC.MOTORWAY, RC.MOTORWAY, COLORS.motorway]];
    // Tunnels: dashed, only near the player.
    ctx.save();
    ctx.setLineDash([4 / s, 3 / s]);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const i = sg.result[k];
      if (!roads[sg.meta[i]].tunnel) continue;
      ctx.moveTo(segs[4 * i], segs[4 * i + 1]);
      ctx.lineTo(segs[4 * i + 2], segs[4 * i + 3]);
    }
    ctx.strokeStyle = COLORS.trunk;
    ctx.lineWidth = Math.max(5, 2.2 / s);
    ctx.stroke();
    ctx.restore();
    for (const [c0, c1, color] of passes) {
      ctx.beginPath();
      let w = 0;
      for (let k = 0; k < n; k++) {
        const i = sg.result[k];
        const r = roads[sg.meta[i]];
        if (r.cls < c0 || r.cls > c1 || r.tunnel) continue;
        w = Math.max(w, r.width);
        ctx.moveTo(segs[4 * i], segs[4 * i + 1]);
        ctx.lineTo(segs[4 * i + 2], segs[4 * i + 3]);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(w, 2.2 / s);
      ctx.stroke();
    }
    drawOverlays(ctx, overlays, s, heading);
    ctx.restore();
    // Off-screen target arrows on the rim.
    for (const m of overlays.markers || []) {
      if (!m.edge) continue;
      const dx = m.x - px, dz = m.z - pz;
      const d = Math.hypot(dx, dz);
      if (d * s < size / 2 - 14) continue;
      const ang = Math.atan2(dx, -dz) - heading;
      const rr = size / 2 - 14;
      const ex = size / 2 + Math.sin(ang) * rr, ey = size / 2 - Math.cos(ang) * rr;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(0, -11); ctx.lineTo(9, 7); ctx.lineTo(-9, 7); ctx.closePath();
      ctx.fillStyle = m.color || '#ffd447';
      ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    // Player arrow.
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.beginPath();
    ctx.moveTo(0, -15); ctx.lineTo(11, 12); ctx.lineTo(0, 6); ctx.lineTo(-11, 12); ctx.closePath();
    ctx.fillStyle = '#ff4d5a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.stroke(); ctx.fill();
    ctx.restore();
    // North marker.
    const na = -heading, nr = size / 2 - 22;
    const nx = size / 2 + Math.sin(na) * nr, ny = size / 2 - Math.cos(na) * nr;
    ctx.beginPath(); ctx.arc(nx, ny, 15, 0, Math.PI * 2); ctx.fillStyle = 'rgba(10,16,28,0.85)'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '800 17px Inter, Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 1);
  }
}

export class BigMap {
  constructor(root, canvas, art, landmarks) {
    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.art = art;
    this.landmarks = landmarks;
    this.open = false;
    this.zoom = 1;
    this.cx = 0; this.cz = 0;
    this.onPick = null;
    this.onClear = null;
    let drag = null;
    // Pointer coordinates are CSS pixels; the canvas is DPR-scaled.
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = this.dpr || 1;
      const [wx, wz] = this.toWorld(e.offsetX * k, e.offsetY * k);
      this.zoom = clamp(this.zoom * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 0.6, 12);
      const [nx, nz] = this.toWorld(e.offsetX * k, e.offsetY * k);
      this.cx += wx - nx; this.cz += wz - nz;
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false, button: e.button }; });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      const s = this.scale() / (this.dpr || 1);
      this.cx = drag.cx - dx / s; this.cz = drag.cz - dy / s;
    });
    window.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.moved || !this.open) return;
      const rect = canvas.getBoundingClientRect();
      const k = this.dpr || 1;
      const [wx, wz] = this.toWorld((e.clientX - rect.left) * k, (e.clientY - rect.top) * k);
      if (d.button === 2) this.onClear?.();
      else {
        // Snap to a nearby landmark if the click is close to one.
        let pick = null, bd = Math.max(40, (24 * k) / this.scale());
        for (const l of this.landmarks) { const dd = Math.hypot(l.x - wx, l.z - wz); if (dd < bd) { bd = dd; pick = l; } }
        this.onPick?.(pick ? pick.x : wx, pick ? pick.z : wz, pick);
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  scale() {
    const b = this.art.b;
    const fit = Math.min(this.canvas.width / (b.maxX - b.minX), this.canvas.height / (b.maxZ - b.minZ));
    return fit * this.zoom;
  }
  toWorld(sx, sy) {
    const s = this.scale();
    return [this.cx + (sx - this.canvas.width / 2) / s, this.cz + (sy - this.canvas.height / 2) / s];
  }

  show(on, px, pz) {
    this.open = on;
    this.root.classList.toggle('hidden', !on);
    if (on) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.floor(window.innerWidth * dpr);
      this.canvas.height = Math.floor(window.innerHeight * dpr);
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.dpr = dpr;
      this.zoom = 2.2;
      this.cx = px; this.cz = pz;
    }
  }

  draw(player, overlays) {
    if (!this.open) return;
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    const { art } = this, b = art.b, s = this.scale();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0f1b';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, W / 2 - this.cx * s, H / 2 - this.cz * s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(art.base, b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);
    drawOverlays(ctx, overlays, s, 0);
    // landmarks
    ctx.font = `600 ${12 / s * (this.dpr || 1)}px Inter, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    for (const l of this.landmarks) {
      ctx.beginPath();
      ctx.arc(l.x, l.z, 4.5 * (this.dpr || 1) / s, 0, Math.PI * 2);
      ctx.fillStyle = l.discovered ? '#ffd447' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.5 / s; ctx.strokeStyle = '#0b1220'; ctx.stroke();
      if (this.zoom > 1.6) {
        ctx.lineWidth = 3 * (this.dpr || 1) / s;
        ctx.strokeStyle = 'rgba(8,12,22,0.85)';
        ctx.strokeText(l.name, l.x, l.z - 9 * (this.dpr || 1) / s);
        ctx.fillStyle = '#e9eef7';
        ctx.fillText(l.name, l.x, l.z - 9 * (this.dpr || 1) / s);
      }
    }
    // player
    ctx.save();
    ctx.translate(player.x, player.z);
    ctx.rotate(player.heading);
    const k = (this.dpr || 1) / s;
    ctx.scale(k, k);
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(10, 11); ctx.lineTo(0, 5); ctx.lineTo(-10, 11); ctx.closePath();
    ctx.fillStyle = '#ff4d5a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }
}

export { formatTime };

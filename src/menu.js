// Main / pause / race / settings / results menus (DOM).

import { RACES } from './missions.js';
import { formatTime, formatDistance } from './util.js';
import { esc } from './hud.js';
import { trainLines } from './trainmode.js';
import { LINE_COLOR } from './railworld.js';

export const CARS = [
  { id: 'coupe', model: 'coupe', handling: 'coupe', name: 'Sports Coupe', color: 0xc8102e, desc: '200 mph flat out, 0-60 in 3.3 s. Loves the Pike.' },
  { id: 'taxi', model: 'taxi', handling: 'taxi', name: 'Boston Cab', color: 0xf2c12e, desc: 'Balanced. Knows every shortcut.' },
  { id: 'suv', model: 'suv', handling: 'suv', name: 'Townie SUV', color: 0x1f3d6e, desc: 'Heavy and stable. Wins every merge.' },
];

const SETTINGS = [
  { key: 'quality', label: 'Graphics', values: ['low', 'medium', 'high', 'ultra'], names: ['Low', 'Medium', 'High', 'Ultra'] },
  { key: 'traffic', label: 'Traffic', values: [0, 12, 26, 40], names: ['Off', 'Light', 'Normal', 'Heavy'] },
  { key: 'trains', label: 'Trains', values: [0, 1, 2, 3, 4], names: ['Off', 'Few', 'Normal', 'Many', 'Max'] },
  { key: 'planes', label: 'Planes', values: [0, 1, 2, 3, 4], names: ['Off', 'Few', 'Normal', 'Many', 'Max (very busy)'] },
  { key: 'tod', label: 'Time of day', values: ['day', 'sunset', 'night'], names: ['Day', 'Sunset', 'Night'] },
  { key: 'metric', label: 'Units', values: [false, true], names: ['Imperial (mph)', 'Metric (km/h)'] },
  { key: 'sound', label: 'Sound', values: [true, false], names: ['On', 'Off'] },
  { key: 'arrow', label: 'GPS arrow', values: [true, false], names: ['On', 'Off'] },
  { key: 'labels', label: 'Landmark labels', values: [true, false], names: ['On', 'Off'] },
];

export class Menu {
  constructor(game) {
    this.g = game;
    this.el = document.getElementById('menu');
    this.open = false;
    this.screen = null;
    this.stack = [];
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      this.g.audio.init();
      this._act(b.dataset.act, b.dataset.arg);
    });
    this.el.addEventListener('mousemove', (e) => {
      const b = e.target.closest('.menu-btn');
      if (b) this._select([...this.el.querySelectorAll('.menu-btn')].indexOf(b));
    });
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      const btns = [...this.el.querySelectorAll('.menu-btn')];
      if (!btns.length) return;
      if (e.code === 'ArrowDown' || e.code === 'KeyS') { this._select((this.sel + 1) % btns.length); e.preventDefault(); }
      else if (e.code === 'ArrowUp' || e.code === 'KeyW') { this._select((this.sel - 1 + btns.length) % btns.length); e.preventDefault(); }
      else if (e.code === 'Enter' || e.code === 'Space') { btns[this.sel]?.click(); e.preventDefault(); }
      else if (e.code === 'Escape' || e.code === 'Backspace') { this.back(); e.preventDefault(); }
    });
    this._padPrev = {};
  }

  // Gamepad navigation while the menu is open.
  pollPad() {
    if (!this.open || !navigator.getGamepads) return;
    const gp = [...navigator.getGamepads()].find((p) => p && p.connected);
    if (!gp) return;
    const btns = [...this.el.querySelectorAll('.menu-btn')];
    const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
    const edge = (name, v) => { const was = this._padPrev[name]; this._padPrev[name] = v; return v && !was; };
    const ay = gp.axes[1] || 0;
    if (edge('down', pressed(13) || ay > 0.6)) this._select((this.sel + 1) % btns.length);
    if (edge('up', pressed(12) || ay < -0.6)) this._select((this.sel - 1 + btns.length) % btns.length);
    if (edge('a', pressed(0))) btns[this.sel]?.click();
    if (edge('b', pressed(1))) this.back();
  }

  _select(i) {
    const btns = [...this.el.querySelectorAll('.menu-btn')];
    btns.forEach((b, k) => b.classList.toggle('sel', k === i));
    this.sel = i;
  }

  show(screen, data, push = true) {
    if (screen === 'main' || screen === 'pause' || screen === 'results') this.stack = [];
    else if (push && this.screen && this.screen !== screen && this.screen !== 'results') this.stack.push(this.screen);
    this.screen = screen;
    this.data = data;
    this.open = true;
    this.el.classList.remove('hidden');
    this.el.innerHTML = `<div class="menu-inner">${this[`_${screen}`](data)}</div>`;
    this._select(0);
  }

  hide() {
    this.open = false;
    this.screen = null;
    this.stack = [];
    this.el.classList.add('hidden');
  }

  back() {
    if (this.screen === 'main' || this.screen === 'results') return;
    if (this.screen === 'pause') { this._act('resume'); return; }
    const prev = this.stack.pop();
    if (prev) this.show(prev, this.data, false);
    else this._act(this.g.state === 'paused' ? 'resume' : 'home');
  }

  _act(act, arg) {
    const g = this.g;
    switch (act) {
      case 'free': g.begin('free'); break;
      case 'fly': g.beginFly(); break;
      case 'lines': this.show('lines'); break;
      case 'train': g.beginTrain(+arg); break;
      case 'races': this.show('races'); break;
      case 'race': g.begin('race', arg); break;
      case 'taxi': g.begin('taxi'); break;
      case 'garage': this.show('garage'); break;
      case 'car': g.selectCar(arg); this.show('garage', null, false); break;
      case 'settings': this.show('settings'); break;
      case 'controls': this.show('controls'); break;
      case 'set': {
        const s = SETTINGS.find((x) => x.key === arg);
        const i = s.values.indexOf(g.settings[s.key]);
        g.setSetting(s.key, s.values[(i + 1) % s.values.length]);
        const sel = this.sel;
        this.show('settings', null, false);
        this._select(sel);
        break;
      }
      case 'resume': g.resume(); break;
      case 'restart': g.restart(); break;
      case 'home': g.toMenu(); break;
      case 'back': this.back(); break;
      case 'retry': g.restart(); break;
      case 'next': {
        const i = RACES.findIndex((r) => r.id === arg);
        g.begin('race', RACES[(i + 1) % RACES.length].id);
        break;
      }
    }
  }

  _main() {
    const g = this.g;
    const car = CARS.find((c) => c.id === g.settings.car) || CARS[0];
    const golds = RACES.filter((r) => g.missions.best[r.id] && g.missions.medalFor(r, g.missions.best[r.id]) === 'gold').length;
    return `
      <div class="brand"><div class="brand-top">RACE</div><div class="brand-bottom">BOSTON</div></div>
      <p class="tagline">Drive the real streets of Boston, built from OpenStreetMap: ${g.map.buildings.length.toLocaleString()} buildings, ${g.map.roads.length.toLocaleString()} roads, the Charles, the harbor and every one-way street.</p>
      <div class="menu-list">
        <button class="menu-btn primary" data-act="free"><span>Free Roam<span class="desc">Explore and discover ${g.map.landmarks.length} landmarks (${g.missions.discovered.size} found)</span></span><span class="meta">&#9654;</span></button>
        <button class="menu-btn" data-act="fly"><span>Fly Around<span class="desc">Ghost camera: fly anywhere, through anything</span></span><span class="meta">&#9654;</span></button>
        <button class="menu-btn" data-act="lines"><span>Drive a Train<span class="desc">Red, Orange, Blue and Green Lines and the commuter rail, through the subway</span></span><span class="meta">&#9656;</span></button>
        <button class="menu-btn" data-act="races"><span>Races<span class="desc">${RACES.length} checkpoint races &middot; ${golds} gold</span></span><span class="meta">&#9656;</span></button>
        <button class="menu-btn" data-act="taxi"><span>Taxi Shift<span class="desc">Best shift $${g.missions.taxiBest.toFixed(2)}</span></span><span class="meta">&#9656;</span></button>
        <button class="menu-btn" data-act="garage"><span>Garage<span class="desc">${esc(car.name)}</span></span><span class="meta">&#9656;</span></button>
        <button class="menu-btn" data-act="settings"><span>Settings</span><span class="meta">&#9656;</span></button>
        <button class="menu-btn" data-act="controls"><span>Controls</span><span class="meta">&#9656;</span></button>
      </div>
      <div class="small-print">Map data &copy; OpenStreetMap contributors (ODbL). Elevation: USGS 3DEP. Keyboard, gamepad and touch supported.</div>`;
  }

  _races() {
    const m = this.g.missions, metric = this.g.settings.metric;
    const rows = RACES.map((r) => {
      const info = m.raceInfo(r);
      const best = m.best[r.id];
      const medal = best ? m.medalFor(r, best) : null;
      return `<button class="menu-btn" data-act="race" data-arg="${r.id}"><span>${esc(r.name)}<span class="desc">${esc(r.blurb)} &middot; ${formatDistance(info.length, metric)} &middot; gold ${formatTime(info.gold)}</span></span>
        <span class="meta">${best ? formatTime(best) : '--:--'}<span class="medal ${medal || 'none'}"></span></span></button>`;
    }).join('');
    return `<div class="menu-title">Races</div><div class="menu-list">${rows}<button class="menu-btn back" data-act="back"><span>&larr; Back</span></button></div>`;
  }

  _lines() {
    const g = this.g, metric = g.settings.metric, best = g.trainMode.best;
    const rows = trainLines(g.map).map((l) => {
      const b = best[l.key];
      return `<button class="menu-btn" data-act="train" data-arg="${l.i}"><span><span class="line-dot" style="background:${LINE_COLOR[l.svc]}"></span>${esc(l.title)}<span class="desc">${esc(l.from)} &rarr; ${esc(l.to)} &middot; ${l.stops} stops &middot; ${formatDistance(l.len, metric)}</span></span>
        <span class="meta">${b ? `Best ${b.score}` : '&#9654;'}</span></button>`;
    }).join('');
    return `<div class="menu-title">Drive a Train</div>
      <p class="tagline">W power &middot; S brake &middot; Space emergency brake &middot; stop with the train along the platform &middot; drag to look around</p>
      <div class="menu-list">${rows}<button class="menu-btn back" data-act="back"><span>&larr; Back</span></button></div>`;
  }

  _garage() {
    const cur = this.g.settings.car;
    const rows = CARS.map((c) => `<button class="menu-btn${c.id === cur ? ' primary' : ''}" data-act="car" data-arg="${c.id}"><span>${esc(c.name)}<span class="desc">${esc(c.desc)}</span></span><span class="meta">${c.id === cur ? 'Selected' : ''}</span></button>`).join('');
    return `<div class="menu-title">Garage</div><div class="menu-list">${rows}<button class="menu-btn back" data-act="back"><span>&larr; Back</span></button></div>`;
  }

  _settings() {
    const st = this.g.settings;
    const rows = SETTINGS.map((s) => {
      const i = Math.max(0, s.values.indexOf(st[s.key]));
      return `<button class="menu-btn" data-act="set" data-arg="${s.key}"><span>${s.label}</span><span class="meta">${s.names[i]}</span></button>`;
    }).join('');
    return `<div class="menu-title">Settings</div><div class="menu-list">${rows}<button class="menu-btn back" data-act="back"><span>&larr; Back</span></button></div>`;
  }

  _controls() {
    const rows = [
      ['W / &uarr;', 'Accelerate'], ['S / &darr;', 'Brake / reverse'], ['A D / &larr; &rarr;', 'Steer'],
      ['Space', 'Handbrake (drift)'], ['Shift', 'Boost'], ['H', 'Horn'], ['B', 'Look back'],
      ['C', 'Change camera'], ['M', 'Map &amp; GPS waypoint'], ['R', 'Reset car to road'], ['N', 'Day / sunset / night'],
      ['G', 'Fly mode (ghost camera)'], ['Fly mode', 'Mouse to look (click), WASD, Space/Q up/down, Shift fast, wheel speed, Enter drop the car'],
      ['Drag', 'Look around (car and train)'], ['Train', 'W power, S brake, Space emergency brake, C cab / chase camera'],
      ['K', 'Mute'], ['F', 'Fullscreen'], ['Esc / P', 'Pause'],
      ['Gamepad', 'RT gas, LT brake, A handbrake, B boost, X reset, Y camera, Start pause'],
    ].map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join('');
    return `<div class="menu-title">Controls</div><div class="controls-grid">${rows}</div>
      <div class="menu-list"><button class="menu-btn back" data-act="back"><span>&larr; Back</span></button></div>`;
  }

  _pause() {
    const g = this.g;
    const restart = g.trainMode.active ? '<button class="menu-btn" data-act="restart"><span>Restart line</span></button>'
      : g.missions.mode !== 'free' ? `<button class="menu-btn" data-act="restart"><span>Restart ${g.missions.mode === 'taxi' ? 'shift' : 'race'}</span></button>` : '';
    return `<div class="menu-title">Paused</div><div class="menu-list">
      <button class="menu-btn primary" data-act="resume"><span>Resume</span></button>${restart}
      <button class="menu-btn" data-act="free"><span>Free Roam</span></button>
      <button class="menu-btn" data-act="fly"><span>Fly Around</span></button>
      <button class="menu-btn" data-act="lines"><span>Drive a Train</span><span class="meta">&#9656;</span></button>
      <button class="menu-btn" data-act="races"><span>Races</span><span class="meta">&#9656;</span></button>
      <button class="menu-btn" data-act="taxi"><span>Taxi Shift</span></button>
      <button class="menu-btn" data-act="garage"><span>Garage</span><span class="meta">&#9656;</span></button>
      <button class="menu-btn" data-act="settings"><span>Settings</span><span class="meta">&#9656;</span></button>
      <button class="menu-btn" data-act="controls"><span>Controls</span><span class="meta">&#9656;</span></button>
      <button class="menu-btn back" data-act="home"><span>Main menu</span></button></div>`;
  }

  _results(r) {
    if (r.train) {
      const medalName = r.medal ? r.medal[0].toUpperCase() + r.medal.slice(1) + ' medal' : 'No medal';
      const extra = [`${r.made}/${r.scored} stops`, formatTime(r.time)];
      if (r.overspeed > 0.5) extra.push(`${Math.round(r.overspeed)} s over the limit`);
      if (r.trips) extra.push(`${r.trips} emergency stop${r.trips === 1 ? '' : 's'}`);
      return `<div class="menu-title">${esc(r.title)}</div>
        <div class="brand-top" style="font-size:64px;font-weight:900;font-style:italic">${r.score}<span style="font-size:24px;opacity:0.6"> / ${r.max}</span></div>
        <p class="tagline"><span class="medal ${r.medal || 'none'}"></span> ${medalName}${r.record ? ' &middot; <b style="color:#f4c542">New best!</b>' : r.prev != null ? ` &middot; Best ${r.prev}` : ''}<br>${extra.join(' &middot; ')}</p>
        <div class="menu-list"><button class="menu-btn primary" data-act="retry"><span>Drive it again</span></button>
        <button class="menu-btn" data-act="lines"><span>Choose a line</span><span class="meta">&#9656;</span></button>
        <button class="menu-btn" data-act="free"><span>Free Roam</span></button><button class="menu-btn back" data-act="home"><span>Main menu</span></button></div>`;
    }
    if (r.taxi) {
      return `<div class="menu-title">Shift over</div>
        <div class="brand-top" style="font-size:64px;font-weight:900;font-style:italic;color:#7ee081">$${r.money.toFixed(2)}</div>
        <p class="tagline">${r.fares} fare${r.fares === 1 ? '' : 's'} completed${r.record ? ' &middot; <b style="color:#f4c542">New best shift!</b>' : ''}</p>
        <div class="menu-list"><button class="menu-btn primary" data-act="retry"><span>New shift</span></button>
        <button class="menu-btn" data-act="free"><span>Free Roam</span></button><button class="menu-btn back" data-act="home"><span>Main menu</span></button></div>`;
    }
    const medalName = r.medal ? r.medal[0].toUpperCase() + r.medal.slice(1) + ' medal' : 'No medal';
    return `<div class="menu-title">${esc(r.title)}</div>
      <div class="brand-top" style="font-size:64px;font-weight:900;font-style:italic">${formatTime(r.time)}</div>
      <p class="tagline"><span class="medal ${r.medal || 'none'}"></span> ${medalName}${r.record ? ' &middot; <b style="color:#f4c542">New best!</b>' : r.prev ? ` &middot; Best ${formatTime(r.prev)}` : ''}</p>
      <div class="menu-list"><button class="menu-btn primary" data-act="retry"><span>Retry</span></button>
      <button class="menu-btn" data-act="next" data-arg="${r.raceId}"><span>Next race</span></button>
      <button class="menu-btn" data-act="races"><span>All races</span><span class="meta">&#9656;</span></button>
      <button class="menu-btn" data-act="free"><span>Free Roam</span></button></div>`;
  }
}

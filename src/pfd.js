// The flight instruments, drawn on a canvas at the bottom of the screen:
// an attitude indicator with the pitch ladder, bank scale and flight path
// marker; speed and altitude tapes with the V-speeds, the vertical speed;
// a heading tape; engines, flaps, gear, spoilers and brakes; approach
// guidance to the runway ahead; and the warnings.

const DEG = Math.PI / 180;
const KT = 0.514444, FT = 0.3048;

export class PFD {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = 680; this.H = 250;
    this.dpr = 0;
  }

  _fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.cv.width = Math.round(this.W * dpr); this.cv.height = Math.round(this.H * dpr);
  }

  // s: see FlightMode._pfdState
  draw(s) {
    this._fit();
    const c = this.ctx, W = this.W, H = this.H;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.font = '600 12px Inter, Segoe UI, sans-serif';
    c.textBaseline = 'middle';
    // Panel background.
    c.fillStyle = 'rgba(7, 11, 20, 0.72)';
    roundRect(c, 0, 0, W, H, 14); c.fill();
    this._attitude(c, s, 352, 110, 88);
    this._speedTape(c, s, 196, 24, 60, 176);
    this._altTape(c, s, 448, 24, 66, 176);
    this._vsi(c, s, 520, 30, 18, 164);
    this._heading(c, s, 352, 226, 176);
    this._systems(c, s, 12, 14);
    this._nav(c, s, 552, 14);
    this._warnings(c, s, 352, 30);
  }

  _attitude(c, s, cx, cy, R) {
    c.save();
    roundRect(c, cx - R, cy - R, R * 2, R * 2, 16);
    c.clip();
    const ppd = R / 26;                          // pixels per degree of pitch
    c.translate(cx, cy);
    c.rotate(-s.bank);
    const py = (s.pitch / DEG) * ppd;
    // Sky and ground.
    c.fillStyle = '#3d7cc9'; c.fillRect(-R * 2, -R * 3 + py, R * 4, R * 3);
    c.fillStyle = '#87582c'; c.fillRect(-R * 2, py, R * 4, R * 3);
    c.strokeStyle = '#fff'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(-R * 2, py); c.lineTo(R * 2, py); c.stroke();
    // Pitch ladder.
    c.fillStyle = '#fff'; c.lineWidth = 1.5;
    c.font = '600 10px Inter, Segoe UI, sans-serif';
    c.textAlign = 'center';
    for (let d = -30; d <= 30; d += 5) {
      if (!d) continue;
      const y = py - d * ppd, w = d % 10 === 0 ? 34 : 18;
      if (Math.abs(y) > R * 1.3) continue;
      c.beginPath(); c.moveTo(-w, y); c.lineTo(w, y); c.stroke();
      if (d % 10 === 0) { c.fillText(String(Math.abs(d)), -w - 12, y); c.fillText(String(Math.abs(d)), w + 12, y); }
    }
    c.restore();
    // Bank scale (fixed) and pointer (rolls).
    c.save();
    c.translate(cx, cy);
    c.strokeStyle = '#fff'; c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, R * 0.86, -Math.PI / 2 - 60 * DEG, -Math.PI / 2 + 60 * DEG); c.stroke();
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const r0 = R * 0.86, r1 = r0 + (a % 30 === 0 ? 10 : 6), ang = -Math.PI / 2 + a * DEG;
      c.beginPath(); c.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0); c.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1); c.stroke();
    }
    c.rotate(-s.bank);
    c.fillStyle = Math.abs(s.bank) > 35 * DEG ? '#ffb020' : '#fff';
    c.beginPath(); c.moveTo(0, -R * 0.86 + 2); c.lineTo(-7, -R * 0.86 + 14); c.lineTo(7, -R * 0.86 + 14); c.closePath(); c.fill();
    // Sideslip brick under it.
    const sl = Math.max(-1, Math.min(1, s.beta / (8 * DEG))) * 12;
    c.fillRect(-7 + sl, -R * 0.86 + 16, 14, 4);
    c.restore();
    // Flight path marker: where she's actually going.
    if (s.fpv) {
      c.save();
      c.translate(cx, cy);
      const fx = Math.max(-R * 0.8, Math.min(R * 0.8, (s.fpv.x / DEG) * (R / 26)));
      const fy = Math.max(-R * 0.8, Math.min(R * 0.8, (-s.fpv.y / DEG) * (R / 26)));
      c.strokeStyle = '#7ef08a'; c.lineWidth = 2;
      c.beginPath(); c.arc(fx, fy, 6, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(fx - 16, fy); c.lineTo(fx - 6, fy); c.moveTo(fx + 6, fy); c.lineTo(fx + 16, fy); c.moveTo(fx, fy - 6); c.lineTo(fx, fy - 12); c.stroke();
      c.restore();
    }
    // Aircraft symbol.
    c.fillStyle = '#ffd447'; c.strokeStyle = '#0b1220'; c.lineWidth = 1.5;
    for (const sd of [-1, 1]) { c.beginPath(); c.rect(cx + sd * 26 - (sd > 0 ? 0 : 30), cy - 2.5, 30, 5); c.fill(); c.stroke(); }
    c.fillRect(cx - 3, cy - 3, 6, 6);
    // Approach guidance: localizer (bottom) and glideslope (right) diamonds.
    if (s.ils) {
      const dot = R * 0.22;
      c.strokeStyle = '#fff'; c.lineWidth = 1.5;
      for (let k = -2; k <= 2; k++) {
        if (!k) continue;
        c.beginPath(); c.arc(cx + k * dot, cy + R - 12, 3, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.arc(cx + R - 12, cy + k * dot, 3, 0, Math.PI * 2); c.stroke();
      }
      const lx = Math.max(-2.4, Math.min(2.4, s.ils.loc / (1.25 * DEG))) * dot;
      const gy = Math.max(-2.4, Math.min(2.4, -s.ils.gs / (0.35 * DEG))) * dot;
      c.fillStyle = '#ff5ad1';
      diamond(c, cx + lx, cy + R - 12, 7);
      diamond(c, cx + R - 12, cy + gy, 7);
    }
  }

  _speedTape(c, s, x, y, w, h) {
    const v = s.ias / KT, mid = y + h / 2, ppk = h / 80;
    c.save();
    roundRect(c, x, y, w, h, 8); c.fillStyle = 'rgba(60, 66, 80, 0.85)'; c.fill(); c.clip();
    // Red: below the stall and above the limit.
    const band = (a, b, col) => { const ya = mid - (a - v) * ppk, yb = mid - (b - v) * ppk; c.fillStyle = col; c.fillRect(x + w - 8, Math.min(ya, yb), 8, Math.abs(yb - ya)); };
    if (s.vs0) band(0, s.vs0 / KT, '#e5484d');
    if (s.vmax) band(s.vmax / KT, s.vmax / KT + 200, '#e5484d');
    if (s.vfe && s.vfe < 1000) band(s.vfe / KT, s.vfe / KT + 1, '#ffb020');
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 1.5; c.textAlign = 'right';
    for (let k = Math.floor((v - 45) / 10) * 10; k <= v + 45; k += 10) {
      if (k < 0) continue;
      const yy = mid - (k - v) * ppk;
      c.beginPath(); c.moveTo(x + w - 10, yy); c.lineTo(x + w - 18, yy); c.stroke();
      if (k % 20 === 0) c.fillText(String(k), x + w - 21, yy);
    }
    // Bugs: VR and VREF.
    c.font = '700 10px Inter, Segoe UI, sans-serif';
    for (const [lab, sp, col] of [['R', s.vr, '#59d3ff'], ['REF', s.vref, '#ff5ad1']]) {
      if (!sp) continue;
      const yy = mid - (sp / KT - v) * ppk;
      if (yy < y || yy > y + h) continue;
      c.fillStyle = col; c.textAlign = 'left';
      c.fillRect(x + w - 10, yy - 1, 10, 2);
      c.fillText(lab, x + 3, yy);
    }
    // Trend: where the speed will be in 10 s.
    if (Math.abs(s.accel) > 0.05) {
      c.strokeStyle = '#7ef08a'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x + w - 4, mid); c.lineTo(x + w - 4, mid - (s.accel * 10 / KT) * ppk); c.stroke();
    }
    c.restore();
    // Readout box.
    c.fillStyle = '#05070b'; c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    roundRect(c, x + 2, mid - 13, w - 4, 26, 5); c.fill(); c.stroke();
    c.fillStyle = s.overspeed ? '#ff6b6b' : '#fff';
    c.font = '800 17px Inter, Segoe UI, sans-serif'; c.textAlign = 'center';
    c.fillText(String(Math.round(s.metric ? s.ias * 3.6 : v)), x + w / 2, mid + 1);
    c.font = '600 10px Inter, Segoe UI, sans-serif'; c.fillStyle = '#9fb0c8';
    c.fillText(s.metric ? 'KM/H' : 'KT', x + w / 2, y + h + 9);
    c.fillText(s.mach > 0.4 ? `M ${s.mach.toFixed(2)}` : `GS ${Math.round(s.metric ? s.gs * 3.6 : s.gs / KT)}`, x + w / 2, y - 9);
  }

  _altTape(c, s, x, y, w, h) {
    const a = s.metric ? s.alt : s.alt / FT, mid = y + h / 2, ppu = h / (s.metric ? 300 : 1000);
    const step = s.metric ? 20 : 100, label = s.metric ? 100 : 500;
    c.save();
    roundRect(c, x, y, w, h, 8); c.fillStyle = 'rgba(60, 66, 80, 0.85)'; c.fill(); c.clip();
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 1.5; c.textAlign = 'left';
    const span = (s.metric ? 300 : 1000) / 2 + step;
    for (let k = Math.floor((a - span) / step) * step; k <= a + span; k += step) {
      const yy = mid - (k - a) * ppu;
      c.beginPath(); c.moveTo(x, yy); c.lineTo(x + (k % label === 0 ? 12 : 7), yy); c.stroke();
      if (k % label === 0) c.fillText(String(k), x + 15, yy);
    }
    // The ground, as it comes up (radio altitude).
    const gy = mid + (s.metric ? s.agl : s.agl / FT) * ppu;
    if (gy < y + h) { c.fillStyle = 'rgba(135, 88, 44, 0.9)'; c.fillRect(x, gy, w, y + h - gy + 1); }
    c.restore();
    c.fillStyle = '#05070b'; c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    roundRect(c, x + 2, mid - 13, w - 4, 26, 5); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.font = '800 16px Inter, Segoe UI, sans-serif'; c.textAlign = 'center';
    c.fillText(String(Math.round(a / (s.metric ? 1 : 10)) * (s.metric ? 1 : 10)), x + w / 2, mid + 1);
    c.font = '600 10px Inter, Segoe UI, sans-serif'; c.fillStyle = '#9fb0c8';
    c.fillText(s.metric ? 'M' : 'FT', x + w / 2, y + h + 9);
    // Radio altitude near the ground (above the tape).
    if (s.agl < 760) {
      c.fillStyle = s.agl < 15 ? '#ffd447' : '#7ef08a';
      c.font = '800 12px Inter, Segoe UI, sans-serif';
      c.fillText(`RA ${Math.round(s.metric ? s.agl : s.agl / FT)}`, x + w / 2, y - 9);
    }
  }

  _vsi(c, s, x, y, w, h) {
    const mid = y + h / 2, fpm = s.vs / FT * 60;
    c.fillStyle = 'rgba(60, 66, 80, 0.85)'; roundRect(c, x, y, w, h, 6); c.fill();
    const scale = (v) => Math.sign(v) * Math.min(1, Math.sqrt(Math.abs(v) / 6000)) * (h / 2 - 6);
    c.strokeStyle = '#9fb0c8'; c.lineWidth = 1;
    for (const v of [-4000, -2000, -1000, -500, 500, 1000, 2000, 4000]) { const yy = mid - scale(v); c.beginPath(); c.moveTo(x, yy); c.lineTo(x + 5, yy); c.stroke(); }
    c.strokeStyle = Math.abs(fpm) > 3000 ? '#ffb020' : '#7ef08a'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(x + w, mid); c.lineTo(x + 4, mid - scale(fpm)); c.stroke();
    c.fillStyle = '#fff'; c.font = '700 10px Inter, Segoe UI, sans-serif'; c.textAlign = 'center';
    const n = s.metric ? Math.round(s.vs * 10) / 10 : Math.round(fpm / 50) * 50;
    c.fillText(s.metric ? `${n > 0 ? '+' : ''}${n.toFixed(1)}` : `${n > 0 ? '+' : ''}${n}`, x + w / 2, fpm > 0 ? y + h + 9 : y - 7);
  }

  _heading(c, s, cx, y, w) {
    const hd = ((s.heading / DEG) % 360 + 360) % 360, ppd = w / 60;
    c.save();
    c.fillStyle = 'rgba(60, 66, 80, 0.85)'; roundRect(c, cx - w / 2, y - 12, w, 24, 6); c.fill(); c.clip();
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 1.5; c.textAlign = 'center';
    for (let k = Math.floor((hd - 35) / 5) * 5; k <= hd + 35; k += 5) {
      const xx = cx + (k - hd) * ppd, kk = ((k % 360) + 360) % 360;
      c.beginPath(); c.moveTo(xx, y - 12); c.lineTo(xx, y - 12 + (kk % 10 === 0 ? 7 : 4)); c.stroke();
      if (kk % 30 === 0) c.fillText(['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][kk / 30], xx, y + 4);
    }
    // Track (green diamond) and a heading bug for the course to fly.
    const tk = ((s.track / DEG) % 360 + 360) % 360;
    let dt = tk - hd; if (dt > 180) dt -= 360; if (dt < -180) dt += 360;
    c.fillStyle = '#7ef08a'; diamond(c, cx + dt * ppd, y - 7, 4);
    if (s.course != null) {
      let dc = ((s.course / DEG) % 360 + 360) % 360 - hd; if (dc > 180) dc -= 360; if (dc < -180) dc += 360;
      c.fillStyle = '#ff5ad1';
      const xx = cx + Math.max(-w / 2 + 5, Math.min(w / 2 - 5, dc * ppd));
      c.fillRect(xx - 5, y + 8, 10, 4);
    }
    c.restore();
    c.fillStyle = '#05070b'; c.strokeStyle = '#fff';
    roundRect(c, cx - 20, y - 13, 40, 17, 4); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.font = '800 12px Inter, Segoe UI, sans-serif'; c.textAlign = 'center';
    c.fillText(String(Math.round(hd) % 360).padStart(3, '0'), cx, y - 4);
  }

  _systems(c, s, x, y) {
    c.textAlign = 'left';
    // Engines: N1 bars (thrust lever as a tick), reverse in amber.
    c.font = '700 10px Inter, Segoe UI, sans-serif'; c.fillStyle = '#9fb0c8';
    c.fillText(s.blimp ? 'PROPS' : s.jet ? 'N1' : 'POWER', x, y + 4);
    const bw = 15, bh = 98, n = s.engines;
    for (let k = 0; k < n; k++) {
      const bx = x + k * (bw + 6), by = y + 14;
      c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(bx, by, bw, bh);
      const v = Math.max(0, Math.min(1, Math.abs(s.n1)));
      c.fillStyle = s.reverse > 0.1 ? '#ffb020' : s.n1 < 0 ? '#59d3ff' : '#7ef08a';
      c.fillRect(bx, by + bh * (1 - v), bw, bh * v);
      c.fillStyle = '#fff'; c.fillRect(bx - 2, by + bh * (1 - Math.abs(s.throttle)) - 1, bw + 4, 2);
    }
    c.fillStyle = '#fff'; c.font = '800 13px Inter, Segoe UI, sans-serif';
    c.fillText(`${s.reverse > 0.1 ? 'REV ' : ''}${Math.round(Math.abs(s.n1) * 100)}%`, x, y + bh + 26);
    // Flaps, gear, spoilers, brakes.
    const col = x + Math.max(2, n) * (bw + 6) + 10;
    const row = (k, label, value, color = '#fff') => {
      c.font = '700 10px Inter, Segoe UI, sans-serif'; c.fillStyle = '#9fb0c8'; c.fillText(label, col, y + 6 + k * 30);
      c.font = '800 14px Inter, Segoe UI, sans-serif'; c.fillStyle = color; c.fillText(value, col, y + 20 + k * 30);
    };
    if (!s.blimp) {
      row(0, 'FLAPS', s.flaps, s.flapMoving ? '#ffb020' : '#fff');
      row(1, 'GEAR', s.gear, s.gear === 'DOWN' ? '#7ef08a' : s.gear === 'UP' ? '#fff' : '#ffb020');
      row(2, s.spoilersArmed ? 'SPOILERS' : 'BRAKES', s.spoiler > 0.1 ? 'EXT' : s.brake ? (s.parking ? 'PARK' : 'ON') : 'OFF', s.spoiler > 0.1 || s.brake ? '#ffb020' : '#fff');
    } else {
      row(0, 'BALLAST', s.trim > 0.05 ? 'LIGHT' : s.trim < -0.05 ? 'HEAVY' : 'TRIM', '#fff');
      row(1, 'MOORING', s.moored ? 'ON MAST' : 'FREE', s.moored ? '#7ef08a' : '#fff');
      row(2, 'BRAKES', s.brake ? 'ON' : 'OFF', s.brake ? '#ffb020' : '#fff');
    }
    if (s.sim > 1) row(3, 'TIME', `×${s.sim}`, '#59d3ff');
    else if (s.assist === false) row(3, 'LAW', 'DIRECT', '#ffb020');
  }

  _nav(c, s, x, y) {
    c.textAlign = 'left';
    const line = (k, label, value, color = '#fff') => {
      c.font = '700 10px Inter, Segoe UI, sans-serif'; c.fillStyle = '#9fb0c8'; c.fillText(label, x, y + 6 + k * 29);
      c.font = '800 13px Inter, Segoe UI, sans-serif'; c.fillStyle = color; c.fillText(value, x, y + 19 + k * 29);
    };
    const kt = (v) => (s.metric ? `${Math.round(v * 3.6)} km/h` : `${Math.round(v / KT)} kt`);
    // Wind: from where, how strong (arrow relative to the nose).
    c.font = '700 10px Inter, Segoe UI, sans-serif'; c.fillStyle = '#9fb0c8'; c.fillText('WIND', x, y + 6);
    c.save();
    c.translate(x + 104, y + 14);
    c.rotate(s.windFrom - s.heading + Math.PI);
    c.strokeStyle = '#59d3ff'; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(0, -10); c.lineTo(0, 10); c.moveTo(-5, 4); c.lineTo(0, 10); c.lineTo(5, 4); c.stroke();
    c.restore();
    c.font = '800 13px Inter, Segoe UI, sans-serif'; c.fillStyle = '#fff';
    c.fillText(`${String(Math.round(((s.windFrom / DEG) % 360 + 360) % 360)).padStart(3, '0')}° ${kt(s.windSpeed)}`, x, y + 19);
    if (s.target) {
      line(1, s.target.label, s.target.dist, '#ff5ad1');
      line(2, 'BEARING', s.target.brg);
    }
    if (s.turb > 0.25) line(3, 'TURBULENCE', s.turb > 0.7 ? 'SEVERE' : s.turb > 0.45 ? 'MODERATE' : 'LIGHT', s.turb > 0.45 ? '#ffb020' : '#fff');
    else if (s.gload) line(3, 'LOAD', `${s.gload.toFixed(2)} g`);
  }

  _warnings(c, s, cx, y) {
    if (!s.warn) return;
    c.font = '900 15px Inter, Segoe UI, sans-serif'; c.textAlign = 'center';
    const blink = (performance.now() / 350 | 0) % 2;
    c.fillStyle = s.warnRed ? (blink ? '#ff3b3b' : '#ff9b9b') : '#ffb020';
    c.fillText(s.warn, cx, y);
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function diamond(c, x, y, r) {
  c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); c.fill();
}

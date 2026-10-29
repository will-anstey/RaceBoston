// Ghost camera: fly anywhere through buildings and under the ground.
// Mouse look (click for pointer lock, or drag), WASD move, Space/E up,
// Q/C down, Shift fast, Alt slow, mouse wheel changes cruise speed.
// Gamepad: left stick move, right stick look, triggers up/down.

import { clamp, damp, wrapAngle } from './util.js';

export class FlyCam {
  constructor(camera, canvas, input) {
    this.cam = camera;
    this.canvas = canvas;
    this.input = input;
    this.active = false;
    this.x = 0; this.y = 120; this.z = 0;
    this.yaw = 0;        // compass heading: 0 = north (-z)
    this.pitch = -0.35;  // radians, + looks up
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.base = 30;      // cruise speed (m/s)
    this.mdx = 0; this.mdy = 0;
    this.dragging = false;
    this.touchLook = null;
    canvas.addEventListener('mousedown', (e) => {
      if (!this.active || e.button !== 0) return;
      this.dragging = true;
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {});
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      if (document.pointerLockElement === canvas || this.dragging) { this.mdx += e.movementX || 0; this.mdy += e.movementY || 0; }
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.base = clamp(this.base * (e.deltaY < 0 ? 1.25 : 0.8), 4, 400);
    }, { passive: false });
    // Touch: drag anywhere on the view to look around.
    canvas.addEventListener('pointerdown', (e) => { if (this.active && e.pointerType === 'touch') this.touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
    window.addEventListener('pointermove', (e) => {
      const t = this.touchLook;
      if (!this.active || !t || e.pointerId !== t.id) return;
      this.mdx += (e.clientX - t.x) * 1.6; this.mdy += (e.clientY - t.y) * 1.6;
      t.x = e.clientX; t.y = e.clientY;
    });
    window.addEventListener('pointerup', (e) => { if (this.touchLook && e.pointerId === this.touchLook.id) this.touchLook = null; });
  }

  // Start from the current camera pose.
  enter() {
    this.active = true;
    const p = this.cam.position;
    this.x = p.x; this.y = Math.max(p.y, 2); this.z = p.z;
    const d = this.cam.getWorldDirection(this._dir || (this._dir = p.clone()));
    this.yaw = Math.atan2(d.x, -d.z);
    this.pitch = clamp(Math.asin(clamp(d.y, -1, 1)), -1.45, 1.45);
    this.vx = this.vy = this.vz = 0;
    this.mdx = this.mdy = 0;
  }

  exit() {
    this.active = false;
    this.dragging = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  teleport(x, z) {
    this.x = x; this.z = z;
    this.y = Math.max(this.y, 120);
    this.pitch = Math.min(this.pitch, -0.45);
    this.vx = this.vy = this.vz = 0;
  }

  get speed() { return Math.hypot(this.vx, this.vy, this.vz); }

  update(dt, bounds) {
    const inp = this.input;
    const k = (...c) => (inp.has(...c) ? 1 : 0);
    // Look: mouse, arrow keys, gamepad right stick, touch left/right buttons.
    let lookX = this.mdx * 0.0023, lookY = this.mdy * 0.0023;
    this.mdx = this.mdy = 0;
    lookX += (k('ArrowRight') - k('ArrowLeft')) * 1.6 * dt;
    lookY += (k('ArrowDown') - k('ArrowUp')) * 1.2 * dt;
    lookX += ((inp.touch.has('right') ? 1 : 0) - (inp.touch.has('left') ? 1 : 0)) * 1.4 * dt;
    let mvF = k('KeyW') - k('KeyS') + (inp.touch.has('throttle') ? 1 : 0) - (inp.touch.has('brake') ? 1 : 0);
    let mvR = k('KeyD') - k('KeyA');
    let mvU = k('Space', 'KeyE') - k('KeyQ', 'KeyC') + (inp.touch.has('handbrake') ? 1 : 0);
    let boost = inp.has('ShiftLeft', 'ShiftRight'), slow = inp.has('AltLeft', 'AltRight', 'ControlLeft');
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const ax = (i) => { const v = gp.axes[i] || 0; return Math.abs(v) < 0.15 ? 0 : v; };
      const b = (i) => (gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0);
      mvR += ax(0); mvF -= ax(1);
      lookX += ax(2) * 2.2 * dt; lookY += ax(3) * 1.6 * dt;
      mvU += b(7) - b(6);
      if (b(0) > 0.5) boost = true;
      break;
    }
    this.yaw = wrapAngle(this.yaw + lookX);
    this.pitch = clamp(this.pitch - lookY, -1.5, 1.5);

    const cp = Math.cos(this.pitch);
    const fx = Math.sin(this.yaw) * cp, fy = Math.sin(this.pitch), fz = -Math.cos(this.yaw) * cp;
    const rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
    const sp = this.base * (boost ? 4 : 1) * (slow ? 0.25 : 1);
    let wx = fx * mvF + rx * mvR, wy = fy * mvF + mvU, wz = fz * mvF + rz * mvR;
    const wl = Math.hypot(wx, wy, wz);
    if (wl > 1) { wx /= wl; wy /= wl; wz /= wl; }
    const a = damp(5, dt);
    this.vx += (wx * sp - this.vx) * a;
    this.vy += (wy * sp - this.vy) * a;
    this.vz += (wz * sp - this.vz) * a;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    const m = 600;
    this.x = clamp(this.x, bounds.minX - m, bounds.maxX + m);
    this.z = clamp(this.z, bounds.minZ - m, bounds.maxZ + m);
    this.y = clamp(this.y, -40, 2500);
    this.cam.position.set(this.x, this.y, this.z);
    this.cam.rotation.set(this.pitch, -this.yaw, 0, 'YXZ');
    this.cam.fov += (66 - this.cam.fov) * damp(4, dt);
    this.cam.updateProjectionMatrix();
  }

  // Point on the ground the camera is looking at (for shadows, traffic, signs).
  focus(out) {
    let x = this.x, z = this.z;
    if (this.pitch < -0.05 && this.y > 0) {
      const t = Math.min(this.y / -Math.sin(this.pitch), 260);
      const cp = Math.cos(this.pitch);
      x += Math.sin(this.yaw) * cp * t;
      z += -Math.cos(this.yaw) * cp * t;
    }
    out.x = x; out.y = Math.min(this.y, 0); out.z = z;
    return out;
  }
}

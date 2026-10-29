// Keyboard, gamepad and touch input merged into one driving state plus
// edge-triggered actions.

const ACTION_KEYS = {
  KeyR: 'reset', KeyC: 'camera', KeyM: 'map', Escape: 'pause', KeyP: 'pause', KeyN: 'time',
  KeyK: 'mute', KeyH: 'horn', KeyB: 'lookback', Enter: 'confirm', KeyF: 'fullscreen', KeyG: 'fly',
};
const PAD_ACTIONS = { 2: 'reset', 3: 'camera', 8: 'map', 9: 'pause', 12: 'time' };

export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = new Set();
    this.actions = new Set();
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, horn: false, lookBack: false };
    this.kSteer = 0;
    this.padPrev = [];
    this.usingPad = false;
    this.enabled = true;
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat && ACTION_KEYS[e.code]) this.actions.add(ACTION_KEYS[e.code]);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.touch.clear(); });
    for (const btn of document.querySelectorAll('#touch button')) {
      const key = btn.dataset.key;
      const on = (e) => { e.preventDefault(); if (key === 'menu') this.actions.add('pause'); else this.touch.add(key); btn.classList.add('on'); };
      const off = (e) => { e.preventDefault(); this.touch.delete(key); btn.classList.remove('on'); };
      btn.addEventListener('pointerdown', on);
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointercancel', off);
      btn.addEventListener('pointerleave', off);
    }
  }

  has(...codes) { return codes.some((c) => this.keys.has(c)); }

  // Returns and clears an edge-triggered action.
  take(name) {
    if (!this.actions.has(name)) return false;
    this.actions.delete(name);
    return true;
  }

  clearActions() { this.actions.clear(); }

  update(dt) {
    const s = this.state;
    const left = this.has('ArrowLeft', 'KeyA') || this.touch.has('left');
    const right = this.has('ArrowRight', 'KeyD') || this.touch.has('right');
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = target === 0 ? 7 : Math.sign(target) !== Math.sign(this.kSteer) && this.kSteer !== 0 ? 10 : 4.2;
    const d = target - this.kSteer;
    this.kSteer += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    let throttle = this.has('ArrowUp', 'KeyW') || this.touch.has('throttle') ? 1 : 0;
    let brake = this.has('ArrowDown', 'KeyS') || this.touch.has('brake') ? 1 : 0;
    let steer = this.kSteer;
    let handbrake = this.has('Space') || this.touch.has('handbrake');
    let boost = this.has('ShiftLeft', 'ShiftRight') || this.touch.has('boost');
    let horn = this.has('KeyH');
    let lookBack = this.has('KeyB');

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const ax = gp.axes[0] || 0;
      const dz = Math.abs(ax) < 0.12 ? 0 : (ax - Math.sign(ax) * 0.12) / 0.88;
      const b = (i) => (gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0);
      const rt = b(7), lt = b(6);
      if (Math.abs(dz) > 0.01 || rt > 0.05 || lt > 0.05) this.usingPad = true;
      if (this.usingPad) {
        if (Math.abs(dz) > Math.abs(steer)) steer = Math.sign(dz) * Math.pow(Math.abs(dz), 1.4);
        throttle = Math.max(throttle, rt);
        brake = Math.max(brake, lt);
      }
      handbrake = handbrake || b(0) > 0.5;
      boost = boost || b(1) > 0.5 || b(5) > 0.5;
      lookBack = lookBack || b(4) > 0.5;
      for (const [i, name] of Object.entries(PAD_ACTIONS)) {
        const pressed = b(+i) > 0.5;
        if (pressed && !this.padPrev[i]) this.actions.add(name);
        this.padPrev[i] = pressed;
      }
      break;
    }
    if (!this.enabled) { throttle = brake = 0; steer = 0; handbrake = boost = false; }
    s.throttle = throttle; s.brake = brake; s.steer = steer;
    s.handbrake = handbrake; s.boost = boost; s.horn = horn; s.lookBack = lookBack;
    return s;
  }
}

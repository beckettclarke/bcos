// Springs, the way Apple describes them: two designer-facing numbers instead
// of mass/stiffness/damping.
//
//   response — roughly how long it takes to get there, in seconds (not a duration)
//   damping  — 1 settles with no overshoot; below 1 overshoots and bounces
//
// Every spring animates from wherever it is right now and keeps its velocity
// when its target changes, so anything driven by one can be grabbed and
// reversed mid-flight. One shared rAF loop drives them all.

const active = new Set();
let raf = 0;
let last = 0;

function frame(now) {
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  for (const s of [...active]) s._step(dt);
  raf = active.size ? requestAnimationFrame(frame) : 0;
  if (!raf) last = 0;
}

export class Spring {
  constructor(value = 0, { response = 0.4, damping = 1, precision = 0.001, onUpdate, onRest } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.precision = precision;
    this.onUpdate = onUpdate;
    this.onRest = onRest;
    this.configure({ response, damping });
  }

  configure({ response = this.response, damping = this.damping } = {}) {
    this.response = response;
    this.damping = damping;
    this.k = (2 * Math.PI / response) ** 2;
    this.c = (4 * Math.PI * damping) / response;
    return this;
  }

  /** Head for `target`. Pass `velocity` (units/s) to hand off a gesture. */
  to(target, { velocity, response, damping } = {}) {
    if (response != null || damping != null) this.configure({ response: response ?? this.response, damping: damping ?? this.damping });
    if (velocity != null) this.velocity = velocity;
    this.target = target;
    if (reducedMotion()) { this.set(target); this.onRest?.(this.value); return this; }
    if (!active.has(this)) {
      active.add(this);
      if (!raf) raf = requestAnimationFrame(frame);
    }
    return this;
  }

  /** Jump without animating (used while a finger is driving the value). */
  set(value) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    active.delete(this);
    this.onUpdate?.(value);
    return this;
  }

  stop() { active.delete(this); return this; }

  get moving() { return active.has(this); }

  _step(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    const settled = Math.abs(this.velocity) < this.precision * 10 && Math.abs(this.value - this.target) < this.precision;
    if (settled) {
      this.value = this.target;
      this.velocity = 0;
      active.delete(this);
    }
    this.onUpdate?.(this.value);
    if (settled) this.onRest?.(this.value);
  }
}

/** Where a flick would come to rest (UIScrollView's deceleration curve). */
export function project(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a boundary instead of a hard stop. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Tracks recent pointer samples so a release can hand off its velocity. */
export class VelocityTracker {
  constructor() { this.samples = []; }
  reset() { this.samples = []; }
  add(x, y, t = performance.now()) {
    this.samples.push({ x, y, t });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }
  velocity() {
    const s = this.samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const a = s[0], b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { x: 0, y: 0 };
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }
}

const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
let userReduced = false;
export const setReducedMotion = (v) => {
  userReduced = !!v;
  document.documentElement.classList.toggle('reduce-motion', reducedMotion());
};
export const reducedMotion = () => userReduced || mq.matches;
mq.addEventListener?.('change', () => setReducedMotion(userReduced));

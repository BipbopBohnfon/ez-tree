// Small DOM helpers for the studio panels (no framework).

/** h('div.cls#id', {attrs, on: {click}}, ...children) */
export function h(spec, props = {}, ...children) {
  const [, tag = 'div', rest = ''] = /^([a-z0-9]*)(.*)$/i.exec(spec);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props instanceof Node || typeof props !== 'object' || Array.isArray(props)) { children.unshift(props); props = {}; }
  for (const [key, value] of Object.entries(props)) {
    if (key === 'on') for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else if (value !== false && value != null) el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const fmt = (value, step = 0.01) => {
  if (!Number.isFinite(value)) return '—';
  const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return value.toFixed(digits);
};

export const kfmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));

/** Section with an uppercase header and optional aside element. */
export function section(title, aside, ...body) {
  return h('div.sec', h('div.sec-h', title, aside ? h('span.aside', aside) : null), ...body);
}

/** Single slider with an accent fill. onInput(value, final) */
export function slider({ min, max, step, value, onInput }) {
  const input = h('input', { type: 'range', min, max, step, value });
  const fill = h('i.fill');
  const wrap = h('div.fill-range', input, fill);
  const paint = () => { fill.style.width = `${((input.value - min) / (max - min)) * 100}%`; };
  input.addEventListener('input', () => { paint(); onInput(Number(input.value), false); });
  input.addEventListener('change', () => onInput(Number(input.value), true));
  paint();
  wrap.set = (v) => { input.value = v; paint(); };
  return wrap;
}

/** Two-thumb range slider. onInput([lo, hi], final) */
export function dualSlider({ min, max, step, value: [lo, hi], onInput }) {
  const a = h('input', { type: 'range', min, max, step, value: lo });
  const b = h('input', { type: 'range', min, max, step, value: hi });
  const fill = h('i.fill');
  const wrap = h('div.dual', a, b, fill);
  const read = () => {
    const x = Number(a.value), y = Number(b.value);
    return [Math.min(x, y), Math.max(x, y)];
  };
  const paint = () => {
    const [x, y] = read();
    fill.style.left = `${((x - min) / (max - min)) * 100}%`;
    fill.style.width = `${((y - x) / (max - min)) * 100}%`;
  };
  for (const input of [a, b]) {
    input.addEventListener('input', () => { paint(); onInput(read(), false); });
    input.addEventListener('change', () => onInput(read(), true));
  }
  paint();
  return wrap;
}

/** Segmented control: options [{value, label, title}] */
export function segmented(options, value, onChange, { full = false, accent = false } = {}) {
  const el = h(`div.seg${full ? '.full' : ''}`);
  const buttons = options.map((o) => {
    const b = h('button', { title: o.title ?? '', on: { click: () => { onChange(o.value); } } }, o.label);
    b.dataset.value = String(o.value);
    el.append(b);
    return b;
  });
  el.set = (v) => buttons.forEach((b) => {
    b.classList.toggle('on', b.dataset.value === String(v));
    b.classList.toggle('acc', accent && b.dataset.value === String(v));
  });
  el.set(value);
  return el;
}

export function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label.switch', h('span', label), input, h('i'));
  el.set = (v) => { input.checked = v; };
  return el;
}

export const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
export const unhex = (s) => parseInt(s.slice(1), 16);

/** HSL triple (h degrees, s/l 0..1) <-> #rrggbb */
export function hslToHex([hh, s, l]) {
  const k = (n) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
export function hexToHsl(s) {
  const n = unhex(s);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, +l.toFixed(3)];
  const d = max - min;
  const s2 = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(hh * 60), +s2.toFixed(3), +l.toFixed(3)];
}

export function colorSwatch(value, onChange) {
  const input = h('input', { type: 'color', value });
  const face = h('div.swatch', { style: { background: value } }, input);
  const label = h('span.swatch-hex', value);
  input.addEventListener('input', () => { face.style.background = input.value; label.textContent = input.value; onChange(input.value, false); });
  input.addEventListener('change', () => onChange(input.value, true));
  return h('span.swatches', face, label);
}

/** Paints a top-down RGBA {data, width, height} image into a canvas (optionally downscaled). */
export function imageCanvas(image, max = 256) {
  const src = document.createElement('canvas');
  src.width = image.width; src.height = image.height;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer ?? image.data, image.data.byteOffset ?? 0, image.width * image.height * 4), image.width, image.height), 0, 0);
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  if (scale === 1) return src;
  const out = document.createElement('canvas');
  out.width = Math.round(image.width * scale); out.height = Math.round(image.height * scale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

let toastTimer;
export function toast(text, ms = 2200) {
  const el = document.querySelector('#toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

/** Promise-returning confirm modal. */
export function confirmModal(title, text, ok = 'OK') {
  const back = document.querySelector('#modal');
  document.querySelector('#modal-title').textContent = title;
  document.querySelector('#modal-text').textContent = text;
  const okBtn = document.querySelector('#modal-ok');
  okBtn.textContent = ok;
  back.classList.add('on');
  return new Promise((resolve) => {
    const done = (v) => { back.classList.remove('on'); okBtn.onclick = null; document.querySelector('#modal-cancel').onclick = null; resolve(v); };
    okBtn.onclick = () => done(true);
    document.querySelector('#modal-cancel').onclick = () => done(false);
  });
}

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

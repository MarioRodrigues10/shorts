// Keyframes. c.kf = { prop: [{ t, v }] } with t in seconds from the clip start
// (timeline time). Interpolation is smoothstep between neighbours; the server
// builds the identical curve as an ffmpeg expression (kf_expr in server.py).
const EPS = 1 / 60;
const smooth = (x) => x * x * (3 - 2 * x);

export function kfList(c, prop) { return c.kf?.[prop] || null; }
export function hasKf(c, prop) { return !!c.kf?.[prop]?.length; }
export function anyKf(c) { return !!c.kf && Object.values(c.kf).some((l) => l.length); }

export function kfValue(c, prop, lt, base) {
  const k = c.kf?.[prop];
  if (!k || !k.length) return base;
  if (lt <= k[0].t) return k[0].v;
  for (let i = 1; i < k.length; i++) {
    if (lt <= k[i].t) {
      const a = k[i - 1], b = k[i];
      return a.v + (b.v - a.v) * smooth((lt - a.t) / Math.max(b.t - a.t, 1e-6));
    }
  }
  return k[k.length - 1].v;
}

export function kfAt(c, prop, lt) {
  return (c.kf?.[prop] || []).find((k) => Math.abs(k.t - lt) < EPS) || null;
}

export function setKf(c, prop, lt, v) {
  c.kf = c.kf || {};
  const l = (c.kf[prop] = c.kf[prop] || []);
  const hit = l.find((k) => Math.abs(k.t - lt) < EPS);
  if (hit) hit.v = v; else { l.push({ t: Math.round(lt * 1000) / 1000, v }); l.sort((a, b) => a.t - b.t); }
}

export function removeKf(c, prop, lt) {
  if (!c.kf?.[prop]) return;
  c.kf[prop] = c.kf[prop].filter((k) => Math.abs(k.t - lt) >= EPS);
  if (!c.kf[prop].length) delete c.kf[prop];
}

// Set a property "at the playhead": updates/creates a keyframe if the property is
// animated, otherwise changes the static value.
export function setProp(c, prop, lt, v, staticSetter) {
  if (hasKf(c, prop)) setKf(c, prop, lt, v);
  else if (staticSetter) staticSetter(v);
  else c[prop] = v;
}

// All keyframe times (for the timeline diamonds and prev/next navigation).
export function kfTimes(c) {
  const s = new Set();
  for (const l of Object.values(c.kf || {})) for (const k of l) s.add(k.t);
  return [...s].sort((a, b) => a - b);
}

// Splitting a clip at local time lt: the left keeps [0, lt], the right gets the rest shifted to 0.
export function splitKf(left, right, lt) {
  if (!left.kf) return;
  const L = {}, R = {};
  for (const [prop, l] of Object.entries(left.kf)) {
    if (!l.length) continue;
    const at = kfValue(left, prop, lt, l[0].v);
    L[prop] = [...l.filter((k) => k.t < lt - EPS), { t: lt, v: at }];
    R[prop] = [{ t: 0, v: at }, ...l.filter((k) => k.t > lt + EPS).map((k) => ({ t: k.t - lt, v: k.v }))];
  }
  left.kf = L;
  right.kf = R;
}

// Content moved by d seconds relative to the clip start (e.g. trimming the left edge).
export function shiftKf(c, d) {
  if (!c.kf) return;
  for (const l of Object.values(c.kf)) for (const k of l) k.t = Math.round((k.t + d) * 1000) / 1000;
}

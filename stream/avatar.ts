// The commentator on screen: General Static, a retired general whose head is
// an old CRT television (officer's cap, gold epaulettes, a phosphor face that
// blinks and emotes), bottom left over the game, with a comic speech bubble.
// Drawn into the OpenFront page itself (the page is what's filmed) and
// animated there: the driver only sends each line, its mood and the voice's
// loudness envelope, and the page moves the mouth and types the subtitle in
// step with it. It ignores the mouse, so it never takes a click.

import type { Mood } from "./voice";

export interface Utterance {
  text: string;
  mood: Mood;
  // Voice loudness per 40 ms, 0..1 (voice.ts envelope); empty without a voice.
  env: number[];
  durMs: number;
  // The chat user being answered, shown above the line.
  replyTo?: string;
}

// "General Static" → "GEN. STATIC", for the name plate.
export function plate(name: string): string {
  return name.replace(/^general\s+/i, "Gen. ").toUpperCase().slice(0, 16);
}

function star(cx: number, cy: number, outer: number, inner: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

const INK = "#0d1117";

function svg(name: string): string {
  const fringe = (x0: number) =>
    Array.from({ length: 6 }, (_, i) => `M${x0 + 4 + i * 6} 140v${i === 0 || i === 5 ? 6 : 8}`).join("");
  return `<svg width="150" height="186" viewBox="0 -8 150 186" style="overflow:visible;display:block">
<defs>
  <filter id="jevc-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <pattern id="jevc-scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" opacity=".35"/></pattern>
  <clipPath id="jevc-clip"><rect x="32" y="52" width="74" height="60" rx="10"/></clipPath>
  <radialGradient id="jevc-bg" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#12352a"/><stop offset="1" stop-color="#050e0a"/></radialGradient>
</defs>
<g id="jevc-body">
  <path d="M6 178 C8 150 22 134 44 130 L106 130 C128 134 142 150 144 178 Z" fill="#2f3d2b" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M58 130 L75 158 L92 130 Z" fill="#e9e1cb" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M71 136 L75 160 L79 136 Z" fill="#c0392b" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
  <rect x="12" y="127" width="36" height="12" rx="5" fill="#ffd166" stroke="${INK}" stroke-width="3"/>
  <rect x="102" y="127" width="36" height="12" rx="5" fill="#ffd166" stroke="${INK}" stroke-width="3"/>
  <path d="${fringe(12)}${fringe(102)}" stroke="#ffd166" stroke-width="2.5" stroke-linecap="round"/>
  <rect x="97" y="146" width="9" height="6" fill="#53e3a6" stroke="${INK}" stroke-width="1.5"/><circle cx="101.5" cy="157" r="4" fill="#ffd166" stroke="${INK}" stroke-width="1.5"/>
  <rect x="109" y="146" width="9" height="6" fill="#ff6b6b" stroke="${INK}" stroke-width="1.5"/><circle cx="113.5" cy="157" r="4" fill="#ffd166" stroke="${INK}" stroke-width="1.5"/>
  <rect x="62" y="118" width="26" height="14" fill="#1c1f24" stroke="${INK}" stroke-width="3"/>
  <g id="jevc-head">
    <rect x="20" y="42" width="110" height="82" rx="16" fill="#efe6cf" stroke="${INK}" stroke-width="4"/>
    <path d="M24 108 H126 V110 Q126 120 114 120 H36 Q24 120 24 110 Z" fill="#d9cdb0"/>
    <rect x="30" y="50" width="78" height="64" rx="12" fill="${INK}"/>
    <rect x="32" y="52" width="74" height="60" rx="10" fill="url(#jevc-bg)"/>
    <g clip-path="url(#jevc-clip)">
      <g id="jevc-face" filter="url(#jevc-glow)" fill="#53e3a6" stroke="#53e3a6" stroke-linecap="round" stroke-linejoin="round">
        <g id="jevc-eyes"></g>
        <g id="jevc-mouth"></g>
      </g>
      <g id="jevc-noise" fill="#e8fff4"></g>
      <rect x="32" y="52" width="74" height="60" fill="url(#jevc-scan)"/>
      <rect id="jevc-roll" x="32" y="52" width="74" height="9" fill="#53e3a6" opacity=".07"/>
      <path d="M38 58 Q50 54 64 55 L40 72 Z" fill="#fff" opacity=".08"/>
    </g>
    <circle cx="119" cy="64" r="5.5" fill="#c9bb98" stroke="${INK}" stroke-width="2.5"/><path d="M119 60v4" stroke="${INK}" stroke-width="2"/>
    <circle cx="119" cy="81" r="5.5" fill="#c9bb98" stroke="${INK}" stroke-width="2.5"/><path d="M116 79l3 2" stroke="${INK}" stroke-width="2"/>
    <path d="M113 94h12M113 99h12M113 104h12" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>
    <g id="jevc-cap">
      <path d="M106 18 L121 -1" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <circle id="jevc-led" cx="122" cy="-3" r="4.5" fill="#5a1d1d" stroke="${INK}" stroke-width="2"/>
      <path d="M26 44 C22 26 36 12 75 10 C114 12 128 26 124 44 Z" fill="#2f3d2b" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
      <rect x="26" y="33" width="98" height="11" fill="#1d2619" stroke="${INK}" stroke-width="3"/>
      <path d="M31 38.5 H119" stroke="#ffd166" stroke-width="2" stroke-dasharray="4 3"/>
      <path d="M17 46 Q75 63 133 46 L128 40 Q75 53 22 40 Z" fill="#14181d" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <polygon points="${star(75, 23, 8.5, 3.6)}" fill="#ffd166" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
    </g>
  </g>
  <rect x="33" y="158" width="84" height="17" rx="3" fill="#ffd166" stroke="${INK}" stroke-width="3"/>
  <text x="75" y="170.5" text-anchor="middle" font-size="10" font-weight="900" fill="${INK}" font-family="Arial Black, Arial, sans-serif" letter-spacing=".6">${escapeXml(plate(name))}</text>
</g>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function html(name: string): string {
  return `<div id="jevc-bubble" style="position:absolute;left:6px;bottom:198px;max-width:360px;background:#fff;color:${INK};border:3px solid ${INK};border-radius:16px;padding:8px 13px 10px;box-shadow:4px 4px 0 ${INK};font:800 16px/1.3 'Helvetica Neue',Arial,sans-serif;transform-origin:30px 100%;transform:scale(.6);opacity:0;transition:transform .18s cubic-bezier(.3,1.6,.6,1),opacity .15s">
  <div id="jevc-reply" style="display:none;font:800 12px/1.2 'Helvetica Neue',Arial,sans-serif;color:#0f7a50;margin-bottom:3px"></div>
  <div><span id="jevc-shown"></span><span id="jevc-rest" style="color:transparent"></span></div>
  <div style="position:absolute;left:44px;bottom:-12px;width:18px;height:18px;background:#fff;border-right:3px solid ${INK};border-bottom:3px solid ${INK};transform:rotate(45deg)"></div>
</div>
<div id="jevc-avatar" style="position:absolute;left:0;bottom:0;width:150px;height:186px;filter:drop-shadow(0 3px 6px rgba(0,0,0,.45))">${svg(name)}</div>`;
}

// The page side: builds the character once per page load and runs its
// animation loop. Idempotent; returns true when it's there.
export function installExpression(name: string): string {
  return `(() => {
  if (window.__jevc && document.getElementById("jev-commentator")) return true;
  const root = document.createElement("div");
  root.id = "jev-commentator";
  Object.assign(root.style, { position: "fixed", left: "12px", bottom: "12px", width: "380px", height: "400px", zIndex: "2147483000", pointerEvents: "none" });
  root.innerHTML = ${JSON.stringify(html(name))};
  (document.body ?? document.documentElement).append(root);
  const $ = (id) => root.querySelector("#" + id);
  const eyes = $("jevc-eyes"), mouth = $("jevc-mouth"), face = $("jevc-face"), noise = $("jevc-noise");
  const head = $("jevc-head"), cap = $("jevc-cap"), body = $("jevc-body"), led = $("jevc-led"), roll = $("jevc-roll");
  const bubble = $("jevc-bubble"), reply = $("jevc-reply"), shown = $("jevc-shown"), rest = $("jevc-rest");
  const COLOR = { neutral: "#53e3a6", happy: "#53e3a6", smug: "#53e3a6", angry: "#ff6b6b", sad: "#7fb2ff", shocked: "#ffe066" };
  const R = (x, y, w, h, r) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '"/>';
  const P = (d, w) => '<path d="' + d + '" fill="none" stroke-width="' + w + '"/>';
  const EYES = {
    neutral: R(46, 66, 12, 16, 4) + R(80, 66, 12, 16, 4),
    happy: P("M45 80 Q52 65 59 80", 4.5) + P("M79 80 Q86 65 93 80", 4.5),
    angry: R(46, 71, 12, 12, 3) + R(80, 71, 12, 12, 3) + P("M42 62 L60 69", 4) + P("M96 62 L78 69", 4),
    shocked: '<circle cx="52" cy="73" r="8" fill="none" stroke-width="4"/><circle cx="86" cy="73" r="8" fill="none" stroke-width="4"/><circle cx="52" cy="73" r="2.6"/><circle cx="86" cy="73" r="2.6"/>',
    smug: R(46, 73, 12, 8, 3) + R(80, 73, 12, 8, 3) + P("M44 71 H60", 3.5) + P("M78 63 Q86 58 94 63", 3.5),
    sad: R(46, 71, 12, 12, 3) + R(80, 71, 12, 12, 3) + P("M43 67 L60 61", 4) + P("M95 67 L78 61", 4),
  };
  const REST = {
    neutral: R(59, 95, 20, 3.5, 1.7),
    happy: P("M57 92 Q69 104 81 92", 4),
    smug: P("M59 97 Q72 100 81 91", 4),
    angry: P("M56 98 L62 94 L69 98 L76 94 L82 98", 3.5),
    sad: P("M58 100 Q69 91 80 100", 4),
    shocked: '<ellipse cx="69" cy="97" rx="6" ry="7" fill="none" stroke-width="3.5"/>',
  };
  const s = { mood: "neutral", idle: "neutral", line: null, blinkAt: 0, moodAt: 0, noiseUntil: 0, hideAt: 0, lastEyes: "", lastMouth: "" };
  const setMood = (m) => {
    if (!EYES[m]) m = "neutral";
    if (m !== s.mood) s.moodAt = performance.now();
    s.mood = m;
    face.setAttribute("fill", COLOR[m]);
    face.setAttribute("stroke", COLOR[m]);
    roll.setAttribute("fill", COLOR[m]);
    if (m === "shocked") s.noiseUntil = performance.now() + 650;
  };
  const say = (u) => {
    const now = performance.now();
    s.line = { ...u, at: now };
    setMood(u.mood);
    reply.style.display = u.replyTo ? "block" : "none";
    reply.textContent = u.replyTo ? "replying to @" + u.replyTo : "";
    shown.textContent = "";
    rest.textContent = u.text;
    bubble.style.opacity = "1";
    bubble.style.transform = "scale(1)";
    s.hideAt = now + u.durMs + 2600;
    return true;
  };
  const frame = (now) => {
    if (!root.isConnected) return;
    const line = s.line;
    const t = line ? now - line.at : 0;
    const talking = line && t < line.durMs;
    const amp = talking && line.env.length ? (line.env[Math.min(line.env.length - 1, Math.floor(t / 40))] || 0) : talking ? 0.5 + 0.5 * Math.sin(t / 70) : 0;
    if (line) {
      const n = Math.min(line.text.length, Math.ceil(line.text.length * Math.min(1, t / Math.max(1, line.durMs * 0.92))));
      if (shown.textContent.length !== n) { shown.textContent = line.text.slice(0, n); rest.textContent = line.text.slice(n); }
      if (!talking && s.mood !== s.idle && t > line.durMs + 1200) setMood(s.idle);
    }
    if (s.hideAt && now > s.hideAt) { bubble.style.opacity = "0"; bubble.style.transform = "scale(.6)"; s.hideAt = 0; s.line = null; }
    if (now > s.blinkAt + 140 && Math.random() < 0.006) s.blinkAt = now;
    const blink = now - s.blinkAt < 130 && s.mood !== "happy";
    const eyesKey = s.mood + (blink ? "b" : "");
    if (eyesKey !== s.lastEyes) {
      eyes.innerHTML = EYES[s.mood];
      eyes.setAttribute("transform", blink ? "translate(0 74) scale(1 .12) translate(0 -74)" : "");
      s.lastEyes = eyesKey;
    }
    let m;
    if (talking && s.mood === "shocked") m = '<ellipse cx="69" cy="97" rx="' + (5 + 3 * amp).toFixed(1) + '" ry="' + (4 + 6 * amp).toFixed(1) + '" fill="none" stroke-width="3.5"/>';
    else if (talking) { const w = 20 + 8 * amp, h = 3.5 + 13 * amp; m = R((69 - w / 2).toFixed(1), (97 - h / 2).toFixed(1), w.toFixed(1), h.toFixed(1), Math.min(6, h / 2).toFixed(1)); }
    else m = REST[s.mood];
    if (m !== s.lastMouth) { mouth.innerHTML = m; s.lastMouth = m; }
    const since = now - s.moodAt;
    const bob = Math.sin(now / 900) * 1.6 + (talking ? Math.sin(now / 110) * amp * 1.4 : 0);
    body.setAttribute("transform", "translate(0 " + bob.toFixed(2) + ")");
    let hx = 0, hr = 0, capY = 0;
    if (s.mood === "angry" && since < 500) hx = Math.sin(now / 25) * 2;
    if (s.mood === "happy") hr = Math.sin(now / 260) * 3;
    if (s.mood === "sad") hr = -4;
    if (s.mood === "shocked" && since < 700) capY = -16 * Math.sin((since / 700) * Math.PI);
    head.setAttribute("transform", "translate(" + hx.toFixed(2) + " 0) rotate(" + hr.toFixed(2) + " 75 124)");
    cap.setAttribute("transform", "translate(0 " + capY.toFixed(2) + ")" + (s.mood === "smug" ? " rotate(-5 75 44)" : ""));
    led.setAttribute("fill", talking ? (amp > 0.35 ? "#ff4d4d" : "#c43a3a") : Math.floor(now / 1200) % 2 ? "#5a1d1d" : "#7a2828");
    roll.setAttribute("y", String(52 + ((now / 30) % 70) - 9));
    if (now < s.noiseUntil) {
      let n = "";
      for (let i = 0; i < 36; i++) n += R((32 + Math.random() * 72).toFixed(0), (52 + Math.random() * 58).toFixed(0), (2 + Math.random() * 9).toFixed(0), "2", 0);
      noise.innerHTML = n;
    } else if (noise.innerHTML) noise.innerHTML = "";
    requestAnimationFrame(frame);
  };
  window.__jevc = { say, mood: (m) => { s.idle = m; if (!s.line) setMood(m); return true; } };
  setMood("neutral");
  requestAnimationFrame(frame);
  return true;
})()`;
}

export function sayExpression(u: Utterance): string {
  return `(() => window.__jevc ? window.__jevc.say(${JSON.stringify(u)}) : false)()`;
}

// The face between lines: sad while Jev is out, happy after a win.
export function moodExpression(m: Mood): string {
  return `(() => window.__jevc ? window.__jevc.mood(${JSON.stringify(m)}) : false)()`;
}

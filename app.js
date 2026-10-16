// Lobo Mau+ (Apneia+) — tela e busca. O núcleo testável fica em core.js.
import * as core from "./core.js";

const LS_PREFIX = "lmplus:";   // separa os dados deste app dos do Mergulho+ (mesmo site)
const DB_NAME = "lobomauplus-fachadas";
const ORT_VERSION = "1.20.1";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const TINY_MODEL = "CAg6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN";
const PREFEITURA = "https://www.goiania.go.gov.br/sistemas/sccer/asp/sccer00201f0.asp";
const PAGE = 15;          // resultados por vez (botão +15)
const FIRST_CHECK = 30;   // a dupla verificação olha estes primeiros lotes antes de mostrar os 15
const NAME_MAX = 100;
const FIRST_YEAR = 2026;
const $ = (id) => document.getElementById(id);

let packs = [];            // todos os pacotes (de todos os anos)
let ownerIdx = new Map();  // dono -> lotes (no ano escolhido, em todos os condomínios)
let sessionP = null;
let queryURL = null;
let mode = "foto";         // "foto" | "area" | "nome": tipo da última busca
let shown = [];            // lotes na tela, em ordem
let pending = [];          // ainda não mostrados (para o +15)
let mainURLs = [];
let searchSeq = 0;
let lastQuery = null;      // { queries, cells, file, fromCamera, pos, heading }
let pickerAt = 0;          // abriu câmera/álbum/importar/Safari: não travar ao voltar
let exByInsc = new Map();  // aprimoramento: exemplos confirmados com o V (inscrição -> exemplos)
const aprimOn = () => load("aprim") === "1";

// ------------------------------------------------------------ banco local (IndexedDB)
let dbP = openDB();
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await dbP;
  return new Promise((res, rej) => {
    const t = db.transaction("kv", mode), s = t.objectStore("kv");
    const req = fn(s);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbGet = (k) => tx("readonly", (s) => s.get(k));
const dbPut = (k, v) => tx("readwrite", (s) => s.put(v, k));
const dbKeys = () => tx("readonly", (s) => s.getAllKeys());
function store(k, v) { try { localStorage.setItem(LS_PREFIX + k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(LS_PREFIX + k); } catch (e) { return null; } }

// ------------------------------------------------------------ utilidades
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), 2000);
}
function setStatus(main, sub = "") {
  $("status").innerHTML = "";
  $("status").append(main);
  if (sub) { const s = document.createElement("small"); s.textContent = sub; $("status").append(s); }
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast(msg);
}
const copyInsc = (insc) => copyText(insc, `Inscrição ${insc} copiada`);
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }
function num(v) {     // "1.234,56" / "360,00" / "245.3" / 245.3 -> número
  if (v == null || v === "") return NaN;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/[^\d.,-]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  return parseFloat(s);
}
function fmtNum(v) { const n = num(v); return isFinite(n) ? n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : ""; }
function fmtArea(v) { const s = fmtNum(v); return s ? s + " m²" : "—"; }
function fmtDoc(v) {
  const d = core.digits(v);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return d || "";
}
function pick(it, keys) {
  for (const k of keys) if (it[k] != null && String(it[k]).trim() !== "") return String(it[k]).trim();
  return "";
}
function quadraLote(it) {    // campo próprio do pacote; se faltar, lê do endereço ("QD. 12 LT. 05")
  let q = pick(it, ["qd", "quadra"]), l = pick(it, ["lt", "lote"]);
  const txt = [it.end, it.nome].filter(Boolean).join(" ");
  if (!q) { const m = txt.match(/\bQ(?:UADRA|DA?)\b\.?\s*[:ºª°-]?\s*([0-9]+[A-Z]?)/i); if (m) q = m[1]; }
  if (!l) { const m = txt.match(/\bL(?:OTE|TE?)\b\.?\s*[:ºª°-]?\s*([0-9]+[A-Z]?(?:[-/][0-9]+[A-Z]?)?)/i); if (m) l = m[1]; }
  return { q, l };
}
function qlText(it) { const { q, l } = quadraLote(it); return `Quadra ${q || "—"} · Lote ${l || "—"}`; }
const posText = (it) => (it.pos ? (core.isCorner(it) ? "Esquina" : "Centro") : "");
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_V = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ICON_MAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.8 6.6l8.2 6.4 8.2-6.4"/></svg>';
const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/></svg>';

// ------------------------------------------------------------ "Você tem certeza?" no meio da tela
function askSure(detail) {
  return new Promise((res) => {
    const bg = el("div", "ask");
    bg.setAttribute("role", "alertdialog");
    bg.setAttribute("aria-modal", "true");
    const box = el("div", "box");
    box.append(el("h3", "", "Você tem certeza?"));
    if (detail) box.append(el("p", "", detail));
    const nav = el("div", "nav");
    const no = el("button", "", "NÃO"), yes = el("button", "main", "SIM");
    const done = (v) => { bg.remove(); res(v); };
    no.onclick = () => done(false);
    yes.onclick = () => done(true);
    bg.onclick = (e) => { if (e.target === bg) done(false); };
    nav.append(no, yes);
    box.append(nav);
    bg.append(box);
    document.body.append(bg);
    no.focus();
  });
}

// ------------------------------------------------------------ janelas sobrepostas (X no canto e arrastar para a esquerda no topo)
const stack = [];
function openOverlay(title, { full = false, onClose } = {}) {
  const ov = el("div", "ov");
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.style.zIndex = String(60 + stack.length);
  const bar = el("div", "ovbar");
  const h = el("h2", "", title);
  const x = el("button", "x");
  x.innerHTML = ICON_X;
  x.setAttribute("aria-label", "Fechar e voltar");
  x.onclick = closeTop;
  bar.append(h, x);
  const body = el("div", "ovbody" + (full ? " full" : ""));
  ov.append(bar, body);
  // gesto: arrastar para a esquerda começando no topo da janela
  let sx = null, sy = 0;
  ov.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    sx = t.clientY < bar.getBoundingClientRect().bottom + 70 ? t.clientX : null;
    sy = t.clientY;
  }, { passive: true });
  ov.addEventListener("touchend", (e) => {
    if (sx == null) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
    sx = null;
    if (dx < -70 && dy < 60 && stack.length && stack[stack.length - 1].ov === ov) closeTop();
  }, { passive: true });
  document.body.append(ov);
  document.body.classList.add("noscroll");
  const entry = { ov, body, urls: [], onClose };
  stack.push(entry);
  x.focus({ preventScroll: true });
  return entry;
}
function closeTop() {
  const t = stack.pop();
  if (!t) return;
  for (const u of t.urls) URL.revokeObjectURL(u);
  if (t.onClose) t.onClose();
  t.ov.remove();
  if (!stack.length) document.body.classList.remove("noscroll");
}
function closeAllOverlays() { while (stack.length) closeTop(); }

// ------------------------------------------------------------ motor (onnxruntime-web)
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.append(s);
  });
}
let ortP = null;
function ensureOrt() {
  if (!ortP) ortP = (async () => {
    for (const f of ["ort.wasm.min.js", "ort.min.js"]) {
      try { await loadScript(ORT_BASE + f); if (window.ort) break; } catch (e) { /* tenta o próximo */ }
    }
    if (!window.ort) throw new Error("O motor de análise não carregou. Abra o app uma vez com internet.");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = ORT_BASE;
    return window.ort;
  })();
  ortP.catch(() => { ortP = null; });
  return ortP;
}
async function warmUp() {    // 1ª abertura com internet: baixa e guarda o motor para usar offline
  try {
    await ensureOrt();
    const bytes = Uint8Array.from(atob(TINY_MODEL), (c) => c.charCodeAt(0));
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
    await s.run({ x: new ort.Tensor("float32", new Float32Array([1]), [1]) });
  } catch (e) { /* sem internet e ainda sem cópia: tenta de novo na próxima abertura */ }
}
function getSession() {
  if (!sessionP) sessionP = (async () => {
    const blob = await dbGet("model");
    if (!blob) throw new Error("Importe o arquivo modelo-iphone.onnx em Dados.");
    await ensureOrt();
    const s = await ort.InferenceSession.create(new Uint8Array(await blob.arrayBuffer()),
      { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    if (!s.outputNames.includes("patches"))
      throw new Error("Este modelo é o do Mergulho+. Importe o modelo-iphone.onnx novo, gerado pelo Mac atualizado.");
    return s;
  })();
  sessionP.catch(() => { sessionP = null; });
  return sessionP;
}

// ------------------------------------------------------------ foto -> vetor
async function loadImg(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { img, url };
}
function drawRegion(src, sx, sy, sw, sh, tw, th) {
  let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
  const temps = [];
  while (cw / 2 >= tw && ch / 2 >= th) {        // reduz em etapas para não serrilhar
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = document.createElement("canvas");
    c.width = nw; c.height = nh;
    const x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    temps.push(c);
    cur = c; cx = 0; cy = 0; cw = nw; ch = nh;
  }
  return { cur, cx, cy, cw, ch, temps };
}
function toTensor(img, crop, out, offset, maskOut, maskOffset) {
  const [sx, sy, sw, sh] = crop;
  const g = core.letterboxGeometry(sw, sh);
  const r = drawRegion(img, sx, sy, sw, sh, g.nw, g.nh);
  const c = document.createElement("canvas");
  c.width = core.CANVAS; c.height = core.CANVAS;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "rgb(123,116,103)";
  x.fillRect(0, 0, core.CANVAS, core.CANVAS);
  x.imageSmoothingQuality = "high";
  x.drawImage(r.cur, r.cx, r.cy, r.cw, r.ch, g.x0, g.y0, g.nw, g.nh);
  core.rgbaToTensor(x.getImageData(0, 0, core.CANVAS, core.CANVAS).data, out, offset);
  maskOut.set(g.mask, maskOffset);
  for (const t of r.temps) { t.width = 0; t.height = 0; }
  c.width = 0; c.height = 0;
}
// devolve o vetor (1ª etapa) e os pedaços da foto (2ª etapa) de cada variante
async function embed(img, withCenter) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const crops = [[0, 0, W, H]];
  if (withCenter) {
    const dx = Math.floor(W * 0.1), dy = Math.floor(H * 0.1);
    crops.push([dx, dy, W - 2 * dx, H - 2 * dy]);
  }
  const B = crops.length, n = 3 * core.CANVAS * core.CANVAS, g = (core.CANVAS / core.PATCH) ** 2;
  const px = new Float32Array(B * n), mk = new Float32Array(B * g);
  crops.forEach((cr, i) => toTensor(img, cr, px, i * n, mk, i * g));
  const s = await getSession();
  const out = await s.run({
    pixel_values: new ort.Tensor("float32", px, [B, 3, core.CANVAS, core.CANVAS]),
    patch_mask: new ort.Tensor("float32", mk, [B, g]),
  });
  const e = out.embedding.data, dim = e.length / B;
  const p = out.patches.data, D = out.patches.dims[2], per = g * D;
  return {
    queries: crops.map((_, i) => e.slice(i * dim, (i + 1) * dim)),
    cells: crops.map((_, i) => core.patchCells(p.subarray(i * per, (i + 1) * per), D)),
    D,
  };
}

// ------------------------------------------------------------ localização e bússola
function getPosition(timeout) {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); res(v); } };
    const t = setTimeout(() => finish(null), timeout);
    navigator.geolocation.getCurrentPosition(
      (p) => finish({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, source: "gps" }),
      () => finish(null),
      { enableHighAccuracy: true, maximumAge: 60000, timeout });
  });
}
// bússola: ligada junto com o GPS, sem botão. Guarda para onde o iPhone apontava ao fotografar.
let heading = null, headingAt = 0, compassOn = false;
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;          // iPhone
  else if (e.absolute && typeof e.alpha === "number") h = (360 - e.alpha) % 360;
  if (h != null && isFinite(h)) { heading = h; headingAt = Date.now(); }
}
async function startCompass() {      // precisa ser chamada no toque do botão (regra do iPhone)
  if (compassOn) return;
  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
      if (await DeviceOrientationEvent.requestPermission() !== "granted") return;
    }
    window.addEventListener("deviceorientation", onOrient, true);
    window.addEventListener("deviceorientationabsolute", onOrient, true);
    compassOn = true;
  } catch (e) { /* sem bússola: a busca segue só com o GPS */ }
}
const freshHeading = () => (heading != null && Date.now() - headingAt < 120000 ? heading : null);

// ------------------------------------------------------------ dados carregados e filtros
const yearOf = (p) => p.header.ano || +(String(p.header.created || "").slice(0, 4)) || FIRST_YEAR;
const curYear = () => +$("year").value || FIRST_YEAR;
const yearPacks = () => packs.filter((p) => yearOf(p) === curYear());
function scopePacks() {
  const s = $("scope").value;
  return s === "all" ? yearPacks() : yearPacks().filter((p) => p.header.condo === s);
}
function filters() {
  return { corner: $("fCorner").checked, vacant: $("fVacant").checked, qd: $("fQd").value.trim(), lt: $("fLt").value.trim() };
}
function filterText(f) {
  const t = [];
  if (f.corner) t.push("só esquinas");
  if (f.vacant) t.push("só lotes não edificados");
  if (f.qd) t.push(`quadra ${f.qd}`);
  if (f.lt) t.push(`lote ${f.lt}`);
  return t.join(", ");
}
function scopeText(n) {
  const s = $("scope").value;
  return s === "all" ? `${n} ${n === 1 ? "imóvel" : "imóveis"} de todos os condomínios`
                     : `${n} ${n === 1 ? "imóvel" : "imóveis"} de ${s}`;
}
// área: diferença relativa do pior campo pedido (Infinity se faltar o dado)
function areaDiff(it, wantAc, wantAt) {
  let worst = 0;
  for (const [want, raw] of [[wantAc, it.ac], [wantAt, it.at]]) {
    if (!isFinite(want)) continue;
    const have = num(raw);
    if (!isFinite(have)) return Infinity;
    worst = Math.max(worst, Math.abs(have - want) / Math.max(want, 1));
  }
  return worst;
}
function buildOwners() {
  ownerIdx = new Map();
  for (const lot of core.lotsAll(yearPacks())) {
    const k = core.ownerKey(lot.item);
    if (!k) continue;
    if (!ownerIdx.has(k)) ownerIdx.set(k, []);
    ownerIdx.get(k).push(lot);
  }
}
const ownerLots = (it) => { const k = core.ownerKey(it); return (k && ownerIdx.get(k)) || []; };

// ------------------------------------------------------------ fotos de um lote (deslizar para ver a 2ª)
function photoURL(pack, idx, urls) {
  const u = URL.createObjectURL(core.photoBlob(pack, pack.header.items[idx]));
  urls.push(u);
  return u;
}
function carousel(lot, urls, onTap) {
  const wrap = el("div", "picwrap");
  const pics = el("div", "pics");
  lot.photos.forEach((idx, k) => {
    const img = el("img");
    img.src = photoURL(lot.pack, idx, urls);
    img.alt = `Fachada ${lot.insc}${k ? " (2ª foto)" : ""}`;
    img.loading = "lazy";
    if (onTap) img.onclick = onTap;
    pics.append(img);
  });
  wrap.append(pics);
  wrap.current = () => lot.photos[Math.round(pics.scrollLeft / Math.max(1, pics.clientWidth))] ?? lot.photos[0];
  if (lot.photos.length > 1) {
    const c = el("span", "count", `1/${lot.photos.length}`);
    pics.addEventListener("scroll", () => { c.textContent = `${Math.round(pics.scrollLeft / Math.max(1, pics.clientWidth)) + 1}/${lot.photos.length}`; }, { passive: true });
    wrap.append(c);
  }
  return wrap;
}

// ------------------------------------------------------------ cartão de um imóvel
function lotCard(lot, i, ctx) {
  const it = lot.item;
  const card = el("article", "res" + (i === 0 && ctx.first ? " first" : ""));
  const pics = carousel(lot, ctx.urls, () => ctx.onCompare(i));
  const bar = el("div", "picbar");
  const hint = [posText(it), lot.photos.length > 1 ? "2 fotos, deslize para ver a outra" : ""].filter(Boolean).join(" · ");
  bar.append(el("span", "hint", hint));
  const dl = el("button", "dl");
  dl.innerHTML = ICON_DL;
  dl.setAttribute("aria-label", "Baixar imagem com os dados");
  dl.onclick = () => makeJPG(lot, pics.current());
  if (ctx.mode === "foto" && aprimOn() && lastQuery) {
    const v = el("button", "vbtn");
    v.innerHTML = ICON_V;
    v.setAttribute("aria-label", "Esta é a certa");
    v.onclick = () => confirmRight(lot, i, v);
    bar.prepend(v);           // à esquerda, longe da setinha de baixar
  }
  bar.append(dl);

  const meta = el("div", "meta");
  const top = el("div", "top");
  top.append(el("span", "pos", `${i + 1}º`), el("span", "insc", lot.insc), el("span", "sp"));
  const others = ownerLots(it).length - 1;
  if (others > 0) {
    const b = el("button", "own", `+${others}`);
    b.setAttribute("aria-label", `Mais ${others} ${others === 1 ? "imóvel" : "imóveis"} do mesmo proprietário`);
    b.onclick = () => openOwner(lot);
    top.append(b);
  }
  meta.append(top, el("div", "ql", qlText(it)));
  const areas = el("div", "areas");
  for (const [lbl, v] of [["Área construída", it.ac], ["Área total", it.at]]) {
    const d = el("div", "", lbl);
    d.append(el("b", "", fmtArea(v)));
    areas.append(d);
  }
  meta.append(areas);
  const add = (txt, muted) => { if (txt) meta.append(el("div", "line" + (muted ? " muted" : ""), txt)); };
  add(it.nome ? `Proprietário: ${it.nome}` : "");
  add(it.doc ? `CPF/CNPJ: ${fmtDoc(it.doc)}` : "");
  add([lot.pack.header.condo, lot.dist != null ? fmtDist(lot.dist) : ""].filter(Boolean).join(", "));
  add(it.end, true);
  // daqui em diante as linhas ficam à esquerda e o botão WPP encosta à direita, logo acima dos botões
  const endrow = el("div", "endrow"), lines = el("div", "lines");
  endrow.append(lines, wppButton(lot));
  meta.append(endrow);
  const addEnd = (txt) => { if (txt) lines.append(el("div", "line muted", txt)); };
  addEnd(it.oc ? it.oc.charAt(0) + it.oc.slice(1).toLowerCase() : "");
  if (ctx.mode === "foto") {
    const hi = lot.fineHit ?? lot.hit;
    const by = hi === -1 ? " · pelo seu exemplo" : (lot.photos.length > 1 && lot.pack.header.items[hi] && lot.pack.header.items[hi].sec ? " · pela 2ª foto" : "");
    addEnd(`Semelhança ${Math.round((lot.score ?? lot.sim) * 100)}${by}`);
  } else if (ctx.mode === "area") {
    addEnd(lot.diff === 0 ? "Metragem igual" : (lot.diff < 0.001 ? "Diferença menor que 0,1%"
      : `Diferença de ${(lot.diff * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`));
  }
  const acts = el("div", "acts");
  const b1 = el("button", "", "Copiar inscrição");
  b1.onclick = () => copyInsc(lot.insc);
  const b2 = el("button", "", "Copiar dados");
  b2.onclick = () => copyData(lot);
  const b3 = el("button", "", "Negativa");
  b3.onclick = () => openNegativa(lot.insc);
  const b4 = el("button", "", ctx.mode === "foto" ? "Comparar" : "Ver foto");
  b4.onclick = () => ctx.onCompare(i);
  acts.append(b1, b2, b3, b4, locButton(lot, "wide"));
  card.append(pics, bar, meta, acts);
  return card;
}

// ------------------------------------------------------------ lista principal
function clearResults() {
  $("floatQ").classList.remove("on", "big");
  for (const u of mainURLs) URL.revokeObjectURL(u);
  mainURLs = [];
  $("results").innerHTML = "";
  shown = [];
  pending = [];
  $("more").hidden = true;
}
function appendResults(lots) {
  const start = shown.length;
  shown.push(...lots);
  lots.forEach((lot, k) => $("results").append(lotCard(lot, start + k,
    { mode, urls: mainURLs, first: true, onCompare: openCompare })));
  $("more").hidden = !(mode !== "nome" && (pending.length || (mode === "foto" && fotoState && fotoState.ptr < fotoState.order.length)));
}
function showQueryBox(withImg) {
  $("query").hidden = false;
  $("query").classList.toggle("noimg", !withImg);
}

// ------------------------------------------------------------ busca por foto (com dupla verificação, sempre ligada)
let fotoState = null;      // { order (1ª etapa), ptr, pool (verificados ainda não mostrados), q, bonus }
const gpsOn = () => $("gpsOn").checked;

async function handlePhoto(file, fromCamera) {
  if (!file) return;
  const seq = ++searchSeq;
  clearResults();
  mode = "foto";
  lastQuery = null;
  if (queryURL) URL.revokeObjectURL(queryURL);
  queryURL = null;
  showQueryBox(true);
  setStatus("Abrindo a foto…");
  const head = fromCamera ? freshHeading() : null;
  let img;
  try {
    const r = await loadImg(file);
    img = r.img; queryURL = r.url; $("qimg").src = r.url;
  } catch (e) { setStatus("Não consegui abrir essa foto."); return; }
  try {
    setStatus("Analisando a foto…", "Leva alguns segundos.");
    // sem GPS (ex.: foto de uma tela) usa também um recorte central
    const q = await embed(img, !fromCamera || !gpsOn());
    if (seq !== searchSeq) return;
    lastQuery = { ...q, file, fromCamera, pos: undefined, posP: fromCamera ? posPromise : null, heading: head };
    await runPhotoSearch();
  } catch (e) {
    if (seq === searchSeq) setStatus("A busca falhou.", e.message || String(e));
  }
}
async function queryPosition(q) {    // câmera: GPS do iPhone; álbum: GPS gravado na foto
  if (q.pos !== undefined) return q.pos;
  const p = q.fromCamera ? (q.posP || getPosition(20000))
    : q.file.slice(0, 262144).arrayBuffer().then(core.exifGPS).catch(() => null);
  q.pos = await p;
  return q.pos;
}
function photoAreaFilter() {
  const ac = num($("pAc").value), at = num($("pAt").value), tol = +$("pTol").value;
  if (!isFinite(ac) && !isFinite(at)) return null;
  return { ac, at, tol, test: (lot) => areaDiff(lot.item, ac, at) <= tol + 1e-9 };
}
async function runPhotoSearch() {
  const q = lastQuery;
  if (!q) return;
  const seq = ++searchSeq;
  clearResults();
  mode = "foto";
  showQueryBox(true);
  try {
    const useGps = gpsOn(), f = filters(), base = scopePacks();
    let pos = null, lots, where;
    if (useGps) {
      if (q.pos === undefined) setStatus("Aguardando a localização…", "Com céu aberto o GPS funciona mesmo sem internet.");
      pos = await queryPosition(q);
      if (seq !== searchSeq) return;
    }
    const af = photoAreaFilter();
    const keep = (arr) => (af ? arr.filter(af.test) : arr);
    if (useGps && pos) {
      // margem só do quanto o GPS pode errar (com sinal bom, 30 m continua 30 m)
      let radius = Math.max(+$("radius").value, (pos.acc || 0) + 10);
      lots = keep(core.lotsNear(base, pos, radius, f));
      while (lots.length < 5 && radius < 1000) {
        radius = Math.min(1000, radius * 2);
        lots = keep(core.lotsNear(base, pos, radius, f));
      }
      where = `${lots.length} ${lots.length === 1 ? "imóvel" : "imóveis"} num raio de ${fmtDist(radius)}` +
              (pos.source === "foto" ? " do local gravado na foto" : " de você");
      if (!lots.length) where = "Nenhum imóvel perto desse local. Desligue o GPS para buscar em todos.";
    } else {
      lots = keep(core.lotsAll(base, f));
      where = (useGps ? "Sem localização: comparei com " : "GPS desligado: comparei com ") + scopeText(lots.length);
    }
    if (pos) for (const l of lots) if (l.item.lat != null) l.dist = core.distanceM(pos.lat, pos.lon, l.item.lat, l.item.lon);
    const extra = [filterText(f), af ? `área ± ${Math.round(af.tol * 100)}%` : ""].filter(Boolean).join(", ");
    if (extra) where += ` (${extra})`;
    setStatus("Comparando…", where);
    const used = [...new Set(lots.map((l) => l.pack))];
    await Promise.all(used.map(core.loadVectors));
    await Promise.all(used.map(core.loadCells));
    if (seq !== searchSeq) return;
    for (const l of lots) l.extra = exByInsc.get(l.insc) || null;
    core.rankLots(lots, q.queries);
    const h = useGps && pos && pos.source === "gps" ? q.heading : null;
    fotoState = { order: lots, ptr: 0, pool: [], q, bonus: h != null ? (l) => core.compassBonus(l, pos, h) : null };
    nextPhotoPage(FIRST_CHECK);
    setStatus(shown.length ? "Pronto. A mais parecida está em primeiro." : "Nenhum resultado.", where);
  } catch (e) {
    if (seq === searchSeq) setStatus("A busca falhou.", e.message || String(e));
  }
}
// 2ª etapa nos próximos lotes da 1ª etapa, junta com os já verificados e mostra os 15 melhores
function nextPhotoPage(check) {
  const st = fotoState;
  const batch = st.order.slice(st.ptr, st.ptr + check);
  st.ptr += batch.length;
  core.verifyLots(batch, st.q.cells, st.q.D, st.bonus);
  st.pool.push(...batch);
  st.pool.sort((a, b) => b.score - a.score);
  const page = st.pool.splice(0, PAGE);
  appendResults(page);
}

// ------------------------------------------------------------ aprimoramento: "Esta é a certa"
async function thumbOf(file) {
  const { img, url } = await loadImg(file);
  try {
    const W = 240, H = Math.round(img.naturalHeight * W / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    c.getContext("2d").drawImage(img, 0, 0, W, H);
    const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.7));
    c.width = 0; c.height = 0;
    return b;
  } finally { URL.revokeObjectURL(url); }
}
async function confirmRight(lot, i, btn) {
  const q = lastQuery;
  if (!q || btn.classList.contains("done")) return;
  if (!await askSure(`A sua foto vai ser guardada como exemplo do imóvel ${lot.insc}.`)) return;
  try {
    const e = q.queries[0], scale = Math.max(...e.map(Math.abs)) / 127 || 1e-8;
    const emb = Int8Array.from(e, (v) => Math.max(-127, Math.min(127, Math.round(v / scale))));
    const cells = Int8Array.from(q.cells[0], (v) => Math.max(-127, Math.min(127, Math.round(v * 127))));
    await dbPut(`ex:${Date.now()}:${lot.insc}`, {
      insc: lot.insc, condo: lot.pack.header.condo, emb: emb.buffer, scale, cells: cells.buffer,
      thumb: await thumbOf(q.file), date: new Date().toISOString().slice(0, 10),
    });
    // estatística: em que posição a certa estava (para calibrar a busca com o uso real)
    const st = await statsGet();
    st.n++;
    st.pos[Math.min(i + 1, 16)] = (st.pos[Math.min(i + 1, 16)] || 0) + 1;
    if (st.log.length < 2000) st.log.push([i + 1, +lot.sim.toFixed(3), lot.fine == null ? null : +lot.fine.toFixed(3),
      +lot.score.toFixed(3), fotoState && fotoState.bonus ? 1 : 0]);
    await dbPut("stats", st);
    await loadExamples();
    btn.classList.add("done");
    btn.setAttribute("aria-label", "Exemplo guardado");
    toast("Guardado. As próximas buscas vão usar esta foto.");
  } catch (err) { toast("Não consegui guardar o exemplo"); }
}
async function statsGet() { return (await dbGet("stats")) || { n: 0, pos: {}, log: [] }; }

function openExamples() {
  const ov = openOverlay("Exemplos guardados");
  const draw = () => {
    for (const u of ov.urls) URL.revokeObjectURL(u);
    ov.urls.length = 0;
    ov.body.innerHTML = "";
    const all = [...exByInsc.values()].flat().sort((a, b) => String(b.key).localeCompare(String(a.key)));
    if (!all.length) { ov.body.append(el("p", "note", "Nenhum exemplo guardado.")); return; }
    ov.body.append(el("p", "note", "Fotos que você confirmou com o V. Toque em Desfazer se marcou alguma por engano."));
    for (const ex of all) {
      const r = el("div", "exrow");
      const img = el("img");
      if (ex.thumb) { const u = URL.createObjectURL(ex.thumb); ov.urls.push(u); img.src = u; }
      img.alt = `Exemplo de ${ex.insc}`;
      const t = el("div", "t", ex.insc);
      t.append(el("small", "", `${ex.condo || ""} · ${ex.date || ""}`));
      const b = el("button", "", "Desfazer");
      b.onclick = async () => {
        if (!await askSure(`O exemplo do imóvel ${ex.insc} vai ser removido.`)) return;
        await tx("readwrite", (s) => s.delete(ex.key));
        await loadExamples();
        draw();
        toast("Exemplo removido");
      };
      r.append(img, t, b);
      ov.body.append(r);
    }
  };
  draw();
}

// ------------------------------------------------------------ busca por metragem
function searchArea(src) {
  const fromFoto = src === "foto";
  const wantAc = num($(fromFoto ? "pAc" : "aAc").value), wantAt = num($(fromFoto ? "pAt" : "aAt").value);
  const tol = +$(fromFoto ? "pTol" : "aTol").value;
  if (!isFinite(wantAc) && !isFinite(wantAt)) {
    if (src !== "redo") toast(fromFoto ? "Digite a área total ou a construída" : "Digite a área construída, a total, ou as duas");
    return;
  }
  ++searchSeq;
  document.activeElement && document.activeElement.blur();
  clearResults();
  mode = "area";
  lastArea = src === "redo" ? lastArea : (fromFoto ? "foto" : "area");
  showQueryBox(false);
  const f = filters();
  const lots = core.lotsAll(scopePacks(), f);
  const scored = [];
  for (const l of lots) {
    const d = areaDiff(l.item, wantAc, wantAt);
    if (d === Infinity) continue;
    l.diff = d;
    scored.push(l);
  }
  scored.sort((a, b) => a.diff - b.diff);
  const inside = scored.filter((l) => l.diff <= tol + 1e-9);
  const pedido = [isFinite(wantAc) ? `construída ${fmtArea(wantAc)}` : "", isFinite(wantAt) ? `total ${fmtArea(wantAt)}` : ""]
    .filter(Boolean).join(" e ");
  const extra = filterText(f);
  if (inside.length) {
    pending = inside;
    setStatus(`${inside.length} ${inside.length === 1 ? "imóvel encontrado" : "imóveis encontrados"}.`,
              `Área ${pedido}, margem ± ${Math.round(tol * 100)}%, em ${scopeText(lots.length)}${extra ? ` (${extra})` : ""}.`);
  } else {
    pending = scored.slice(0, 10);
    setStatus(pending.length ? "Nenhum dentro da margem. Estes são os mais próximos." : "Nenhum resultado.",
              `Área ${pedido}, em ${scopeText(lots.length)}${extra ? ` (${extra})` : ""}.`);
  }
  appendResults(pending.splice(0, PAGE));
}
let lastArea = "area";

// ------------------------------------------------------------ busca por nome / CPF / inscrição
function searchName(again) {
  const name = core.normText($("nName").value), doc = core.digits($("nDoc").value), insc = core.digits($("nInsc").value);
  const ac = num($("nAc").value), at = num($("nAt").value);
  const f = filters();
  const any = name || doc || insc || isFinite(ac) || isFinite(at) || f.qd || f.lt;
  if (!any) { if (!again) toast("Preencha pelo menos um campo"); return; }
  ++searchSeq;
  document.activeElement && document.activeElement.blur();
  clearResults();
  mode = "nome";
  showQueryBox(false);
  const words = name ? name.split(" ") : [];
  const base = insc ? yearPacks() : scopePacks();          // inscrição: sempre em todos os condomínios
  const found = core.lotsAll(base, f).filter((l) => {
    const it = l.item;
    if (insc && !l.insc.includes(insc)) return false;
    if (doc && !core.digits(it.doc).includes(doc)) return false;
    if (words.length) { const n = core.normText(it.nome); if (!words.every((w) => n.includes(w))) return false; }
    if ((isFinite(ac) || isFinite(at)) && areaDiff(it, ac, at) > 0.05 + 1e-9) return false;
    return true;
  });
  found.sort((a, b) => a.pack.header.condo.localeCompare(b.pack.header.condo, "pt-BR") ||
                       String(a.item.nome || "").localeCompare(String(b.item.nome || ""), "pt-BR") || a.insc.localeCompare(b.insc));
  const where = insc ? "em todos os condomínios" : ($("scope").value === "all" ? "em todos os condomínios" : `em ${$("scope").value}`);
  const extra = filterText(f);
  setStatus(found.length ? `${found.length} ${found.length === 1 ? "imóvel encontrado" : "imóveis encontrados"}` +
                           (found.length > NAME_MAX ? ` (mostrando os ${NAME_MAX} primeiros)` : "") + "."
                         : "Nenhum imóvel encontrado.",
            `Busca ${where}${extra ? ` (${extra})` : ""}.`);
  appendResults(found.slice(0, NAME_MAX));
}

// refaz a última busca quando muda ano, condomínio, filtros, GPS ou raio
function redoSearch() {
  if ($("query").hidden) return;
  if (mode === "foto" && lastQuery) runPhotoSearch();
  else if (mode === "area") searchArea(lastArea === "foto" ? "foto" : "redo");
  else if (mode === "nome") searchName(true);
}
$("more").onclick = () => {
  if (mode === "foto" && fotoState) nextPhotoPage(PAGE);
  else appendResults(pending.splice(0, PAGE));
};

// ------------------------------------------------------------ comparar lado a lado
function openCompare(i) {
  const ov = openOverlay("Comparar");
  ov.body.classList.add("cmp");
  let cur = i;
  const draw = () => {
    for (const u of ov.urls) URL.revokeObjectURL(u);
    ov.urls.length = 0;
    ov.body.innerHTML = "";
    const lot = shown[cur];
    if (mode === "foto" && queryURL) {
      ov.body.append(el("div", "lbl", "Sua foto"));
      const q = el("img", "q"); q.src = queryURL; q.alt = "Sua foto";
      ov.body.append(q);
    }
    const it = lot.item;
    ov.body.append(el("div", "lbl", `${cur + 1}º  ${lot.insc} · ${qlText(it)} · Constr. ${fmtArea(it.ac)} · Total ${fmtArea(it.at)}` +
      (lot.dist != null ? ` · ${fmtDist(lot.dist)}` : "") + (lot.photos.length > 1 ? " · deslize para a 2ª foto" : "")));
    ov.body.append(carousel(lot, ov.urls));
    const nav = el("div", "nav");
    const prev = el("button", "", "Anterior"), next = el("button", "", "Próxima");
    prev.disabled = cur === 0;
    next.disabled = cur === shown.length - 1;
    prev.onclick = () => { cur--; draw(); };
    next.onclick = () => { cur++; draw(); };
    nav.append(prev, next);
    const nav2 = el("div", "nav");
    const cp = el("button", "main", "Copiar inscrição");
    cp.onclick = () => copyInsc(lot.insc);
    const ng = el("button", "", "Negativa");
    ng.onclick = () => openNegativa(lot.insc);
    nav2.append(cp, ng);
    ov.body.append(nav, nav2);
  };
  draw();
}

// ------------------------------------------------------------ todos os imóveis do mesmo proprietário
function factLines(lot, all) {
  const it = lot.item, { q, l } = quadraLote(it);
  const lines = [["INSCRIÇÃO", lot.insc]];
  if (all) lines.push(["PROPRIETÁRIO", it.nome || "—"], ["CPF/CNPJ", fmtDoc(it.doc) || "—"]);
  lines.push(["CONDOMÍNIO", lot.pack.header.condo], ["QUADRA", q || "—"], ["LOTE", l || "—"]);
  if (all && it.end) lines.push(["ENDEREÇO", it.end]);
  lines.push(["ÁREA TOTAL", fmtArea(it.at)], ["ÁREA CONSTRUÍDA", fmtArea(it.ac)]);
  if (all) lines.push(["OCUPAÇÃO", it.oc || "—"]);
  lines.push(["POSIÇÃO", it.pos ? (core.isCorner(it) ? "ESQUINA" : "CENTRO") : "—"]);
  return lines;
}
function factsBox(lot, urls, all, withActions) {
  const box = el("div", "facts");
  const pics = carousel(lot, urls);
  box.append(pics);
  if (withActions) {          // setinha de baixar, à direita, logo abaixo da foto
    const bar = el("div", "picbar");
    bar.append(el("span", "hint", lot.photos.length > 1 ? "2 fotos, deslize para ver a outra" : ""));
    const dl = el("button", "dl");
    dl.innerHTML = ICON_DL;
    dl.setAttribute("aria-label", "Baixar imagem com os dados");
    dl.onclick = () => makeJPG(lot, pics.current());
    bar.append(dl);
    box.append(bar);
  }
  for (const [k, v] of factLines(lot, all)) {
    const d = el("div");
    d.append(el("b", "", k + ": "), document.createTextNode(v));
    box.append(d);
  }
  if (withActions) {
    const er = el("div", "endrow");
    er.append(wppButton(lot));
    box.append(er);
    const acts = el("div", "acts");
    const b1 = el("button", "", "Copiar inscrição");
    b1.onclick = () => copyInsc(lot.insc);
    const b2 = el("button", "", "Copiar texto");
    b2.onclick = () => copyData(lot);
    const b3 = el("button", "", "Negativa");
    b3.onclick = () => openNegativa(lot.insc);
    acts.append(b1, b2, b3, locButton(lot));
    box.append(acts);
  }
  return box;
}
function ownerSorted(lots) {
  return [...lots].sort((a, b) => a.pack.header.condo.localeCompare(b.pack.header.condo, "pt-BR") || a.insc.localeCompare(b.insc));
}
function openOwner(lot) {
  const lots = ownerSorted(ownerLots(lot.item));
  const ov = openOverlay("Imóveis do proprietário");
  const head = el("div", "ownhead");
  head.append(el("div", "", `PROPRIETÁRIO: ${lot.item.nome || fmtDoc(lot.item.doc) || "—"}`),
              el("div", "", `QUANTIDADE DE IMÓVEIS: ${lots.length}`));
  const top = el("div", "nav");
  const sAll = el("button", "main", "Salvar tudo");
  sAll.onclick = () => saveAllJPG(lots, sAll);
  const cAll = el("button", "", "Copiar tudo");
  cAll.onclick = () => copyText(lots.map((l) => dataLines(l).join("\n")).join("\n\n"),
                                `Dados de ${lots.length} ${lots.length === 1 ? "imóvel copiados" : "imóveis copiados"}`);
  top.append(sAll, cAll);
  head.append(top);
  ov.body.append(head);
  let condo = null;
  for (const l of lots) {
    const c = l.pack.header.condo;
    if (c !== condo) {
      condo = c;
      const n = lots.filter((x) => x.pack.header.condo === c).length;
      ov.body.append(el("div", "ctitle", `${c} (${n} ${n === 1 ? "imóvel" : "imóveis"})`));
    }
    ov.body.append(factsBox(l, ov.urls, false, true));
  }
}

// ------------------------------------------------------------ Negativa: página da Prefeitura
function openSafari(url) {
  pickerAt = Date.now();          // ao voltar do Safari não pede o código de novo
  window.open(url, "_blank", "noopener");
}
// abre direto no navegador (dentro do app a página da Prefeitura trava). A inscrição vai copiada.
function openNegativa(insc) {
  try { navigator.clipboard.writeText(insc).catch(() => {}); } catch (e) {}
  openSafari(PREFEITURA);
  toast(`Inscrição ${insc} copiada. Cole no campo da Prefeitura.`);
}

// ------------------------------------------------------------ ver todas as fotos do condomínio
function openAllPhotos() {
  const s = $("scope").value;
  if (s === "all") { toast("Escolha um condomínio em Procurar em"); return; }
  const f = filters();
  const lots = core.lotsAll(scopePacks(), f).sort((a, b) => {
    const A = quadraLote(a.item), B = quadraLote(b.item);
    return A.q.localeCompare(B.q, "pt-BR", { numeric: true }) || A.l.localeCompare(B.l, "pt-BR", { numeric: true }) || a.insc.localeCompare(b.insc);
  });
  const extra = filterText(f);
  const ov = openOverlay(`${s} (${lots.length})`, { onClose: () => io.disconnect() });
  if (extra) ov.body.append(el("p", "note", `Filtro: ${extra}.`));
  if (!lots.length) ov.body.append(el("p", "note", "Nenhum imóvel com esses filtros."));
  const grid = el("div", "grid");
  // carrega a foto só quando ela aparece na tela (condomínio grande tem centenas)
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      const img = e.target;
      img.src = photoURL(img._lot.pack, img._lot.photos[0], ov.urls);
      io.unobserve(img);
    }
  }, { root: ov.body, rootMargin: "400px" });
  for (const lot of lots) {
    const t = el("div", "tile");
    const img = el("img");
    img.alt = `Fachada ${lot.insc}`;
    img._lot = lot;
    img.onclick = () => openInfo(lot);
    const cap = el("div", "cap", qlText(lot.item));
    cap.append(el("small", "", lot.insc));
    const b = el("button", "info", "i");
    b.setAttribute("aria-label", `Dados do imóvel ${lot.insc}`);
    b.onclick = () => openInfo(lot);
    t.append(img, cap, b);
    grid.append(t);
    io.observe(img);
  }
  ov.body.append(grid);
}
function allDataText(lot) {
  return factLines(lot, true).map(([k, v]) => `${k}: ${v}`).join("\n");
}
function openInfo(lot) {
  const ov = openOverlay(`Imóvel ${lot.insc}`);
  ov.body.append(factsBox(lot, ov.urls, true));
  const others = ownerLots(lot.item).length - 1;
  const er = el("div", "endrow");
  er.style.justifyContent = "flex-end";
  er.append(wppButton(lot));
  ov.body.append(er);
  const nav = el("div", "nav");
  const b1 = el("button", "main", "Copiar inscrição");
  b1.onclick = () => copyInsc(lot.insc);
  const b2 = el("button", "", "Copiar todos os dados");
  b2.onclick = () => copyText(allDataText(lot), "Dados do imóvel copiados");
  nav.append(b1, b2);
  const nav2 = el("div", "nav");
  const b3 = el("button", "", "Negativa");
  b3.onclick = () => openNegativa(lot.insc);
  nav2.append(b3, locButton(lot));
  if (others > 0) {
    const b4 = el("button", "", `+${others} do proprietário`);
    b4.onclick = () => openOwner(lot);
    nav2.append(b4);
  }
  ov.body.append(nav, nav2);
}

// ------------------------------------------------------------ imagem JPG (foto + dados, estilo Bloco de Notas)
// os 6 dados do imóvel, em caixa alta (usados no JPG e em "Copiar dados")
function dataLines(lot) {
  const it = lot.item, { q, l } = quadraLote(it);
  return [
    `INSCRIÇÃO: ${lot.insc}`,
    `NOME: ${(it.nome || "—").toUpperCase()}`,
    `CPF/CNPJ: ${fmtDoc(it.doc) || "—"}`,
    `ENDEREÇO: ${["QD. " + (q || "—"), "LT. " + (l || "—"), lot.pack.header.condo].join(" ").toUpperCase()}`,
    `ÁREA TOTAL: ${fmtNum(it.at) ? fmtNum(it.at) + " M²" : "—"}`,
    `ÁREA CONSTRUÍDA: ${fmtNum(it.ac) ? fmtNum(it.ac) + " M²" : "—"}`,
  ];
}
const copyData = (lot) => copyText(dataLines(lot).join("\n"), "Dados do imóvel copiados");

// ------------------------------------------------------------ mensagem de abordagem (WhatsApp)
const LINKING = new Set(["do", "da", "de", "dos", "das", "e", "d", "du", "di"]);
function titleCase(txt) {
  return String(txt || "").toLowerCase().split(/(\s+|-)/).map((w, i) => {
    if (!w.trim() || w === "-") return w;
    if (i > 0 && LINKING.has(w)) return w;                 // palavras de ligação ficam minúsculas
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join("");
}
function firstName(nome) {
  const w = String(nome || "").trim().split(/\s+/)[0] || "";
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : "";
}
function wppMessage(lot) {
  const nome = firstName(lot.item.nome);
  return [
    "Olá! Sou George Queiroz, especialista em imóveis de Alto Padrão em Goiânia.",
    "",
    nome ? `Por gentileza, falo com ${nome}?` : "Por gentileza, falo com o(a) proprietário(a)?",
    "",
    `Se sim, gostaria de ajudar você a vender seu imóvel no ${titleCase(lot.pack.header.condo)}.`,
    "",
    "Posso trabalhar a venda do seu imóvel pela nossa imobiliária Adão AlphaMall?",
  ].join("\n");
}
function wppButton(lot) {
  const b = el("button", "wpp");
  b.innerHTML = ICON_MAIL + "<span>WPP</span>";
  b.setAttribute("aria-label", "Copiar mensagem para o WhatsApp");
  b.onclick = () => copyText(wppMessage(lot), "Mensagem copiada. Cole no WhatsApp.");
  return b;
}

// localização do lote (centro do PIN) com links do Google Maps e do Waze, para colar no WhatsApp
function copyLocation(lot) {
  const it = lot.item;
  if (it.lat == null || it.lon == null) { toast("Este imóvel não tem localização no KMZ"); return; }
  const { q, l } = quadraLote(it);
  const ll = `${(+it.lat).toFixed(6)},${(+it.lon).toFixed(6)}`;
  copyText([
    `INSCRIÇÃO: ${lot.insc}`,
    `QD. ${q || "—"} LT. ${l || "—"} ${lot.pack.header.condo}`.toUpperCase(),
    `Google Maps: https://maps.google.com/?q=${ll}`,
    `Waze: https://waze.com/ul?ll=${ll}&navigate=yes`,
  ].join("\n"), "Localização copiada. Cole no WhatsApp.");
}
function locButton(lot, cls) {
  const b = el("button", cls || "", "Copiar localização");
  b.onclick = () => copyLocation(lot);
  if (lot.item.lat == null) b.disabled = true;
  return b;
}

const JPG_FONT = (fs) => `${fs}px Inconsolata, Consolas, "Lucida Console", "Courier New", monospace`;
async function photoImage(lot, idx) {
  const url = URL.createObjectURL(core.photoBlob(lot.pack, lot.pack.header.items[idx]));
  const img = new Image();
  img.src = url;
  try { await img.decode(); } finally { URL.revokeObjectURL(url); }
  return img;
}
// uma ou várias fachadas, uma embaixo da outra, cada uma com os seus dizeres (estilo Bloco de Notas)
async function composeJPG(entries, W) {
  const fs = Math.round(W / 30), lh = Math.round(fs * 1.45), pad = Math.round(fs * 0.8);
  const font = JPG_FONT(fs);
  try { await document.fonts.load(font); } catch (e) {}
  const c = document.createElement("canvas"), x = c.getContext("2d");
  x.font = font;
  const blocks = entries.map(({ img, lines }) => {
    const wrap = [];
    for (const ln of lines) {          // quebra a linha se não couber, como o Bloco de Notas
      let cur = "";
      for (const w of ln.split(" ")) {
        const t = cur ? cur + " " + w : w;
        if (x.measureText(t).width > W - 2 * pad && cur) { wrap.push(cur); cur = w; } else cur = t;
      }
      wrap.push(cur);
    }
    const ph = Math.round(img.naturalHeight * W / img.naturalWidth);
    return { img, wrap, ph, h: ph + pad * 2 + wrap.length * lh };
  });
  const gap = Math.round(lh * 1.2);
  c.width = W;
  c.height = blocks.reduce((s, b) => s + b.h, 0) + gap * (blocks.length - 1);
  x.fillStyle = "#FFFFFF";
  x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingQuality = "high";
  let y = 0;
  for (const b of blocks) {
    x.drawImage(b.img, 0, y, W, b.ph);
    x.font = font;
    x.fillStyle = "#000000";
    x.textBaseline = "top";
    b.wrap.forEach((t, k) => x.fillText(t, pad, y + b.ph + pad + k * lh));
    y += b.h + gap;
  }
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  c.width = 0; c.height = 0;
  return blob;
}
async function shareFiles(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    pickerAt = Date.now();
    try { await navigator.share({ files }); } catch (e) { /* cancelou */ }
    pickerAt = 0;
    return;
  }
  for (const f of files) {
    const a = el("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
}
async function makeJPG(lot, idx) {
  try {
    const img = await photoImage(lot, idx);
    const blob = await composeJPG([{ img, lines: dataLines(lot) }], Math.max(960, img.naturalWidth));
    await shareFiles([new File([blob], `${lot.insc}.jpg`, { type: "image/jpeg" })]);
  } catch (e) { toast("Não consegui gerar a imagem"); }
}
// "Salvar tudo": todas as fachadas do proprietário numa imagem só. O iPhone não desenha imagens
// gigantes, então acima de 25 imóveis o arquivo é dividido em partes (todas salvas de uma vez).
const PER_IMAGE = 25;
async function saveAllJPG(lots, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  try {
    const files = [], parts = Math.ceil(lots.length / PER_IMAGE);
    const nome = core.normText(lots[0].item.nome || "proprietario").replace(/[^A-Z0-9]+/g, "_").slice(0, 40) || "proprietario";
    for (let p = 0; p < parts; p++) {
      btn.textContent = parts > 1 ? `Gerando ${p + 1} de ${parts}…` : "Gerando…";
      const chunk = lots.slice(p * PER_IMAGE, (p + 1) * PER_IMAGE);
      const entries = [];
      for (const l of chunk) entries.push({ img: await photoImage(l, l.photos[0]), lines: dataLines(l) });
      const blob = await composeJPG(entries, 720);
      files.push(new File([blob], parts > 1 ? `${nome}_${p + 1}de${parts}.jpg` : `${nome}.jpg`, { type: "image/jpeg" }));
    }
    btn.textContent = old;
    await shareFiles(files);
  } catch (e) { toast("Não consegui gerar a imagem"); }
  finally { btn.textContent = old; btn.disabled = false; }
}

// ------------------------------------------------------------ dados (importar / apagar)
// nome de exibição e ordem dos condomínios (o pacote do Mac guarda o nome da pasta)
const CONDO_NAMES = [
  ["Araguaia", "Alphaville Araguaia"], ["Cruzeiro", "Alphaville Cruzeiro"], ["Goiás", "Alphaville Goiás"],
  ["Ipês", "Alphaville Ipês"], ["Privilege", "Plateau Dor Privilege"], ["Unique", "Plateau Dor Unique"],
  ["Munique", "Jardins Munique"], ["Milão", "Jardins Milão"], ["Paris", "Jardins Paris"], ["Atenas", "Jardins Atenas"],
  ["Valência", "Jardins Valência"], ["Verona", "Jardins Verona"], ["Itália", "Jardins Itália"], ["França", "Jardins França"],
  ["Portal 1", "Portal do Sol 1"], ["Portal 2", "Portal do Sol 2"], ["Portal Garden", "Portal do Sol Garden"],
  ["Portal Green", "Portal do Sol Green"], ["Aldeia", "Aldeia do Vale"], ["Condomínio do Lago", "Condomínio do Lago"],
  ["Granville", "Granville"], ["Florença", "Jardim Florença"], ["Madri", "Jardins Madri"], ["Lisboa", "Jardins Lisboa"],
  ["Jaó", "Setor Jaó"],
];
const CONDO_MAP = new Map(CONDO_NAMES.map(([raw, nice], i) => [core.normText(raw), { nice, i }]));

async function loadPacks() {
  packs = [];
  const keys = (await dbKeys()).filter((k) => String(k).startsWith("pkg:"));
  for (const k of keys) {
    try {
      const p = await core.readPackage((await dbGet(k)).blob);
      p.key = k;
      const m = CONDO_MAP.get(core.normText(p.header.condo));
      p.order = m ? m.i : 999;
      if (m) p.header.condo = m.nice;
      packs.push(p);
    } catch (e) { /* ignora pacote ruim */ }
  }
  packs.sort((a, b) => a.order - b.order || a.header.condo.localeCompare(b.header.condo, "pt-BR"));
}
function fillYears() {
  const sel = $("year"), cur = sel.value || load("year");
  const have = [...new Set(packs.map(yearOf))];
  const max = Math.max(FIRST_YEAR, new Date().getFullYear(), ...have);
  sel.innerHTML = "";
  for (let y = FIRST_YEAR; y <= max; y++) {
    const o = el("option", "", String(y));
    o.value = String(y);
    sel.append(o);
  }
  const best = have.length ? String(Math.max(...have)) : String(FIRST_YEAR);
  sel.value = [...sel.options].some((o) => o.value === cur) && have.includes(+cur) ? cur : best;
}
function fillScope() {
  const sel = $("scope"), cur = sel.value || load("scope") || "all";
  const yp = yearPacks();
  const lotsOf = (p) => core.lotIndex(p).size;
  sel.innerHTML = "";
  const opt = (v, t) => { const o = el("option", "", t); o.value = v; sel.append(o); };
  opt("all", `Todos os condomínios (${yp.reduce((s, p) => s + lotsOf(p), 0)})`);
  for (const p of yp) opt(p.header.condo, `${p.header.condo} (${lotsOf(p)})`);
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
}
async function loadExamples() {
  exByInsc = new Map();
  for (const k of (await dbKeys()).filter((k) => String(k).startsWith("ex:"))) {
    try {
      const r = await dbGet(k);
      const q = new Int8Array(r.emb), emb = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) emb[i] = q[i] * r.scale;
      const ex = { key: k, insc: r.insc, emb, cells: new Int8Array(r.cells), thumb: r.thumb, date: r.date, condo: r.condo };
      if (!exByInsc.has(r.insc)) exByInsc.set(r.insc, []);
      exByInsc.get(r.insc).push(ex);
    } catch (e) { /* exemplo ruim: ignora */ }
  }
}
async function refresh() {
  await loadPacks();
  await loadExamples();
  const hasModel = !!(await dbGet("model"));
  $("welcome").hidden = hasModel && packs.length > 0;
  $("main").hidden = packs.length === 0;
  $("btnClear").hidden = packs.length === 0;
  fillYears();
  fillScope();
  buildOwners();
  if (hasModel) getSession().catch(() => {});
}
$("scope").onchange = () => { store("scope", $("scope").value); redoSearch(); };
$("year").onchange = () => {
  store("year", $("year").value);
  fillScope();
  buildOwners();
  if (!yearPacks().length) toast(`Não há dados de ${$("year").value} importados`);
  redoSearch();
};

async function openData() {
  const ov = openOverlay("Dados no iPhone");
  const render = async () => {
    ov.body.innerHTML = "";
    const model = await dbGet("model");
    const g1 = el("div", "group");
    const r = el("div", "row");
    const d = el("div", "", "Modelo de análise");
    d.append(el("small", "", model ? `Instalado (${(model.size / 1e6).toFixed(0)} MB)` : "Falta importar modelo-iphone.onnx"));
    r.append(d);
    g1.append(r);
    ov.body.append(g1);
    const years = [...new Set(packs.map(yearOf))].sort((a, b) => b - a);
    if (!packs.length) { const g = el("div", "group"); g.append(el("div", "row", "Nenhum condomínio importado.")); ov.body.append(g); }
    for (const y of years) {
      ov.body.append(el("div", "gtitle", `Base de ${y}`));
      const g = el("div", "group");
      for (const p of packs.filter((p) => yearOf(p) === y)) {
        const h = p.header, lots = core.lotIndex(p);
        const row = el("div", "row");
        const info = el("div", "", h.condo);
        const two = [...lots.values()].filter((v) => v.length > 1).length;
        info.append(el("small", "", `${lots.size} imóveis${two ? ` (${two} com 2 fotos)` : ""}, gerado em ${h.created}`));
        row.append(info);           // sem botão de apagar: a base só é substituída importando de novo
        g.append(row);
      }
      ov.body.append(g);
    }
    ov.body.append(el("div", "gtitle", "Aprimoramento"));
    const ga = el("div", "group");
    const ra = el("div", "row");
    const da = el("div", "", "Ativar Aprimoramento");
    da.append(el("small", "", "Mostra o botão V nos resultados da busca por foto"));
    const swa = el("label", "switch");
    swa.innerHTML = '<input type="checkbox" aria-label="Ativar Aprimoramento"><span></span>';
    const ia = swa.querySelector("input");
    ia.checked = aprimOn();
    ia.onchange = () => {
      store("aprim", ia.checked ? "1" : "0");
      toast(ia.checked ? "Aprimoramento ativado" : "Aprimoramento desativado");
      if (mode === "foto" && shown.length) { $("results").innerHTML = ""; appendResults(shown.splice(0)); }
    };
    ra.append(da, swa);
    const nEx = [...exByInsc.values()].reduce((s, v) => s + v.length, 0);
    const st = await statsGet();
    const rb = el("div", "row");
    const db_ = el("div", "", `Exemplos guardados: ${nEx}`);
    const first = st.n ? Math.round(100 * (st.pos[1] || 0) / st.n) : null;
    db_.append(el("small", "", st.n ? `A certa veio em 1º em ${first}% das ${st.n} confirmações` : "Nenhuma confirmação ainda"));
    rb.append(db_);
    if (nEx) { const bv = el("button", "", "Ver"); bv.style.color = "var(--accent)"; bv.onclick = openExamples; rb.append(bv); }
    ga.append(ra, rb);
    ov.body.append(ga);
    ov.body.append(el("div", "gtitle", "Segurança"));
    const g3 = el("div", "group");
    const r1 = el("div", "row");
    const d1 = el("div", "", "Código de acesso");
    d1.append(el("small", "", "Pedido ao abrir e ao voltar para o app"));
    const bp = el("button", "", "Trocar");
    bp.style.color = "var(--accent)";
    bp.onclick = () => startChangePin();
    r1.append(d1, bp);
    const r2 = el("div", "row");
    const avail = await faceAvailable();
    const d2 = el("div", "", "Desbloquear com Face ID");
    d2.append(el("small", "", avail ? "Se falhar, o código continua valendo" : "Não disponível neste aparelho"));
    const sw = el("label", "switch");
    sw.innerHTML = '<input type="checkbox" aria-label="Desbloquear com Face ID"><span></span>';
    const inp = sw.querySelector("input");
    inp.checked = !!(lockCfg && lockCfg.face);
    inp.disabled = !avail;
    inp.onchange = async () => {
      if (inp.checked) {
        try { await faceRegister(); toast("Face ID ativado"); }
        catch (e) { inp.checked = false; alert("Não consegui ativar o Face ID."); }
      } else { lockCfg.face = null; await dbPut(LOCK_KEY, lockCfg); toast("Face ID desligado"); }
    };
    r2.append(d2, sw);
    g3.append(r1, r2);
    ov.body.append(g3);
    const bi = el("button", "big primary", "Importar arquivos");
    bi.onclick = pickImport;
    ov.body.append(bi);
    const note = el("p", "note", "");
    try {
      const est = await navigator.storage.estimate();
      note.textContent = `Usando ${(est.usage / 1e6).toFixed(0)} MB. Os arquivos ficam só neste iPhone, dentro do app.`;
    } catch (e) {}
    ov.body.append(note);
  };
  ov.render = render;
  await render();
  dataOv = ov;
  ov.onClose = () => { dataOv = null; };
}
let dataOv = null;

async function importFiles(files) {
  let ok = 0;
  const msgs = [];
  for (const f of files) {
    try {
      const head = new TextDecoder().decode(new Uint8Array(await f.slice(0, 8).arrayBuffer()));
      if (head === "LOBOMAU1") {
        const blob = new Blob([f], { type: "application/octet-stream" });
        const p = await core.readPackage(blob);
        if (p.header.model !== core.MODEL_TAG) { msgs.push(`${f.name}: gerado pelo Mac antigo. Exporte de novo com o Mac atualizado.`); continue; }
        await dbPut(`pkg:${yearOf(p)}:${p.header.condo}`, { blob, created: p.header.created });
        ok++;
      } else if (f.name.toLowerCase().endsWith(".onnx")) {
        await dbPut("model", new Blob([f], { type: "application/octet-stream" }));
        sessionP = null;
        ok++;
      } else {
        msgs.push(`${f.name}: não é um arquivo do Lobo Mau+`);
      }
    } catch (e) { msgs.push(`${f.name}: ${e.message}`); }
  }
  try { await navigator.storage.persist(); } catch (e) {}
  await refresh();
  if (dataOv) await dataOv.render();
  toast(`${ok} ${ok === 1 ? "arquivo importado" : "arquivos importados"}`);
  if (msgs.length) alert(msgs.join("\n"));
}
function pickImport() { pickerAt = Date.now(); $("inImport").value = ""; $("inImport").click(); }

// ------------------------------------------------------------ chaves, abas e botões
function syncGps() {
  const on = gpsOn();
  $("radius").disabled = !on;
  $("gpsHint").textContent = on ? "Só imóveis perto de você (ou do local da foto)" : "Desligado: compara com todos";
}
$("gpsOn").checked = load("gpsOn") !== "0";
if (load("radius")) $("radius").value = load("radius");
syncGps();
$("gpsOn").onchange = () => { store("gpsOn", gpsOn() ? "1" : "0"); syncGps(); if (gpsOn()) startCompass(); redoSearch(); };
$("radius").onchange = () => { store("radius", $("radius").value); if (gpsOn()) redoSearch(); };
for (const id of ["fCorner", "fVacant"]) {
  $(id).checked = load(id) === "1";
  $(id).onchange = () => { store(id, $(id).checked ? "1" : "0"); redoSearch(); };
}
for (const id of ["fQd", "fLt"]) {
  $(id).addEventListener("change", redoSearch);
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.target.blur(); } });
}
for (const id of ["pAt", "pAc"]) $(id).addEventListener("change", () => { if (mode === "foto") redoSearch(); });
$("pTol").onchange = () => redoSearch();
$("aTol").onchange = () => { if (mode === "area") redoSearch(); };

const TABS = ["foto", "area", "nome"];
function setTab(t) {
  for (const k of TABS) {
    $("tab-" + k).setAttribute("aria-selected", String(t === k));
    $("panel-" + k).hidden = t !== k;
  }
  $("btnAll").hidden = t !== "foto";
  const slot = document.querySelector(`.qlslot[data-tab="${t}"]`);
  if (slot && $("qlRow").parentNode !== slot) slot.append($("qlRow"));
  store("tab", t);
}
for (const k of TABS) $("tab-" + k).onclick = () => setTab(k);
setTab(TABS.includes(load("tab")) ? load("tab") : "foto");
$("btnArea").onclick = () => searchArea("area");
$("btnShowAll").onclick = () => searchArea("foto");
$("btnNome").onclick = () => searchName();
$("btnAll").onclick = openAllPhotos;
for (const id of ["aAc", "aAt"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") searchArea("area"); });
for (const id of ["nName", "nDoc", "nInsc", "nAt", "nAc"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") searchName(); });

function clearAll() {
  ++searchSeq;
  clearResults();
  closeAllOverlays();
  lastQuery = null;
  fotoState = null;
  if (queryURL) URL.revokeObjectURL(queryURL);
  queryURL = null;
  $("qimg").removeAttribute("src");
  $("floatImg").removeAttribute("src");
  $("query").hidden = true;
  for (const id of ["aAc", "aAt", "pAc", "pAt", "nName", "nDoc", "nInsc", "nAt", "nAc", "fQd", "fLt"]) $(id).value = "";
  $("aTol").value = "0.05";
  $("pTol").value = "0.05";
  $("inCam").value = ""; $("inAlbum").value = "";
  mode = "foto";
  window.scrollTo(0, 0);
  toast("Tudo limpo");
}
$("btnClear").onclick = clearAll;

let posPromise = null;
$("btnCam").onclick = () => {
  pickerAt = Date.now();
  if (gpsOn()) { startCompass(); posPromise = getPosition(25000); } else posPromise = null;
  $("inCam").value = "";
  $("inCam").click();
};
$("btnAlbum").onclick = () => { pickerAt = Date.now(); $("inAlbum").value = ""; $("inAlbum").click(); };
$("inCam").onchange = (e) => { pickerAt = 0; handlePhoto(e.target.files[0], true); };
$("inAlbum").onchange = (e) => { pickerAt = 0; handlePhoto(e.target.files[0], false); };
$("btnImport1").onclick = pickImport;
$("inImport").onchange = (e) => importFiles([...e.target.files]);
$("btnData").onclick = openData;

// ------------------------------------------------------------ bloqueio
// 1ª abertura: senha de instalação (3 erros = apaga tudo). Depois: código próprio de 4 a 6 números
// (ou Face ID). 3 erros no código: só a senha mãe libera, e em seguida cria-se um código novo.
// As senhas fixas ficam só como "impressão digital" (PBKDF2), nunca escritas no código.
const FIXED = {
  inicial: { salt: "apneia+:inicial:v1", len: 4, hash: "bdb805d1265e8ca0d140c9ff708fc6a2622b96635d2a98ed61874a80ddfbdc21" },
  mae: { salt: "apneia+:mae:v1", len: 6, hash: "ee2a306319804124f124b535963099ed28d2b5dcffd9f6a78b01043316d8a249" },
};
const FIXED_ITER = 310000;
const LOCK_KEY = "lock";      // no banco local: { salt, hash, len, face, fails, needMae }
const DEAD_KEY = "dead";      // marcado depois da autodestruição
const MAX_FAILS = 3;
let lockCfg = null;
let lockMode = "unlock";      // inicial | unlock | mae | setup1 | setup2 | change1 | change2 | dead
let entry = "", firstPin = "";
let busy = false;
const PICKER_GRACE = 3 * 60 * 1000;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function pbkdf2(pin, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}
async function checkFixed(pin, which) {
  const f = FIXED[which];
  return hex(await pbkdf2(pin, new TextEncoder().encode(f.salt), FIXED_ITER)) === f.hash;
}
async function savePin(pin) {
  const salt = rnd(16);
  lockCfg = { salt: b64(salt), hash: b64(await pbkdf2(pin, salt, 150000)), len: pin.length,
              face: lockCfg ? lockCfg.face : null, fails: 0, needMae: false };
  await dbPut(LOCK_KEY, lockCfg);
}
async function checkPin(pin) { return b64(await pbkdf2(pin, unb64(lockCfg.salt), 150000)) === lockCfg.hash; }

// Face ID (autenticador do próprio iPhone)
async function faceAvailable() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch (e) { return false; }
}
async function faceRegister() {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rnd(32),
    rp: { name: "Acesso" },
    user: { id: rnd(16), name: "acesso", displayName: "Acesso" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
    timeout: 60000, attestation: "none",
  } });
  lockCfg.face = b64(cred.rawId);
  await dbPut(LOCK_KEY, lockCfg);
}
async function faceVerify() {
  await navigator.credentials.get({ publicKey: {
    challenge: rnd(32),
    allowCredentials: [{ type: "public-key", id: unb64(lockCfg.face), transports: ["internal", "hybrid"] }],
    userVerification: "required", timeout: 60000,
  } });
  return true;
}

// erros na senha mãe: espera 30 s a cada 3 (não apaga nada: a base já está no aparelho)
function maeFail() { try { return JSON.parse(load("maeFail") || '{"n":0,"until":0}'); } catch (e) { return { n: 0, until: 0 }; } }
function setMaeFail(v) { store("maeFail", JSON.stringify(v)); }

const TITLES = {
  inicial: "Digite a senha de instalação",
  unlock: "Digite o código",
  mae: "Digite a senha mãe",
  setup1: "Crie um código de 4 a 6 números",
  setup2: "Repita o código",
  change1: "Digite o código novo (4 a 6 números)",
  change2: "Repita o código novo",
  dead: "App bloqueado",
};
function wantLen() {
  if (lockMode === "inicial") return FIXED.inicial.len;
  if (lockMode === "mae") return FIXED.mae.len;
  if (lockMode === "unlock") return lockCfg.len;
  if (lockMode === "setup2" || lockMode === "change2") return firstPin.length;
  return 0;                     // criando: 4 a 6, confirma no botão
}
function drawDots() {
  const box = $("lockDots");
  box.innerHTML = "";
  const n = wantLen() || Math.max(4, Math.min(6, entry.length + (entry.length < 6 ? 1 : 0)));
  for (let i = 0; i < n; i++) { const d = el("i"); if (i < entry.length) d.className = "on"; box.append(d); }
}
function lockMsg(t, err) { $("lockMsg").textContent = t || ""; $("lockMsg").classList.toggle("err", !!err); }
function shake() { const d = $("lockDots"); d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake"); }
function showLockUI() {
  $("lockTitle").textContent = TITLES[lockMode];
  const dead = lockMode === "dead";
  $("lockPad").hidden = dead;
  $("lockDots").hidden = dead;
  $("lockOk").hidden = !(lockMode === "setup1" || lockMode === "change1");
  $("lockOk").disabled = entry.length < 4;
  $("lockCancel").hidden = !((lockMode.startsWith("change") || lockMode === "mae") && changeByUser && lockCfg && !lockCfg.needMae);
  $("lockForgot").hidden = lockMode !== "unlock";
  $("lockFace").hidden = !(lockMode === "unlock" && lockCfg && lockCfg.face);
  drawDots();
}
function setLock(m, msg, err) {
  lockMode = m; entry = ""; if (!m.endsWith("2")) firstPin = "";
  document.documentElement.classList.add("locked");
  lockMsg(msg || "", err);
  showLockUI();
}
const isLocked = () => document.documentElement.classList.contains("locked");
function lockNow() {
  if (!lockCfg || lockMode === "dead") return;
  changeByUser = false;
  setLock(lockCfg.needMae ? "mae" : "unlock",
          lockCfg.needMae ? "Código errado 3 vezes. Só a senha mãe libera o app." : "");
}
function unlockNow() {
  entry = "";
  document.documentElement.classList.remove("locked", "shield");
}
async function tryFace(auto) {
  if (!lockCfg || !lockCfg.face || lockMode !== "unlock") return;
  try { if (await faceVerify()) { lockCfg.fails = 0; await dbPut(LOCK_KEY, lockCfg); unlockNow(); } }
  catch (e) { if (!auto) lockMsg("Face ID não funcionou. Use o código.", true); }
}

// autodestruição: apaga tudo o que o app guardou neste iPhone e fica bloqueado de vez
async function selfDestruct() {
  try { (await dbP).close(); } catch (e) {}
  await new Promise((r) => { const q = indexedDB.deleteDatabase(DB_NAME); q.onsuccess = q.onerror = q.onblocked = r; });
  try { Object.keys(localStorage).filter((k) => k.startsWith(LS_PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
  try { for (const k of await caches.keys()) if (k.startsWith("apneia-")) await caches.delete(k); } catch (e) {}
  try {
    for (const r of await navigator.serviceWorker.getRegistrations())
      if (new URL(r.scope).pathname === new URL("./", location.href).pathname) await r.unregister();
  } catch (e) {}
  store(DEAD_KEY, "1");
  setLock("dead", "Senha errada 3 vezes. Os dados deste app foram apagados. Para usar de novo, apague o ícone e instale outra vez.", true);
}

async function pressKey(k) {
  if (!isLocked() || busy || lockMode === "dead") return;
  if (lockMode === "mae") {
    const f = maeFail();
    if (f.until > Date.now()) { lockMsg(`Muitas tentativas. Espere ${Math.ceil((f.until - Date.now()) / 1000)} s.`, true); return; }
  }
  if (k === "del") entry = entry.slice(0, -1);
  else if (entry.length < 6) entry += k;
  lockMsg("");
  showLockUI();
  const n = wantLen();
  if (!n || entry.length !== n) return;
  const pin = entry;
  busy = true;
  try {
    if (lockMode === "inicial") {
      if (await checkFixed(pin, "inicial")) { store("iniFail", "0"); setLock("setup1", "Agora crie o seu código."); return; }
      const fails = (+load("iniFail") || 0) + 1;
      store("iniFail", String(fails));
      if (fails >= MAX_FAILS) { await selfDestruct(); return; }
      shake(); setLock("inicial", `Senha errada. ${MAX_FAILS - fails === 1 ? "Resta 1 tentativa" : `Restam ${MAX_FAILS - fails} tentativas`}.`, true);
    } else if (lockMode === "unlock") {
      if (await checkPin(pin)) { lockCfg.fails = 0; await dbPut(LOCK_KEY, lockCfg); unlockNow(); return; }
      lockCfg.fails = (lockCfg.fails || 0) + 1;
      if (lockCfg.fails >= MAX_FAILS) {
        lockCfg.needMae = true;
        await dbPut(LOCK_KEY, lockCfg);
        shake(); setLock("mae", "Código errado 3 vezes. Só a senha mãe libera o app.", true);
        return;
      }
      await dbPut(LOCK_KEY, lockCfg);
      const left = MAX_FAILS - lockCfg.fails;
      shake(); setLock("unlock", `Código errado. ${left === 1 ? "Resta 1 tentativa" : `Restam ${left} tentativas`}.`, true);
    } else if (lockMode === "mae") {
      if (await checkFixed(pin, "mae")) { setMaeFail({ n: 0, until: 0 }); setLock("change1", "Senha mãe certa. Crie um código novo."); return; }
      const f = maeFail(), c = f.n + 1;
      setMaeFail({ n: c, until: c % 3 === 0 ? Date.now() + 30000 : 0 });
      shake(); setLock("mae", c % 3 === 0 ? "Senha mãe errada. Espere 30 s." : "Senha mãe errada.", true);
    } else if (lockMode === "setup2" || lockMode === "change2") {
      if (pin !== firstPin) {
        shake(); setLock(lockMode === "setup2" ? "setup1" : "change1", "Os códigos não conferem. Comece de novo.", true);
        return;
      }
      const wasSetup = lockMode === "setup2";
      if (pin.length === FIXED.inicial.len && await checkFixed(pin, "inicial")) {
        shake(); setLock(wasSetup ? "setup1" : "change1", "Use um código diferente da senha de instalação.", true);
        return;
      }
      await savePin(pin);
      changeByUser = false;
      setMaeFail({ n: 0, until: 0 });
      unlockNow();
      toast(wasSetup ? "Código criado" : "Código trocado");
      if (wasSetup && await faceAvailable() && confirm("Quer desbloquear também com o Face ID?\n(O código continua valendo se o Face ID falhar.)")) {
        try { await faceRegister(); toast("Face ID ativado"); } catch (e) { alert("Não consegui ativar o Face ID. Tente depois em Dados."); }
      }
    }
  } finally { busy = false; }
}
function confirmFirst() {
  if (entry.length < 4) return;
  const pin = entry, back = lockMode === "setup1" ? "setup1" : "change1";
  firstPin = pin;
  setLock(back === "setup1" ? "setup2" : "change2");
  // a senha de instalação não pode virar o código. Confere em segundo plano (pela impressão
  // digital, sem a senha escrita aqui), sem travar o teclado enquanto você repete o código.
  if (pin.length === FIXED.inicial.len) checkFixed(pin, "inicial").then((same) => {
    if (same && firstPin === pin && (lockMode === "setup2" || lockMode === "change2")) {
      shake(); setLock(back, "Use um código diferente da senha de instalação.", true);
    }
  });
}
let changeByUser = false;       // troca pedida em Dados: pode cancelar
function startChangePin() {
  closeAllOverlays();
  changeByUser = true;
  setLock("mae", "Para trocar o código, digite primeiro a senha mãe.");
}

$("lockPad").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) pressKey(b.dataset.k); });
$("lockDel").onclick = () => pressKey("del");
$("lockOk").onclick = confirmFirst;
$("lockFace").onclick = () => tryFace(false);
$("lockCancel").onclick = () => { if (lockCfg && !lockCfg.needMae) { changeByUser = false; unlockNow(); } };
$("lockForgot").onclick = () => { changeByUser = false; setLock("mae", "Digite a senha mãe para criar um código novo."); };
document.addEventListener("keydown", (e) => {
  if (!isLocked()) return;
  if (/^[0-9]$/.test(e.key)) pressKey(e.key);
  else if (e.key === "Backspace") pressKey("del");
  else if (e.key === "Enter" && !$("lockOk").hidden) confirmFirst();
  else return;
  e.preventDefault();
});

// segundo plano: cobre a tela na hora (alternador de apps) e trava para quando voltar
function blackout() { document.documentElement.classList.add("shield"); }
function goingAway() {
  if (Date.now() - pickerAt < PICKER_GRACE) return;     // foi à câmera, ao álbum, ao Safari ou ao compartilhar
  blackout();
  lockNow();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") goingAway();
  else {
    document.documentElement.classList.remove("shield");
    if (pickerAt && Date.now() - pickerAt > 1500) pickerAt = 0;
    if (isLocked() && lockMode === "unlock" && lockCfg && lockCfg.face) tryFace(true);
  }
});
window.addEventListener("pagehide", goingAway);
document.addEventListener("freeze", goingAway);
window.addEventListener("blur", () => { if (Date.now() - pickerAt > PICKER_GRACE) blackout(); });
window.addEventListener("focus", () => {
  if (document.visibilityState !== "visible") return;
  document.documentElement.classList.remove("shield");
  if (pickerAt && Date.now() - pickerAt > 1500) pickerAt = 0;
});

async function initLock() {
  if (load(DEAD_KEY) === "1") { setLock("dead", "Este app foi bloqueado. Para usar de novo, apague o ícone e instale outra vez.", true); return false; }
  try { lockCfg = (await dbGet(LOCK_KEY)) || null; } catch (e) { lockCfg = null; }
  if (!lockCfg) { setLock("inicial", "Primeira abertura."); return true; }
  if (lockCfg.needMae) { setLock("mae", "Código errado 3 vezes. Só a senha mãe libera o app."); return true; }
  setLock("unlock");
  if (lockCfg.face) tryFace(true);
  return true;
}

// ------------------------------------------------------------ botão "topo" e foto flutuante
function onScroll() {
  const y = window.scrollY || document.documentElement.scrollTop;
  $("toTop").classList.toggle("on", y > 500);
  const q = $("query");
  const past = !q.hidden && q.getBoundingClientRect().bottom < 0;
  const show = past && mode === "foto" && !!queryURL && shown.length > 0;
  if (show && $("floatImg").src !== queryURL) $("floatImg").src = queryURL;
  $("floatQ").classList.toggle("on", show);
  if (!show) $("floatQ").classList.remove("big");
}
window.addEventListener("scroll", onScroll, { passive: true });
$("toTop").onclick = () => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  const y0 = window.scrollY;
  setTimeout(() => { if (window.scrollY >= y0 && window.scrollY > 0) window.scrollTo(0, 0); }, 600);
};
$("floatQ").onclick = () => $("floatQ").classList.toggle("big");

// ------------------------------------------------------------ início
(async () => {
  const alive = await initLock();
  if (!alive) return;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  await refresh();
  warmUp();
})();


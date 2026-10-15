// Núcleo do Lobo Mau+ (Apneia+) — sem dependência de tela, testável.
export const MODEL_TAG = "dinov2s-280-v2";   // pacotes do Mac com dupla verificação
export const CANVAS = 280;
export const PATCH = 14;
export const MEAN = [0.485, 0.456, 0.406];
export const STD = [0.229, 0.224, 0.225];

// ------------------------------------------------------------ pacotes .lobomau
export async function readPackage(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const magic = new TextDecoder().decode(head.slice(0, 8));
  if (magic !== "LOBOMAU1") throw new Error("Arquivo não é um pacote do Lobo Mau.");
  const len = new DataView(head.buffer).getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(await blob.slice(12, 12 + len).arrayBuffer()));
  return { header: h, base: 12 + len, blob, emb: null, scales: null };
}

export async function loadVectors(pack) {
  if (pack.emb) return pack;
  const { header: h, base, blob } = pack;
  pack.emb = new Int8Array(await blob.slice(base + h.emb[0], base + h.emb[0] + h.emb[1]).arrayBuffer());
  pack.scales = new Float32Array(await blob.slice(base + h.scales[0], base + h.scales[0] + h.scales[1]).arrayBuffer());
  return pack;
}

// células da dupla verificação (só são lidas quando a 2ª etapa precisa delas)
export async function loadCells(pack) {
  if (pack.cells || !pack.header.cells) return pack;
  const { header: h, base, blob } = pack;
  pack.cells = new Int8Array(await blob.slice(base + h.cells[0], base + h.cells[0] + h.cells[1]).arrayBuffer());
  const pca = new Float32Array(await blob.slice(base + h.pca[0], base + h.pca[0] + h.pca[1]).arrayBuffer());
  pack.pcaMu = pca.subarray(0, h.patch_dim);
  pack.pcaP = pca.subarray(h.patch_dim);           // patch_dim x cell_dim
  return pack;
}

export function photoBlob(pack, item) {
  const s = pack.base + item.off;
  return pack.blob.slice(s, s + item.len, "image/jpeg");
}

// ------------------------------------------------------------ distância
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ------------------------------------------------------------ texto e filtros
export function normText(v) {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}
export const digits = (v) => String(v ?? "").replace(/\D/g, "");
const normQL = (v) => normText(v).replace(/[^0-9A-Z]/g, "").replace(/^0+(?=\d)/, "");

export const isCorner = (it) => normText(it.pos) === "ESQUINA";
export const isVacant = (it) => normText(it.oc).includes("NAO EDIFICADO");

// quadra/lote digitados: confere com o campo do pacote ("9-10" aceita 9, 10 ou 9-10)
function qlMatch(have, want) {
  if (!want) return true;
  const w = normQL(want);
  if (!have) return false;
  if (normQL(have) === w) return true;
  return String(have).split(/[-/]|\bE\b/i).some((p) => normQL(p) === w);
}

// f: { corner, vacant, qd, lt }
export function passFilters(it, f) {
  if (f.corner && !isCorner(it)) return false;
  if (f.vacant && !isVacant(it)) return false;
  if (!qlMatch(it.qd, f.qd)) return false;
  if (!qlMatch(it.lt, f.lt)) return false;
  return true;
}

// dono: CPF/CNPJ quando houver; se não, o nome
export function ownerKey(it) {
  const d = digits(it.doc);
  if (d.length >= 11) return "d:" + d;
  const n = normText(it.nome);
  return n ? "n:" + n : "";
}

// ------------------------------------------------------------ lotes (agrupa principal + 2ª foto)
// índice inscrição -> [idx da principal, idx da 2ª] dentro do pacote
export function lotIndex(pack) {
  if (pack.lots) return pack.lots;
  const m = new Map();
  pack.header.items.forEach((it, idx) => {
    if (!m.has(it.insc)) m.set(it.insc, []);
    m.get(it.insc).push(idx);
  });
  for (const v of m.values()) v.sort((a, b) => (pack.header.items[a].sec ? 1 : 0) - (pack.header.items[b].sec ? 1 : 0) || a - b);
  pack.lots = m;
  return m;
}

// um lote: { pack, insc, item (dados da principal), photos: [idx...], dist }
function makeLot(pack, insc) {
  const photos = lotIndex(pack).get(insc);
  return { pack, insc, item: pack.header.items[photos[0]], photos, dist: null };
}

export function lotsAll(packs, f) {
  const out = [];
  for (const p of packs) for (const insc of lotIndex(p).keys()) {
    const lot = makeLot(p, insc);
    if (!f || passFilters(lot.item, f)) out.push(lot);
  }
  return out;
}

export function lotsNear(packs, pos, radius, f) {
  const out = [];
  for (const lot of lotsAll(packs, f)) {
    const it = lot.item;
    if (it.lat == null) continue;
    const d = distanceM(pos.lat, pos.lon, it.lat, it.lon);
    if (d <= radius) { lot.dist = d; out.push(lot); }
  }
  return out;
}

// 1ª etapa: nota de cada lote = melhor nota entre as suas fotos (e as variantes da foto procurada)
export function rankLots(lots, queries) {
  for (const lot of lots) {
    const { emb, scales, header } = lot.pack;
    const dim = header.dim;
    let best = -Infinity, bestIdx = lot.photos[0];
    for (const idx of lot.photos) {
      const off = idx * dim;
      for (const q of queries) {
        let s = 0;
        for (let k = 0; k < dim; k++) s += emb[off + k] * q[k];
        s *= scales[idx];
        if (s > best) { best = s; bestIdx = idx; }
      }
    }
    lot.sim = best;
    lot.hit = bestIdx;
    lot.score = best;
  }
  lots.sort((a, b) => b.sim - a.sim);
  return lots;
}

// ------------------------------------------------------------ 2ª etapa: dupla verificação
// patches (400 x D, normalizados, zero fora da foto) -> células 10x10 normalizadas (igual ao Mac)
export function patchCells(patches, D) {
  const g = Math.round(Math.sqrt(patches.length / D)), h = g / 2;
  const cells = new Float32Array(h * h * D);
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
    const src = (i * g + j) * D, dst = ((i >> 1) * h + (j >> 1)) * D;
    for (let k = 0; k < D; k++) cells[dst + k] += patches[src + k];
  }
  for (let c = 0; c < h * h; c++) {
    let n = 0;
    for (let k = 0; k < D; k++) n += cells[c * D + k] ** 2;
    n = Math.sqrt(n);
    for (let k = 0; k < D; k++) cells[c * D + k] = n > 1e-6 ? cells[c * D + k] / n : 0;
  }
  return cells;
}

// células da foto procurada no espaço reduzido do pacote (cada pacote tem a sua redução)
export function projectCells(cells, pack) {
  const D = pack.header.patch_dim, K = pack.header.cell_dim, n = cells.length / D;
  const mu = pack.pcaMu, P = pack.pcaP, out = new Float32Array(n * K);
  for (let c = 0; c < n; c++) {
    let empty = true;
    for (let k = 0; k < D; k++) if (cells[c * D + k] !== 0) { empty = false; break; }
    if (empty) continue;
    let nr = 0;
    for (let j = 0; j < K; j++) {
      let s = 0;
      for (let k = 0; k < D; k++) s += (cells[c * D + k] - mu[k]) * P[k * K + j];
      out[c * K + j] = s;
      nr += s * s;
    }
    nr = Math.sqrt(nr) || 1;
    for (let j = 0; j < K; j++) out[c * K + j] /= nr;
  }
  return out;
}

// semelhança "pedaço a pedaço": cada pedaço de uma foto procura o mais parecido na outra (nos dois sentidos)
export function cellScore(q, pack, idx) {
  const K = pack.header.cell_dim, n = q.length / K, base = idx * n * K, c = pack.cells;
  const qOn = [], cOn = [];
  for (let i = 0; i < n; i++) {
    let a = false, b = false;
    for (let k = 0; k < K; k++) { if (q[i * K + k] !== 0) a = true; if (c[base + i * K + k] !== 0) b = true; }
    if (a) qOn.push(i);
    if (b) cOn.push(i);
  }
  if (!qOn.length || !cOn.length) return 0;
  const colBest = new Float32Array(n).fill(-Infinity);
  let rowSum = 0;
  for (const i of qOn) {
    let best = -Infinity;
    for (const j of cOn) {
      let s = 0;
      for (let k = 0; k < K; k++) s += q[i * K + k] * c[base + j * K + k];
      s /= 127;
      if (s > best) best = s;
      if (s > colBest[j]) colBest[j] = s;
    }
    rowSum += best;
  }
  let colSum = 0;
  for (const j of cOn) colSum += colBest[j];
  return 0.5 * (rowSum / qOn.length + colSum / cOn.length);
}

// reordena um grupo de lotes com a 2ª etapa. qcellsList: células da foto procurada (uma por variante)
export function verifyLots(lots, qcellsList, D, bonus) {
  const proj = new Map();
  for (const lot of lots) {
    const p = lot.pack;
    let fine = null;
    if (p.cells) {
      if (!proj.has(p)) proj.set(p, qcellsList.map((qc) => projectCells(qc, p)));
      fine = -Infinity;
      for (const idx of lot.photos) for (const q of proj.get(p)) {
        const s = cellScore(q, p, idx);
        if (s > fine) { fine = s; lot.fineHit = idx; }
      }
    }
    lot.fine = fine;
    lot.score = (fine == null ? lot.sim : 0.5 * lot.sim + 0.5 * fine) + (bonus ? bonus(lot) : 0);
  }
  lots.sort((a, b) => b.score - a.score);
  return lots;
}

// ------------------------------------------------------------ bússola
export function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
export const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// casa na direção para onde o iPhone apontava ganha um pouco de nota; atrás de você perde um pouco.
// Pequeno de propósito: só desempata, nunca derruba a foto certa.
export function compassBonus(lot, pos, heading) {
  if (heading == null || !pos || lot.item.lat == null) return 0;
  const d = distanceM(pos.lat, pos.lon, lot.item.lat, lot.item.lon);
  if (d < 6) return 0;                                   // em cima do lote: direção não diz nada
  const diff = angleDiff(heading, bearing(pos.lat, pos.lon, lot.item.lat, lot.item.lon));
  if (diff <= 40) return 0.04;
  if (diff <= 75) return 0.015;
  if (diff >= 120) return -0.03;
  return 0;
}

// ------------------------------------------------------------ pré-processamento
// Máscara dos patches com conteúdo (mesma regra do Mac).
export function letterboxGeometry(w, h) {
  const s = CANVAS / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const x0 = Math.floor((CANVAS - nw) / 2), y0 = Math.floor((CANVAS - nh) / 2);
  const g = CANVAS / PATCH, mask = new Float32Array(g * g);
  let any = false;
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
    const cy = (i + 0.5) * PATCH, cx = (j + 0.5) * PATCH;
    const on = cy >= y0 && cy < y0 + nh && cx >= x0 && cx < x0 + nw;
    mask[i * g + j] = on ? 1 : 0;
    any = any || on;
  }
  if (!any) mask.fill(1);
  return { nw, nh, x0, y0, mask };
}

// RGBA (CANVAS x CANVAS) -> CHW normalizado
export function rgbaToTensor(rgba, out, offset = 0) {
  const n = CANVAS * CANVAS;
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) {
      out[offset + c * n + p] = (rgba[p * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return out;
}

// ------------------------------------------------------------ GPS gravado na foto (EXIF)
export function exifGPS(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      const marker = v.getUint16(o), size = v.getUint16(o + 2);
      if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return parseTiff(v, o + 10);
      if ((marker & 0xff00) !== 0xff00) break;
      o += 2 + size;
    }
  } catch (e) { /* sem EXIF */ }
  return null;
}

function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
  const ifd = (p) => {
    const n = u16(p), tags = {};
    for (let i = 0; i < n; i++) {
      const e = p + 2 + i * 12;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
    }
    return tags;
  };
  const ifd0 = ifd(t + u32(t + 4));
  if (!ifd0[0x8825]) return null;
  const g = ifd(t + u32(ifd0[0x8825].at));
  const rat3 = (tag) => {
    const p = t + u32(tag.at), r = (k) => u32(p + k * 8) / u32(p + k * 8 + 4);
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  const ref = (tag) => String.fromCharCode(v.getUint8(tag.at));
  if (!g[2] || !g[4]) return null;
  let lat = rat3(g[2]), lon = rat3(g[4]);
  if (g[1] && ref(g[1]) === "S") lat = -lat;
  if (g[3] && ref(g[3]) === "W") lon = -lon;
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon, source: "foto" };
}

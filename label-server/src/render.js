import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import QRCode from 'qrcode';
import bwipjs from 'bwip-js';
import { resolveGeometry } from './labels.js';

// ---------- fonts ----------
const FONT_DIRS = [process.env.FONTS_DIR || '/data/fonts', '/usr/share/fonts'];
for (const dir of FONT_DIRS) {
  try { if (fs.existsSync(dir)) GlobalFonts.loadFontsFromDir(dir); } catch { /* ignore */ }
}
const DEFAULT_FONT = process.env.DEFAULT_FONT || 'DejaVu Sans';

// ---------- template text substitution ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
  if (!m) return value || '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

const FILTERS = {
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  date: (v) => formatDate(String(v)),
  trim: (v) => String(v).trim(),
};

export function builtinValues(ctx = {}) {
  const now = new Date();
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return {
    _date: iso,
    _time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    _datetime: `${iso} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    _user: ctx.user || '',
  };
}

export function substitute(str, values) {
  if (str == null) return '';
  return String(str).replace(/\{\{\s*([\w.]+)((?:\s*\|\s*\w+)*)\s*\}\}/g, (_, key, filters) => {
    let v = values[key];
    if (v === undefined || v === null || v === false) v = '';
    if (v === true) v = '✓';
    for (const f of filters.split('|').map((s) => s.trim()).filter(Boolean)) {
      if (FILTERS[f]) v = FILTERS[f](v);
    }
    return String(v);
  });
}

function isEmpty(v) {
  return v === undefined || v === null || v === false || String(v).trim() === '';
}

// ---------- text layout ----------
function fontString(size, el) {
  return `${el.italic ? 'italic ' : ''}${el.bold ? 'bold ' : ''}${size}px "${el.font || DEFAULT_FONT}"`;
}

function breakLongWord(ctx, word, width) {
  const parts = [];
  let cur = '';
  for (const ch of word) {
    if (ctx.measureText(cur + ch).width > width && cur) { parts.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function wrapText(ctx, text, width, wrap) {
  const lines = [];
  for (const para of text.split('\n')) {
    if (!wrap) { lines.push(para); continue; }
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (ctx.measureText(candidate).width <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      if (ctx.measureText(w).width > width) {
        const pieces = breakLongWord(ctx, w, width);
        line = pieces.pop();
        lines.push(...pieces);
      } else line = w;
    }
    lines.push(line);
  }
  return lines;
}

function drawText(ctx, el, text) {
  const { x, y, w, h } = el;
  const lineHeight = el.lineHeight ?? 1.15;
  const wrap = el.wrap !== false;
  const maxSize = el.fontSize ?? 40;
  const minSize = el.fit === false ? maxSize : (el.minFontSize ?? 12);
  const pad = el.padding ?? 0;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  let size = maxSize;
  let lines;
  for (;;) {
    ctx.font = fontString(size, el);
    lines = wrapText(ctx, text, innerW, wrap);
    const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    const total = lines.length * size * lineHeight;
    if ((total <= innerH && widest <= innerW) || size <= minSize) break;
    size -= 1;
  }

  ctx.save();
  if (el.background === 'black') {
    ctx.fillStyle = '#000';
    ctx.fillRect(x, y, w, h);
  }
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = el.background === 'black' ? '#fff' : '#000';
  ctx.textBaseline = 'middle';
  const lh = size * lineHeight;
  const total = lines.length * lh;
  let top = y + pad;
  if (el.valign === 'middle' || el.valign === undefined) top = y + pad + (innerH - total) / 2;
  else if (el.valign === 'bottom') top = y + pad + innerH - total;
  const align = el.align || 'left';
  ctx.textAlign = align;
  const ax = align === 'center' ? x + w / 2 : align === 'right' ? x + w - pad : x + pad;
  lines.forEach((line, i) => ctx.fillText(line, ax, top + lh * i + lh / 2));
  ctx.restore();
}

// ---------- codes ----------
function drawQr(ctx, el, value) {
  if (!value) return;
  const qr = QRCode.create(value, { errorCorrectionLevel: el.ecc || 'M' });
  const count = qr.modules.size;
  const margin = el.margin ?? 0;
  const size = el.size ?? Math.min(el.w, el.h);
  const mod = Math.max(1, Math.floor(size / (count + margin * 2)));
  const drawn = mod * (count + margin * 2);
  // centre inside the requested square
  const ox = Math.round(el.x + (size - drawn) / 2) + margin * mod;
  const oy = Math.round(el.y + (size - drawn) / 2) + margin * mod;
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.modules.get(r, c)) ctx.fillRect(ox + c * mod, oy + r * mod, mod, mod);
    }
  }
}

async function drawBarcode(ctx, el, value) {
  if (!value) return;
  const opts = {
    bcid: el.bcid || 'code128',
    text: value,
    includetext: el.showText !== false,
    textxalign: 'center',
    textsize: el.textSize ?? 10,
    height: el.barHeightMm ?? 10,
  };
  // Render once at scale 1 to learn the natural width, then pick the largest integer scale
  // that fits, so bars stay crisp (non-integer scaling breaks scannability).
  const probe = await loadImage(await bwipjs.toBuffer({ ...opts, scale: 1 }));
  const scale = Math.max(1, Math.floor(el.w / probe.width));
  const img = await loadImage(await bwipjs.toBuffer({ ...opts, scale }));
  const fit = Math.min(1, el.h / img.height);
  const dw = Math.min(img.width, el.w);
  const dh = Math.round(img.height * fit);
  const align = el.align || 'center';
  const dx = align === 'left' ? el.x : align === 'right' ? el.x + el.w - dw : el.x + Math.round((el.w - dw) / 2);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, dx, el.y + Math.round((el.h - dh) / 2), dw, dh);
  ctx.imageSmoothingEnabled = true;
}

async function drawImageEl(ctx, el, template) {
  const file = path.resolve(template._dir, el.src);
  if (!file.startsWith(path.resolve(template._dir))) throw new Error('image path escapes template folder');
  const img = await loadImage(fs.readFileSync(file));
  const scale = Math.min(el.w / img.width, el.h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, el.x + (el.w - dw) / 2, el.y + (el.h - dh) / 2, dw, dh);
}

// ---------- main ----------
/**
 * Render a template with the user's values.
 * Returns { png: Buffer (print-ready, 1-bit black/white), width, height, label }.
 * Pass ctxInfo.preview = true to get the image in reading orientation instead of printer orientation.
 */
export async function renderLabel(template, input = {}, ctxInfo = {}) {
  const geo = resolveGeometry(template);
  const values = { ...builtinValues(ctxInfo) };
  for (const f of template.fields) {
    let v = input[f.name];
    if (v === undefined || v === '') v = f.default ?? '';
    // In previews, show placeholders for *required* fields so an empty form still shows the layout.
    // (Optional fields stay empty so the preview never shows text that won't print.)
    if (ctxInfo.lenient && f.required && isEmpty(v) && f.placeholder) v = f.placeholder;
    if (f.type === 'date' && v === 'today') v = values._date;
    if (f.type === 'checkbox') v =v === true || v === 'true' || v === 'on';
    if (f.required && isEmpty(v) && !ctxInfo.lenient) throw Object.assign(new Error(`"${f.label || f.name}" is required`), { status: 400 });
    if (typeof v === 'string' && f.maxLength) v = v.slice(0, f.maxLength);
    values[f.name] = v;
  }

  const { width, height } = geo.design;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);

  for (const el of template.elements) {
    if (el.showIf && isEmpty(values[el.showIf])) continue;
    if (el.hideIf && !isEmpty(values[el.hideIf])) continue;
    switch (el.type) {
      case 'text': {
        const text = substitute(el.text, values);
        if (text) drawText(ctx, el, text);
        break;
      }
      case 'qr': drawQr(ctx, el, substitute(el.value, values)); break;
      case 'barcode': await drawBarcode(ctx, el, substitute(el.value, values)); break;
      case 'image': await drawImageEl(ctx, el, template); break;
      case 'rect':
        ctx.save();
        if (el.fill) { ctx.fillStyle = '#000'; ctx.fillRect(el.x, el.y, el.w, el.h); } else {
          ctx.lineWidth = el.stroke ?? 3;
          ctx.strokeStyle = '#000';
          const o = ctx.lineWidth / 2;
          ctx.beginPath();
          if (el.radius) ctx.roundRect(el.x + o, el.y + o, el.w - 2 * o, el.h - 2 * o, el.radius);
          else ctx.rect(el.x + o, el.y + o, el.w - 2 * o, el.h - 2 * o);
          ctx.stroke();
        }
        ctx.restore();
        break;
      case 'line':
        ctx.save();
        ctx.lineWidth = el.width ?? 3;
        ctx.strokeStyle = '#000';
        ctx.beginPath();
        ctx.moveTo(el.x1, el.y1);
        ctx.lineTo(el.x2, el.y2);
        ctx.stroke();
        ctx.restore();
        break;
      default:
        throw new Error(`Unknown element type "${el.type}"`);
    }
  }

  // Rotate into printer orientation (printer image is always `printable width` wide).
  // Previews skip this so users see the label the way it reads.
  let out = canvas;
  if (geo.rotate && !ctxInfo.preview) {
    out = createCanvas(geo.print.width, geo.print.height);
    const o = out.getContext('2d');
    // Exact quarter-turn transforms keep pixels on the grid (no half-pixel blur).
    const { width: pw, height: ph } = geo.print;
    if (geo.rotate === 90) o.translate(pw, 0);
    else if (geo.rotate === 180) o.translate(pw, ph);
    else o.translate(0, ph);
    o.rotate((geo.rotate * Math.PI) / 180);
    o.drawImage(canvas, 0, 0);
  }

  // Threshold to pure black/white so the preview is exactly what the printer will produce.
  const octx = out.getContext('2d');
  const img = octx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const threshold = template.threshold ?? 140;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = d[i + 3] < 128 || lum > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);

  return { png: await out.encode('png'), width: out.width, height: out.height, label: template.label, rotate: geo.rotate };
}

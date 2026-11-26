'use strict';

/* =========================================================
   그림판 — 순수 HTML/CSS/JS
   ---------------------------------------------------------
   · 좌표계: 모든 그리기 좌표는 캔버스의 CSS 픽셀 기준.
     실제 비트맵은 devicePixelRatio 배수로 키우고 ctx.setTransform 으로 보정한다.
   · 히스토리: 그리기 연산(op)을 순서대로 쌓고, 되돌리기는 앞에서부터 재생(replay).
     붓 자국은 점 배열만 저장하므로 메모리를 적게 쓰고 60~80단계도 가볍다.
   ========================================================= */

(() => {
  // ── DOM ────────────────────────────────────────────────
  // 실제 그림은 레이어 캔버스들에 그리고, 맨 위 preview 캔버스가 입력·미리보기를 맡는다.
  const preview = document.getElementById('preview');
  const board = preview;
  const stage = document.getElementById('stage');
  const wrap = document.getElementById('wrap');
  const layerBox = document.getElementById('layers');
  const toolbar = document.getElementById('toolbar');
  const swatchWrap = document.getElementById('swatches');
  const colorInput = document.getElementById('colorInput');
  const colorBtn = document.getElementById('colorBtn');
  const colorDialog = document.getElementById('colorDialog');
  const colorSliders = document.getElementById('colorSliders');
  const hexInput = document.getElementById('hexInput');
  const colorPreview = document.getElementById('colorPreview');
  const editBtn = document.getElementById('editBtn');
  const editDialog = document.getElementById('editDialog');
  const layerList = document.getElementById('layerList');
  const bgInput = document.getElementById('bgInput');
  const resizeUnit = document.getElementById('resizeUnit');
  const resizeW = document.getElementById('resizeW');
  const resizeH = document.getElementById('resizeH');
  const resizeLock = document.getElementById('resizeLock');
  const themeSelect = document.getElementById('themeSelect');
  const zoomBadge = document.getElementById('zoomBadge');
  const sizeSlider = document.getElementById('sizeSlider');
  const sizeValue = document.getElementById('sizeValue');
  const sizeDot = document.getElementById('sizeDot');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const clearBtn = document.getElementById('clearBtn');
  const saveBtn = document.getElementById('saveBtn');
  const toastEl = document.getElementById('toast');
  const importBtn = document.getElementById('importBtn');
  const imageInput = document.getElementById('imageInput');
  const shareBtn = document.getElementById('shareBtn');
  const shapeFillBtn = document.getElementById('shapeFillBtn');
  const textEditor = document.getElementById('textEditor');

  let ctx = null;   // 현재 레이어의 컨텍스트 (selectLayer 에서 바뀜)
  const pctx = preview.getContext('2d');

  // ── 상수 ───────────────────────────────────────────────
  const PAPER = '#ffffff';
  const MAX_HISTORY = 80;          // 되돌리기 최대 단계
  const HISTORY_SLACK = 20;        // 이만큼 넘치면 오래된 연산을 바탕 그림으로 한 번에 굳힌다
  const MAX_POINTS = 400000;       // 점 저장량 상한(메모리 보호)
  const FILL_TOLERANCE = 40;       // 페인트통 색 허용 오차
  const MAX_DPR = 3;
  const MAX_ZOOM = 8;
  const TAP_MS = 350;              // 두 손가락 탭으로 인정할 두 번째 손가락 도착 시간
  const TAP_MOVE = 18;             // 두 손가락 탭 중 허용 이동 거리(px)
  const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

  const PALETTE = [
    '#111827', '#64748b', '#ef4444', '#f97316', '#facc15',
    '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  ];

  const TOOLS = {
    pen:         { label: '펜',     width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    brush:       { label: '붓',     width: (s) => s * 1.6, alpha: 1,    composite: 'source-over',    cursor: 'crosshair', soft: true },
    pencil:      { label: '연필',   width: (s) => Math.max(1, s * 0.4), alpha: 1, composite: 'source-over', cursor: 'crosshair' },
    highlighter: { label: '형광펜', width: (s) => s * 2.4, alpha: 0.32, composite: 'source-over',    cursor: 'crosshair' },
    eraser:      { label: '지우개', width: (s) => s * 2.6, alpha: 1,    composite: 'destination-out', cursor: 'cell' },
    line:        { label: '직선',   width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    rect:        { label: '사각형', width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    ellipse:     { label: '원',     width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    fill:        { label: '채우기', width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'copy' },
    text:        { label: '글자',   width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'text' },
    picker:      { label: '스포이트', width: (s) => s,     alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    crop:        { label: '자르기', width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
  };
  // 끌어서 영역을 정하는 도구 (자르기도 같은 흐름을 쓴다)
  const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse', 'crop']);
  // 특정 레이어에 그려지는 연산
  const LAYER_OPS = new Set(['stroke', 'shape', 'fill', 'text', 'image']);
  const FILLABLE_SHAPES = new Set(['rect', 'ellipse']);
  // 누를 때가 아니라 손을 뗄 때 실행하는 도구 (두 손가락 탭과 구분하기 위해)
  const TAP_TOOLS = new Set(['fill', 'text', 'picker']);

  // ── 상태 ───────────────────────────────────────────────
  const state = {
    tool: 'pen',
    color: PALETTE[0],
    size: 6,
    dpr: 1,
    ops: [],          // 커밋된 연산 목록
    index: -1,        // 현재 화면에 반영된 마지막 연산 위치
    pointerId: null,
    pointerType: '',
    penDown: false,
    op: null,         // 진행 중인 붓 연산
    points: [],
    start: null,
    end: null,
    lastMid: null,
    moved: false,
    shift: false,
    downAt: 0,        // 현재 포인터를 누른 시각
    fillShape: false, // 사각형·원 안쪽 채우기
    prevTool: 'pen',  // 스포이트 사용 후 돌아갈 도구
    pickColorBefore: null,
    dirty: false,     // 저장 이후 바뀐 내용이 있는지
    paper: PAPER,     // 배경색 (bg 연산으로 바뀜)
    basePaper: PAPER, // 바탕 그림에 굳혀진 시점의 배경색
    zoom: 1,
    panX: 0,
    panY: 0,
  };

  // ── 레이어 ─────────────────────────────────────────────
  // 레이어마다 캔버스 하나 + 히스토리에서 밀려난 연산을 굳혀 두는 바탕 그림(base) 하나.
  // 화면 합성은 DOM 순서와 CSS opacity 에 맡기고, 저장·스포이트만 직접 합성한다.
  const layers = [];   // 아래 → 위
  let active = null;
  let layerSeq = 0;

  // 두 손가락(세 손가락) 탭 제스처
  let gesture = null;      // { pos: Map<id,{x,y}>, max, start, moved }
  let textEdit = null;     // 글자 입력 중일 때 { x, y, color, size }

  // ── 작은 도우미 ────────────────────────────────────────
  const rgbCache = new Map();
  function hexToRgb(hex) {
    if (rgbCache.has(hex)) return rgbCache.get(hex);
    let v = String(hex).replace('#', '');
    if (v.length === 3) v = v.split('').map((c) => c + c).join('');
    const n = parseInt(v, 16);
    const rgb = Number.isFinite(n)
      ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
      : { r: 0, g: 0, b: 0 };
    rgbCache.set(hex, rgb);
    return rgb;
  }

  const toHex = (r, g, b) => '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h: Math.round(h), s: Math.round(max ? (d / max) * 100 : 0), v: Math.round(max * 100) };
  }

  function hsvToRgb(h, s, v) {
    s /= 100; v /= 100;
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
    };
    return { r: f(5), g: f(3), b: f(1) };
  }

  let toastTimer = 0;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // ── 캔버스 크기 / DPR ──────────────────────────────────
  function resizeCanvases() {
    const rect = stage.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DPR);
    const bitmapW = Math.round(cssW * dpr);
    const bitmapH = Math.round(cssH * dpr);

    if (preview.width === bitmapW && preview.height === bitmapH) return;

    // 크기가 바뀌기 전 그림을 보관해 두었다가 같은 위치에 되살린다.
    const scale = dpr / state.dpr;
    for (const L of layers) {
      resizeKeeping(L.canvas, L.ctx, bitmapW, bitmapH, scale);
      if (!L.baseEmpty) resizeKeeping(L.base, L.bctx, bitmapW, bitmapH, scale);
      else { L.base.width = bitmapW; L.base.height = bitmapH; }
      L.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    preview.width = bitmapW;
    preview.height = bitmapH;
    state.dpr = dpr;

    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.lastMid = null;
    applyView();
  }

  const cssW = () => preview.width / state.dpr;
  const cssH = () => preview.height / state.dpr;

  /** 캔버스 크기를 바꾸면서 기존 비트맵을 같은 배율로 되살린다. */
  function resizeKeeping(cv, c, w, h, scale) {
    let saved = null;
    if (cv.width > 0 && cv.height > 0) {
      saved = document.createElement('canvas');
      saved.width = cv.width;
      saved.height = cv.height;
      saved.getContext('2d').drawImage(cv, 0, 0);
    }
    cv.width = w;
    cv.height = h;
    if (saved) {
      // 비트맵은 기기 픽셀 단위이므로 변환 없이(identity) 같은 배율로 되살린다.
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(saved, 0, 0, saved.width * scale, saved.height * scale);
      c.restore();
    }
  }

  let resizeRaf = 0;
  function scheduleResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(resizeCanvases);
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleResize).observe(stage);
  }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);

  // ── 레이어 관리 ──────────────────────────────────────
  function makeLayer() {
    const canvas = document.createElement('canvas');
    canvas.className = 'layer';
    canvas.width = preview.width;
    canvas.height = preview.height;
    const base = document.createElement('canvas');
    base.width = preview.width;
    base.height = preview.height;
    const L = {
      id: ++layerSeq,
      name: `레이어 ${layerSeq}`,
      canvas,
      ctx: canvas.getContext('2d', { willReadFrequently: true }),
      base,
      bctx: base.getContext('2d'),
      baseEmpty: true,
      opacity: 1,
      visible: true,
    };
    L.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    return L;
  }

  const layerById = (id) => layers.find((L) => L.id === id);

  /** DOM 순서·투명도·보이기를 layers 배열에 맞춘다. */
  function syncLayers() {
    for (const L of layers) {
      layerBox.appendChild(L.canvas);
      L.canvas.style.opacity = String(L.opacity);
      L.canvas.hidden = !L.visible;
    }
    renderLayerList();
  }

  function selectLayer(L) {
    if (!L) return;
    commitText();
    active = L;
    ctx = L.ctx;
    renderLayerList();
  }

  function addLayer() {
    const L = makeLayer();
    layers.splice(active ? layers.indexOf(active) + 1 : layers.length, 0, L);
    syncLayers();
    selectLayer(L);
  }

  function moveLayer(L, dir) {
    const i = layers.indexOf(L);
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    syncLayers();
  }

  function deleteLayer(L) {
    if (layers.length < 2) { toast('레이어는 하나 이상 있어야 해요'); return; }
    if (!window.confirm(`${L.name}을(를) 삭제할까요? 이 레이어의 실행 취소 기록도 함께 사라져요.`)) return;
    commitText();
    // 이 레이어에 그린 연산을 히스토리에서 빼고, 현재 위치를 다시 맞춘다.
    const kept = [];
    let index = -1;
    state.ops.forEach((op, i) => {
      if (op.layer === L.id) return;
      kept.push(op);
      if (i <= state.index) index = kept.length - 1;
    });
    state.ops = kept;
    state.index = index;
    const at = layers.indexOf(L);
    layers.splice(at, 1);
    L.canvas.remove();
    if (active === L) active = layers[Math.max(0, at - 1)];
    syncLayers();
    selectLayer(active);
    updateHistoryButtons();
  }

  function renderLayerList() {
    if (!layerList) return;
    layerList.textContent = '';
    for (const L of [...layers].reverse()) {           // 위 레이어가 목록 위에
      const row = document.createElement('div');
      row.className = 'layer-row' + (L === active ? ' is-active' : '');
      row.dataset.id = String(L.id);
      row.innerHTML = `
        <button type="button" class="layer-name" data-act="select" aria-pressed="${L === active}">${L.name}</button>
        <label class="layer-vis" title="보이기"><input type="checkbox" data-act="visible" ${L.visible ? 'checked' : ''} aria-label="${L.name} 보이기">보이기</label>
        <input type="range" min="0" max="100" value="${Math.round(L.opacity * 100)}" data-act="opacity" aria-label="${L.name} 투명도" title="투명도">
        <button type="button" class="mini-btn" data-act="up" aria-label="${L.name} 위로" title="위로">▲</button>
        <button type="button" class="mini-btn" data-act="down" aria-label="${L.name} 아래로" title="아래로">▼</button>
        <button type="button" class="mini-btn" data-act="del" aria-label="${L.name} 삭제" title="삭제">✕</button>`;
      layerList.appendChild(row);
    }
  }

  /** 보이는 레이어를 배경색 위에 합성한다. 영역을 주면 그 부분만 (기기 픽셀). */
  function composite(sx = 0, sy = 0, w = preview.width, h = preview.height) {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const o = out.getContext('2d', { willReadFrequently: true });
    o.fillStyle = state.paper;
    o.fillRect(0, 0, w, h);
    for (const L of layers) {
      if (!L.visible || !L.opacity) continue;
      o.globalAlpha = L.opacity;
      o.drawImage(L.canvas, sx, sy, w, h, 0, 0, w, h);
    }
    return out;
  }

  function setPaper(color) {
    state.paper = color;
    stage.style.background = color;
    bgInput.value = color;
  }

  // ── 확대/축소 · 이동 (보기만 바뀌고 그림은 그대로) ──────
  function applyView() {
    const z = state.zoom;
    state.panX = Math.min(0, Math.max(cssW() * (1 - z), state.panX));
    state.panY = Math.min(0, Math.max(cssH() * (1 - z), state.panY));
    wrap.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${z})`;
    zoomBadge.hidden = z === 1;
    zoomBadge.textContent = `${Math.round(z * 100)}%`;
  }

  /** (cx, cy) — 화면(stage) 기준 점이 제자리에 있도록 배율을 바꾼다. */
  function setZoom(z, cx = cssW() / 2, cy = cssH() / 2) {
    z = Math.min(MAX_ZOOM, Math.max(1, z));
    const k = z / state.zoom;
    state.panX = cx - (cx - state.panX) * k;
    state.panY = cy - (cy - state.panY) * k;
    state.zoom = z;
    applyView();
  }

  // ── 그리기 기본기 ──────────────────────────────────────
  function applyStyle(c, op) {
    const t = TOOLS[op.tool];
    c.globalAlpha = t.alpha;
    c.globalCompositeOperation = t.composite;
    c.strokeStyle = op.color;
    c.fillStyle = op.color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    // 붓: 가장자리를 부드럽게 (shadowBlur는 변환을 받지 않아 기기 픽셀로 준다)
    c.shadowBlur = t.soft ? op.size * 0.7 * state.dpr : 0;
    c.shadowColor = t.soft ? op.color : 'transparent';
  }

  function segWidth(op, point) {
    const base = TOOLS[op.tool].width(op.size);
    if (!op.pressure || !point || point.p == null) return base;
    return Math.max(0.5, base * (0.35 + point.p * 1.05));
  }

  function drawDot(c, op, point) {
    c.beginPath();
    c.arc(point.x, point.y, Math.max(segWidth(op, point) / 2, 0.5), 0, Math.PI * 2);
    c.fill();
  }

  /** 점 배열 하나를 완성된 붓 자국으로 그린다. (실시간 그리기와 재생이 같은 모양이 되도록) */
  function drawStroke(c, op) {
    const pts = op.points;
    if (!pts || !pts.length) return;
    c.save();
    applyStyle(c, op);

    if (pts.length === 1) {
      drawDot(c, op, pts[0]);
      c.restore();
      return;
    }
    if (op.tool !== 'highlighter') drawDot(c, op, pts[0]);

    let lastMid = { x: pts[0].x, y: pts[0].y };
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const mid = { x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2 };
      c.beginPath();
      c.moveTo(lastMid.x, lastMid.y);
      c.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
      c.lineWidth = segWidth(op, prev);
      c.stroke();
      lastMid = mid;
    }
    const last = pts[pts.length - 1];
    c.beginPath();
    c.moveTo(lastMid.x, lastMid.y);
    c.lineTo(last.x, last.y);
    c.lineWidth = segWidth(op, last);
    c.stroke();
    c.restore();
  }

  function shapeGeometry(op) {
    let x1 = op.start.x;
    let y1 = op.start.y;
    let x2 = op.end.x;
    let y2 = op.end.y;
    if (op.square) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      x2 = x1 + (dx < 0 ? -size : size);
      y2 = y1 + (dy < 0 ? -size : size);
    }
    return { x1, y1, x2, y2 };
  }

  function drawShape(c, op) {
    const { x1, y1, x2, y2 } = shapeGeometry(op);
    c.save();
    applyStyle(c, op);
    c.lineWidth = TOOLS[op.tool].width(op.size);
    c.beginPath();
    if (op.tool === 'line') {
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
    } else if (op.tool === 'rect') {
      c.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else {
      c.ellipse(
        (x1 + x2) / 2, (y1 + y2) / 2,
        Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2,
        0, 0, Math.PI * 2,
      );
    }
    if (op.filled && op.tool !== 'line') c.fill();
    c.stroke();
    c.restore();
  }

  function textFontSize(size) {
    return Math.round(12 + size * 2);
  }

  function textFont(size) {
    return `600 ${textFontSize(size)}px ${FONT_FAMILY}`;
  }

  /** 글자 연산: (x, y)는 글줄의 왼쪽-세로 가운데 */
  function drawText(c, op) {
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = op.color;
    c.font = textFont(op.size);
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.fillText(op.text, op.x, op.y);
    c.restore();
  }

  function drawImageOp(c, op) {
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.imageSmoothingQuality = 'high';
    c.drawImage(op.src, op.x, op.y, op.w, op.h);
    c.restore();
  }

  function clearLayer(L) {
    L.ctx.save();
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
    L.ctx.restore();
  }

  /** 회전·대칭·크기 조정·자르기: 레이어 비트맵을 통째로 바꾼다. */
  function transformLayer(L, op) {
    const cv = L.canvas;
    const w = cv.width;
    const h = cv.height;
    const d = state.dpr;
    if (!w || !h) return;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d').drawImage(cv, 0, 0);
    const c = L.ctx;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    c.imageSmoothingQuality = 'high';
    if (op.kind === 'rotate') {
      // 90° 돌리면 가로·세로가 바뀌므로 그림 전체가 보이게 줄여서 가운데에 둔다.
      const k = Math.min(w / h, h / w);
      c.translate(w / 2, h / 2);
      c.rotate((op.dir * Math.PI) / 2);
      c.scale(k, k);
      c.drawImage(tmp, -w / 2, -h / 2);
    } else if (op.kind === 'flipX') {
      c.translate(w, 0);
      c.scale(-1, 1);
      c.drawImage(tmp, 0, 0);
    } else if (op.kind === 'flipY') {
      c.translate(0, h);
      c.scale(1, -1);
      c.drawImage(tmp, 0, 0);
    } else if (op.kind === 'scale') {
      c.drawImage(tmp, 0, 0, w * op.sx, h * op.sy);
    } else if (op.kind === 'crop') {
      // 고른 영역을 캔버스에 꽉 차게(비율 유지) 가운데로 키운다.
      const k = Math.min(w / (op.w * d), h / (op.h * d));
      const dw = op.w * d * k;
      const dh = op.h * d * k;
      c.drawImage(tmp, op.x * d, op.y * d, op.w * d, op.h * d, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    c.restore();
  }

  function clearPreview() {
    pctx.save();
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.restore();
  }

  // ── 페인트통 (Flood Fill, 스캔라인) ────────────────────
  function floodFill(L, x, y, color) {
    const c0 = L.ctx;
    const w = L.canvas.width;
    const h = L.canvas.height;
    if (!w || !h) return false;
    const sx = Math.floor(x * state.dpr);
    const sy = Math.floor(y * state.dpr);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;

    const img = c0.getImageData(0, 0, w, h);
    const d = img.data;
    const seen = new Uint8Array(w * h);

    const si = (sy * w + sx) * 4;
    const tr = d[si];
    const tg = d[si + 1];
    const tb = d[si + 2];
    const ta = d[si + 3];
    const c = hexToRgb(color);

    if (ta === 255 && tr === c.r && tg === c.g && tb === c.b) return false;

    const TOL = FILL_TOLERANCE;
    const like = (i) => {
      const pi = i >> 2;
      if (seen[pi]) return false;
      const a = d[i + 3];
      if (Math.abs(a - ta) > TOL) return false;
      if (a === 0 && ta === 0) return true;
      return Math.abs(d[i] - tr) <= TOL
        && Math.abs(d[i + 1] - tg) <= TOL
        && Math.abs(d[i + 2] - tb) <= TOL;
    };
    const paint = (i) => {
      d[i] = c.r;
      d[i + 1] = c.g;
      d[i + 2] = c.b;
      d[i + 3] = 255;
      seen[i >> 2] = 1;
    };

    const stack = [sx, sy];
    let filled = 0;
    while (stack.length) {
      const py = stack.pop();
      const px = stack.pop();
      let i = (py * w + px) * 4;
      if (!like(i)) continue;

      let x1 = px;
      while (x1 > 0 && like(i - 4)) { x1--; i -= 4; }

      let spanUp = false;
      let spanDown = false;
      for (let x2 = x1; x2 < w; x2++, i += 4) {
        if (!like(i)) break;
        paint(i);
        filled++;
        if (py > 0) {
          if (like(i - w * 4)) {
            if (!spanUp) { stack.push(x2, py - 1); spanUp = true; }
          } else spanUp = false;
        }
        if (py < h - 1) {
          if (like(i + w * 4)) {
            if (!spanDown) { stack.push(x2, py + 1); spanDown = true; }
          } else spanDown = false;
        }
      }
    }

    if (!filled) return false;

    c0.save();
    c0.setTransform(1, 0, 0, 1, 0, 0);
    c0.putImageData(img, 0, 0);
    c0.restore();
    return true;
  }

  // ── 연산 재생 / 히스토리 ───────────────────────────────
  function paintOp(op) {
    if (op.type === 'clear') { layers.forEach(clearLayer); return; }
    if (op.type === 'xform') { for (const L of layers) transformLayer(L, op); return; }
    if (op.type === 'bg') { setPaper(op.color); return; }
    const L = layerById(op.layer);
    if (!L) return;
    const c = L.ctx;
    if (op.type === 'stroke') drawStroke(c, op);
    else if (op.type === 'shape') drawShape(c, op);
    else if (op.type === 'fill') floodFill(L, op.x, op.y, op.color);
    else if (op.type === 'text') drawText(c, op);
    else if (op.type === 'image') drawImageOp(c, op);
  }

  /** 바탕 그림(히스토리에서 밀려난 연산의 결과)을 깔고 시작한다. */
  function drawBase() {
    setPaper(state.basePaper);
    for (const L of layers) {
      clearLayer(L);
      if (L.baseEmpty) continue;
      L.ctx.save();
      L.ctx.setTransform(1, 0, 0, 1, 0, 0);
      L.ctx.drawImage(L.base, 0, 0);
      L.ctx.restore();
    }
  }

  function replay() {
    drawBase();
    for (let i = 0; i <= state.index; i++) paintOp(state.ops[i]);
    clearPreview();
  }

  /**
   * 히스토리가 넘치면 앞쪽 연산을 바탕 그림에 굳힌다.
   * (예전에는 그냥 버려서, 80단계를 넘긴 뒤 실행 취소하면 처음 그린 그림이 사라졌다)
   * 매번 하면 재생 비용이 크므로 HISTORY_SLACK 만큼 쌓였을 때 한 번에 처리한다.
   */
  function trimHistory() {
    let drop = state.ops.length > MAX_HISTORY + HISTORY_SLACK ? state.ops.length - MAX_HISTORY : 0;
    let total = 0;
    for (const op of state.ops) if (op.points) total += op.points.length;
    for (let i = 0; i < drop; i++) if (state.ops[i].points) total -= state.ops[i].points.length;
    while (total > MAX_POINTS && drop < state.ops.length - 1) {
      if (state.ops[drop].points) total -= state.ops[drop].points.length;
      drop++;
    }
    if (!drop) return;

    // 바탕 + 앞쪽 drop개 → 새 바탕, 이어서 나머지를 재생해 화면을 원래대로 맞춘다.
    drawBase();
    for (let i = 0; i < drop; i++) paintOp(state.ops[i]);
    for (const L of layers) {
      L.base.width = L.canvas.width;
      L.base.height = L.canvas.height;
      L.bctx.drawImage(L.canvas, 0, 0);
      L.baseEmpty = false;
    }
    state.basePaper = state.paper;
    for (let i = drop; i <= state.index; i++) paintOp(state.ops[i]);

    state.ops.splice(0, drop);
    state.index = Math.max(-1, state.index - drop);
  }

  function pushOp(op) {
    if (LAYER_OPS.has(op.type) && op.layer == null) op.layer = active.id;
    if (state.index < state.ops.length - 1) state.ops.length = state.index + 1;
    state.ops.push(op);
    state.index = state.ops.length - 1;
    state.dirty = true;
    trimHistory();
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    undoBtn.disabled = state.index < 0;
    redoBtn.disabled = state.index >= state.ops.length - 1;
  }

  function undo() {
    if (state.pointerId !== null || state.index < 0) return;
    state.index--;
    replay();
    updateHistoryButtons();
  }

  function redo() {
    if (state.pointerId !== null || state.index >= state.ops.length - 1) return;
    state.index++;
    replay();
    updateHistoryButtons();
  }

  function clearAll() {
    if (state.pointerId !== null) return;
    commitText();
    layers.forEach(clearLayer);
    clearPreview();
    pushOp({ type: 'clear' });
    toast('전체 지우기 — 실행 취소로 되돌릴 수 있어요');
  }

  /** 그림 전체(모든 레이어)를 바꾸는 연산: 먼저 그리고 나서 기록한다. */
  function applyXform(op) {
    if (state.pointerId !== null) return;
    commitText();
    op.type = 'xform';
    paintOp(op);
    pushOp(op);
  }

  function changePaper(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color) || color.toLowerCase() === state.paper) return;
    const op = { type: 'bg', color: color.toLowerCase() };
    paintOp(op);
    pushOp(op);
  }

  // ── PNG 저장 / 공유 ───────────────────────────────────
  /** 흰 배경 위에 합성한 PNG Blob을 만든다. */
  function renderPNG() {
    return new Promise((resolve) => {
      if (!preview.width || !preview.height) { resolve(null); return; }
      const out = composite();                   // 투명 대신 배경색을 깔아 PNG에 유지
      if (out.toBlob) out.toBlob(resolve, 'image/png');
      else resolve(null);
    });
  }

  async function savePNG() {
    commitText();
    const blob = await renderPNG();
    if (!blob) { toast('저장에 실패했어요'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `그림판_${stamp()}.png`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    state.dirty = false;
    toast('PNG로 저장했어요');
  }

  // 휴대폰 공유 시트(카톡·메시지·갤러리 등)로 바로 보내기
  function canShareFiles() {
    try {
      return typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && typeof File === 'function'
        && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] });
    } catch (_) {
      return false;
    }
  }

  async function sharePNG() {
    commitText();
    const blob = await renderPNG();
    if (!blob) { toast('이미지를 만들지 못했어요'); return; }
    const file = new File([blob], `그림판_${stamp()}.png`, { type: 'image/png' });
    try {
      await navigator.share({ files: [file], title: '그림판' });
      state.dirty = false;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // 사용자가 공유 창을 닫음
      toast('공유할 수 없어 PNG로 저장할게요');
      savePNG();
    }
  }

  // ── 사진 불러오기 ─────────────────────────────────────
  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  async function importImage(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) { toast('이미지 파일만 불러올 수 있어요'); return; }
    let img;
    try {
      img = await loadImageFile(file);
    } catch (_) {
      toast('사진을 열지 못했어요');
      return;
    }
    const cw = cssW();
    const ch = cssH();
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih || !cw || !ch) return;

    // 캔버스 안에 비율을 유지해 가운데 맞춤 (확대는 하지 않음)
    const fit = Math.min(cw / iw, ch / ih, 1);
    const w = iw * fit;
    const h = ih * fit;

    // 원본 대신 화면 해상도로 줄인 사본을 보관해 메모리를 아낀다.
    const src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(w * state.dpr));
    src.height = Math.max(1, Math.round(h * state.dpr));
    const sctx = src.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img, 0, 0, src.width, src.height);

    const op = { type: 'image', src, x: (cw - w) / 2, y: (ch - h) / 2, w, h };
    drawImageOp(ctx, op);
    pushOp(op);
    toast('사진을 불러왔어요 — 위에 그려 보세요');
  }

  // ── 글자 입력 ─────────────────────────────────────────
  function openTextEditor(p) {
    commitText();
    const fs = textFontSize(state.size);
    const lineH = Math.round(fs * 1.35);
    textEdit = { x: p.x, y: p.y, color: state.color, size: state.size };
    textEditor.value = '';
    textEditor.style.font = textFont(state.size);
    textEditor.style.color = state.color;
    textEditor.style.left = `${p.x}px`;
    textEditor.style.top = `${p.y - lineH / 2}px`;
    textEditor.style.height = `${lineH}px`;
    textEditor.style.lineHeight = `${lineH}px`;
    textEditor.hidden = false;
    sizeTextEditor();
    textEditor.focus({ preventScroll: true });
  }

  function sizeTextEditor() {
    if (!textEdit) return;
    pctx.save();
    pctx.font = textFont(textEdit.size);
    const w = pctx.measureText(textEditor.value || '가나').width;
    pctx.restore();
    const maxW = cssW() - textEdit.x;
    textEditor.style.width = `${Math.max(24, Math.min(maxW, w + textFontSize(textEdit.size)))}px`;
  }

  function commitText() {
    if (!textEdit) return;
    const edit = textEdit;
    textEdit = null;
    const text = textEditor.value.replace(/\s+$/, '');
    textEditor.hidden = true;
    textEditor.value = '';
    if (textEditor === document.activeElement) textEditor.blur();
    if (!text.trim()) return;
    const op = { type: 'text', x: edit.x, y: edit.y, text, color: edit.color, size: edit.size };
    drawText(ctx, op);
    pushOp(op);
  }

  function cancelText() {
    if (!textEdit) return;
    textEdit = null;
    textEditor.hidden = true;
    textEditor.value = '';
    textEditor.blur();
  }

  // ── 스포이트 ──────────────────────────────────────────
  /** 그림의 한 픽셀 색을 화면에 보이는 색으로 읽는다. */
  function pickColorAt(p) {
    const sx = Math.floor(p.x * state.dpr);
    const sy = Math.floor(p.y * state.dpr);
    if (sx < 0 || sy < 0 || sx >= preview.width || sy >= preview.height) return;
    // 보이는 그대로(모든 레이어 + 배경색)의 색을 읽는다.
    const d = composite(sx, sy, 1, 1).getContext('2d').getImageData(0, 0, 1, 1).data;
    setColor(toHex(d[0], d[1], d[2]));
  }

  // ── 입력 처리 ─────────────────────────────────────────
  function pointFromEvent(e) {
    const rect = board.getBoundingClientRect();   // 확대 중이면 배율만큼 커진 크기
    return {
      x: (e.clientX - rect.left) / state.zoom,
      y: (e.clientY - rect.top) / state.zoom,
      p: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : null,
    };
  }

  function cropRect() {
    const x1 = Math.max(0, Math.min(state.start.x, state.end.x));
    const y1 = Math.max(0, Math.min(state.start.y, state.end.y));
    const x2 = Math.min(cssW(), Math.max(state.start.x, state.end.x));
    const y2 = Math.min(cssH(), Math.max(state.start.y, state.end.y));
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }

  function drawPreview() {
    clearPreview();
    if (!state.start || !state.end) return;
    if (state.tool === 'crop') {
      const r = cropRect();
      pctx.save();
      pctx.fillStyle = 'rgba(15, 23, 42, .45)';
      pctx.beginPath();
      pctx.rect(0, 0, cssW(), cssH());
      pctx.rect(r.x, r.y, r.w, r.h);
      pctx.fill('evenodd');
      pctx.setLineDash([6, 4]);
      pctx.strokeStyle = '#ffffff';
      pctx.lineWidth = 1.5;
      pctx.strokeRect(r.x, r.y, r.w, r.h);
      pctx.restore();
      return;
    }
    drawShape(pctx, {
      type: 'shape',
      tool: state.tool,
      color: state.color,
      size: state.size,
      start: state.start,
      end: state.end,
      square: state.shift,
      filled: state.fillShape,
    });
  }

  function addPoint(clientX, clientY, rect, pressure) {
    const last = state.points[state.points.length - 1];
    if (!last) return;
    const x = (clientX - rect.left) / state.zoom;
    const y = (clientY - rect.top) / state.zoom;
    const dx = x - last.x;
    const dy = y - last.y;
    if (dx * dx + dy * dy < 0.36) return;      // 0.6px 미만 움직임은 건너뜀

    const op = state.op;
    if (!op || !state.lastMid) return;

    const mid = { x: (last.x + x) / 2, y: (last.y + y) / 2 };
    ctx.save();
    applyStyle(ctx, op);
    ctx.lineWidth = segWidth(op, last);
    ctx.beginPath();
    ctx.moveTo(state.lastMid.x, state.lastMid.y);
    ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
    ctx.stroke();
    ctx.restore();

    state.lastMid = mid;
    state.points.push({ x, y, p: pressure });
    state.moved = true;
  }

  // ── 두 손가락 탭 = 실행 취소, 세 손가락 탭 = 다시 실행 ──
  /** 첫 손가락으로 막 시작한 획·도형을 흔적 없이 취소한다. */
  function abortCurrent() {
    const hadStroke = !!state.op;
    if (state.tool === 'picker' && state.pickColorBefore) setColor(state.pickColorBefore);
    const id = state.pointerId;
    resetPointer();
    try { board.releasePointerCapture(id); } catch (_) { /* 무시 */ }
    if (hadStroke) replay(); else clearPreview();
  }

  function startGesture(e) {
    const pos = new Map();
    pos.set(state.pointerId, { x: state.downClient.x, y: state.downClient.y });
    pos.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture = { pos, cur: new Map(pos), max: 2, start: state.downAt, moved: false };
    abortCurrent();
  }

  /** 두 손가락의 가운데와 거리 */
  function pinchInfo() {
    const [a, b] = gesture.cur.values();
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  // 두 손가락을 움직이면 탭 대신 확대/축소(벌리기·오므리기)와 화면 이동
  function gestureMove(e) {
    const o = gesture.pos.get(e.pointerId);
    if (!o) return;
    if (Math.hypot(e.clientX - o.x, e.clientY - o.y) > TAP_MOVE) gesture.moved = true;
    const before = pinchInfo();
    gesture.cur.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = pinchInfo();
    if (!gesture.moved || !before || !after) return;
    const r = stage.getBoundingClientRect();
    setZoom(state.zoom * (after.d / before.d), after.x - r.left, after.y - r.top);
    state.panX += after.x - before.x;
    state.panY += after.y - before.y;
    applyView();
  }

  function gestureEnd(e, cancelled) {
    if (!gesture.pos.has(e.pointerId)) return;
    gesture.pos.delete(e.pointerId);
    gesture.cur.delete(e.pointerId);
    if (cancelled) gesture.moved = true;
    if (gesture.pos.size) return;
    const g = gesture;
    gesture = null;
    if (g.moved || performance.now() - g.start > 700) return;
    if (g.max >= 3) {
      if (state.index < state.ops.length - 1) { redo(); toast('다시 실행'); }
    } else if (state.index >= 0) {
      undo();
      toast('실행 취소');
    }
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (state.penDown && e.pointerType === 'touch') return;   // S펜 사용 중 손바닥 무시

    // 끝나지 않은 채 남은 제스처는 정리한다(손가락 이벤트를 놓친 경우 대비).
    if (gesture && performance.now() - gesture.start > 3000) gesture = null;

    if (e.pointerType === 'touch') {
      if (gesture) {                                           // 세 번째 손가락
        e.preventDefault();
        gesture.pos.set(e.pointerId, { x: e.clientX, y: e.clientY });
        gesture.cur.set(e.pointerId, { x: e.clientX, y: e.clientY });
        gesture.max = Math.max(gesture.max, gesture.pos.size);
        return;
      }
      if (state.pointerId !== null && state.pointerType === 'touch'
        && performance.now() - state.downAt < TAP_MS) {
        e.preventDefault();
        startGesture(e);
        return;
      }
    }
    if (state.pointerId !== null) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') e.preventDefault();

    // 글자 입력 중에 캔버스를 누르면 입력을 확정만 한다.
    if (textEdit) { commitText(); return; }

    state.pointerId = e.pointerId;
    state.pointerType = e.pointerType;
    state.downAt = performance.now();
    state.downClient = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'pen') state.penDown = true;
    try { board.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }

    const p = pointFromEvent(e);
    state.start = p;
    state.end = p;
    state.points = [p];
    state.lastMid = { x: p.x, y: p.y };
    state.moved = false;
    state.shift = !!e.shiftKey;

    if (state.tool === 'picker') {
      state.pickColorBefore = state.color;
      pickColorAt(p);
      return;
    }
    if (TAP_TOOLS.has(state.tool)) return;     // 채우기·글자는 손을 뗄 때 실행

    if (SHAPE_TOOLS.has(state.tool)) {
      drawPreview();
      return;
    }

    state.op = {
      type: 'stroke',
      tool: state.tool,
      color: state.color,
      size: state.size,
      pressure: e.pointerType === 'pen',
      points: state.points,
    };

    if (state.tool !== 'highlighter') {
      ctx.save();
      applyStyle(ctx, state.op);
      drawDot(ctx, state.op, p);
      ctx.restore();
    }
  }

  function onPointerMove(e) {
    if (gesture) return;                  // 제스처는 window 에서 처리
    if (state.pointerId !== e.pointerId) return;

    if (state.tool === 'picker') {
      pickColorAt(pointFromEvent(e));
      return;
    }
    if (TAP_TOOLS.has(state.tool)) {
      state.end = pointFromEvent(e);
      return;
    }

    if (SHAPE_TOOLS.has(state.tool)) {
      state.end = pointFromEvent(e);
      state.shift = !!e.shiftKey;
      state.moved = true;
      drawPreview();
      return;
    }

    const rect = board.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : null;
    let events = null;
    if (typeof e.getCoalescedEvents === 'function') {
      try { events = e.getCoalescedEvents(); } catch (_) { events = null; }
    }
    if (!events || !events.length) {
      addPoint(e.clientX, e.clientY, rect, pressure);
      return;
    }
    for (const ev of events) {
      const pr = ev.pointerType === 'pen' ? (ev.pressure > 0 ? ev.pressure : 0.5) : pressure;
      addPoint(ev.clientX, ev.clientY, rect, pr);
    }
  }

  function finishStroke() {
    const pts = state.points;
    const op = state.op;
    if (!op || !pts.length) return;

    if (pts.length === 1) {
      ctx.save();
      applyStyle(ctx, op);
      drawDot(ctx, op, pts[0]);
      ctx.restore();
    } else {
      const last = pts[pts.length - 1];
      if (state.lastMid) {
        ctx.save();
        applyStyle(ctx, op);
        ctx.lineWidth = segWidth(op, last);
        ctx.beginPath();
        ctx.moveTo(state.lastMid.x, state.lastMid.y);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        ctx.restore();
      }
    }
    pushOp(op);
  }

  function finishTapTool() {
    const p = state.start;
    if (!p) return;
    if (state.tool === 'fill') {
      if (floodFill(active, p.x, p.y, state.color)) pushOp({ type: 'fill', x: p.x, y: p.y, color: state.color });
      else toast('이미 같은 색이에요');
    } else if (state.tool === 'picker') {
      toast(`색을 골랐어요 ${state.color}`);
      const back = state.prevTool;
      resetPointer();
      setTool(back);
    } else if (state.tool === 'text') {
      const at = state.start;
      resetPointer();
      openTextEditor(at);
    }
  }

  function onPointerUp(e) {
    if (gesture) return;
    if (state.pointerId !== e.pointerId) return;

    if (TAP_TOOLS.has(state.tool)) {
      finishTapTool();
    } else if (state.tool === 'crop') {
      clearPreview();
      const r = state.start && state.end ? cropRect() : null;
      if (r && r.w >= 8 && r.h >= 8) {
        resetPointer();
        applyXform({ kind: 'crop', x: r.x, y: r.y, w: r.w, h: r.h });
        toast('잘랐어요 — 실행 취소로 되돌릴 수 있어요');
      } else {
        toast('남길 영역을 끌어서 고르세요');
      }
    } else if (SHAPE_TOOLS.has(state.tool)) {
      clearPreview();
      const moved = state.start && state.end
        && (Math.abs(state.end.x - state.start.x) > 0.5 || Math.abs(state.end.y - state.start.y) > 0.5);
      if (moved) {
        const op = {
          type: 'shape',
          tool: state.tool,
          color: state.color,
          size: state.size,
          start: { x: state.start.x, y: state.start.y },
          end: { x: state.end.x, y: state.end.y },
          square: state.shift,
          filled: state.fillShape && FILLABLE_SHAPES.has(state.tool),
        };
        drawShape(ctx, op);
        pushOp(op);
      }
    } else {
      finishStroke();
    }
    resetPointer();
  }

  function onPointerCancel(e) {
    if (gesture) return;
    if (state.pointerId !== e.pointerId) return;
    // 캔버스 밖으로 나가거나 제스처가 끼어들어도 그린 것은 남긴다.
    if (state.tool === 'picker') {
      const back = state.prevTool;
      resetPointer();
      setTool(back);
      return;
    }
    if (SHAPE_TOOLS.has(state.tool)) {
      clearPreview();
    } else if (!TAP_TOOLS.has(state.tool)) {
      finishStroke();
    }
    resetPointer();
  }

  function resetPointer() {
    state.pointerId = null;
    state.pointerType = '';
    state.penDown = false;
    state.op = null;
    state.points = [];
    state.start = null;
    state.end = null;
    state.lastMid = null;
    state.moved = false;
    state.pickColorBefore = null;
  }

  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('pointermove', onPointerMove);
  board.addEventListener('pointerup', onPointerUp);
  board.addEventListener('pointercancel', onPointerCancel);
  board.addEventListener('lostpointercapture', (e) => {
    if (gesture || state.pointerId !== e.pointerId) return;
    onPointerCancel(e);   // 캡처를 잃어도 그린 획은 연산으로 남긴다
  });
  // 제스처 중 손가락이 캔버스 밖에서 떨어져도 놓치지 않도록 window 에서 받는다.
  window.addEventListener('pointermove', (e) => { if (gesture) gestureMove(e); });
  window.addEventListener('pointerup', (e) => { if (gesture) gestureEnd(e, false); });
  window.addEventListener('pointercancel', (e) => { if (gesture) gestureEnd(e, true); });
  board.addEventListener('contextmenu', (e) => e.preventDefault());
  board.addEventListener('dragstart', (e) => e.preventDefault());

  // ── UI 바인딩 ─────────────────────────────────────────
  function setTool(tool) {
    if (!TOOLS[tool]) return;
    if (tool !== 'text') commitText();
    if (tool === 'picker' && state.tool !== 'picker') state.prevTool = state.tool;
    state.tool = tool;
    for (const btn of toolbar.querySelectorAll('button[data-tool]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tool === tool));
    }
    board.style.cursor = TOOLS[tool].cursor;
    shapeFillBtn.hidden = !FILLABLE_SHAPES.has(tool);
    updateSizeDot();
  }

  function setFillShape(on) {
    state.fillShape = !!on;
    shapeFillBtn.setAttribute('aria-pressed', String(state.fillShape));
  }

  function setColor(hex, from) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    state.color = hex.toLowerCase();
    colorInput.value = state.color;
    colorBtn.style.setProperty('--cur', state.color);
    for (const sw of swatchWrap.querySelectorAll('button[data-color]')) {
      sw.classList.toggle('is-active', sw.dataset.color === state.color);
    }
    if (textEdit) {                     // 입력 중인 글자 색도 함께 바꾼다
      textEdit.color = state.color;
      textEditor.style.color = state.color;
    }
    syncColorUI(from);
    updateSizeDot();
  }

  // ── 색상 창: HEX · RGB · HSV ─────────────────────────
  const hsv = { h: 0, s: 0, v: 0 };   // 채도 0일 때도 색상(H)을 잃지 않도록 따로 보관

  function syncColorUI(from) {
    const rgb = hexToRgb(state.color);
    if (from !== 'hsv') Object.assign(hsv, rgbToHsv(rgb.r, rgb.g, rgb.b));
    const vals = { ...rgb, ...hsv };
    for (const input of colorSliders.querySelectorAll('input[data-ch]')) {
      input.value = String(vals[input.dataset.ch]);
      input.nextElementSibling.textContent = String(vals[input.dataset.ch]);
    }
    if (from !== 'hex') hexInput.value = state.color;
    colorPreview.style.background = state.color;
  }

  colorSliders.addEventListener('input', (e) => {
    const ch = e.target.dataset && e.target.dataset.ch;
    if (!ch) return;
    const v = (k) => Number(colorSliders.querySelector(`[data-ch="${k}"]`).value);
    if ('rgb'.includes(ch)) {
      setColor(toHex(v('r'), v('g'), v('b')), 'rgb');
    } else {
      Object.assign(hsv, { h: v('h'), s: v('s'), v: v('v') });
      const c = hsvToRgb(hsv.h, hsv.s, hsv.v);
      setColor(toHex(c.r, c.g, c.b), 'hsv');
    }
  });

  hexInput.addEventListener('input', () => {
    const m = hexInput.value.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (m) setColor(`#${m[1]}`, 'hex');
  });

  function updateSizeDot() {
    const t = TOOLS[state.tool];
    const dia = Math.min(24, Math.max(5, Math.round(t.width(state.size) * 0.8)));
    sizeDot.style.width = dia + 'px';
    sizeDot.style.height = dia + 'px';
    if (state.tool === 'eraser') {
      sizeDot.style.background = 'transparent';
      sizeDot.style.boxShadow = 'inset 0 0 0 1.5px var(--muted)';
    } else {
      sizeDot.style.background = state.color;
      sizeDot.style.boxShadow = '0 0 0 1px rgba(15, 23, 42, .14)';
    }
    sizeDot.style.opacity = state.tool === 'highlighter' ? '0.5' : '1';
  }

  for (const hex of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = hex;
    b.style.setProperty('--sw', hex);
    b.setAttribute('aria-label', `색상 ${hex}`);
    b.title = hex;
    b.addEventListener('click', () => setColor(hex));
    // 글자 입력 중에 색을 바꿔도 입력칸이 닫히지 않게 포커스를 뺏지 않는다.
    b.addEventListener('pointerdown', (e) => { if (textEdit) e.preventDefault(); });
    b.addEventListener('mousedown', (e) => { if (textEdit) e.preventDefault(); });
    swatchWrap.appendChild(b);
  }

  colorInput.addEventListener('input', () => setColor(colorInput.value));

  function setSize(n) {
    state.size = Math.min(80, Math.max(1, Math.round(n)));
    sizeSlider.value = String(state.size);
    sizeValue.textContent = String(state.size);
    if (textEdit) {                     // 입력 중인 글자 크기도 함께 바꾼다
      const fs = textFontSize(state.size);
      const lineH = Math.round(fs * 1.35);
      textEdit.size = state.size;
      textEditor.style.font = textFont(state.size);
      textEditor.style.top = `${textEdit.y - lineH / 2}px`;
      textEditor.style.height = `${lineH}px`;
      textEditor.style.lineHeight = `${lineH}px`;
      sizeTextEditor();
    }
    updateSizeDot();
  }

  sizeSlider.addEventListener('input', () => setSize(Number(sizeSlider.value)));

  shapeFillBtn.addEventListener('click', () => {
    setFillShape(!state.fillShape);
    toast(state.fillShape ? '도형 안쪽을 채워요' : '도형 테두리만 그려요');
  });

  // 글자 입력: Enter로 확정, Esc로 취소, 다른 곳을 누르면 확정
  textEditor.addEventListener('input', sizeTextEditor);
  textEditor.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중 Enter 무시
    if (e.key === 'Enter') { e.preventDefault(); commitText(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
  });
  textEditor.addEventListener('blur', () => commitText());
  // iOS는 터치가 끝나는 순간에만 키보드를 띄울 수 있어 한 번 더 포커스한다.
  board.addEventListener('touchend', () => {
    if (textEdit && document.activeElement !== textEditor) textEditor.focus({ preventScroll: true });
  });

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tool]');
    if (btn) setTool(btn.dataset.tool);
  });

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  clearBtn.addEventListener('click', clearAll);
  saveBtn.addEventListener('click', savePNG);
  shareBtn.hidden = !canShareFiles();
  shareBtn.addEventListener('click', sharePNG);
  importBtn.addEventListener('click', () => { commitText(); imageInput.click(); });
  imageInput.addEventListener('change', () => {
    const file = imageInput.files && imageInput.files[0];
    imageInput.value = '';               // 같은 사진을 다시 고를 수 있도록
    importImage(file);
  });

  // ── 색상 창 · 편집 창 ─────────────────────────────────
  function openDialog(d) {
    commitText();
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }
  for (const d of [colorDialog, editDialog]) {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.closest('[data-close]')) d.close();   // 바깥(배경)을 누르거나 닫기
    });
  }
  colorBtn.addEventListener('click', () => { syncColorUI(); openDialog(colorDialog); });
  editBtn.addEventListener('click', () => { fillResizeFields(); openDialog(editDialog); });

  // 크기 조정: 픽셀이면 현재 캔버스 크기, 비율이면 100%가 기준
  const resizeBase = () => (resizeUnit.value === 'px' ? [cssW(), cssH()] : [100, 100]);
  function fillResizeFields() {
    const [w, h] = resizeBase();
    resizeW.value = String(Math.round(w));
    resizeH.value = String(Math.round(h));
  }
  resizeUnit.addEventListener('change', fillResizeFields);
  resizeW.addEventListener('input', () => {
    if (!resizeLock.checked) return;
    const [w, h] = resizeBase();
    resizeH.value = String(Math.round((Number(resizeW.value) * h) / w));
  });
  resizeH.addEventListener('input', () => {
    if (!resizeLock.checked) return;
    const [w, h] = resizeBase();
    resizeW.value = String(Math.round((Number(resizeH.value) * w) / h));
  });
  function applyResize() {
    const [w, h] = resizeBase();
    const sx = Number(resizeW.value) / w;
    const sy = Number(resizeH.value) / h;
    if (!(sx > 0 && sy > 0 && sx <= 10 && sy <= 10)) { toast('크기를 확인해 주세요 (최대 10배)'); return; }
    if (sx === 1 && sy === 1) return;
    applyXform({ kind: 'scale', sx, sy });
    toast(`크기를 ${Math.round(sx * 100)}% × ${Math.round(sy * 100)}%로 바꿨어요`);
  }

  const EDIT_ACTIONS = {
    'zoom-in': () => setZoom(state.zoom * 1.25),
    'zoom-out': () => setZoom(state.zoom / 1.25),
    'zoom-reset': () => setZoom(1),
    'rot-left': () => applyXform({ kind: 'rotate', dir: -1 }),
    'rot-right': () => applyXform({ kind: 'rotate', dir: 1 }),
    'flip-x': () => applyXform({ kind: 'flipX' }),
    'flip-y': () => applyXform({ kind: 'flipY' }),
    crop: () => { editDialog.close(); setTool('crop'); toast('남길 영역을 끌어서 고르세요'); },
    resize: applyResize,
    'layer-add': addLayer,
  };
  editDialog.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn && EDIT_ACTIONS[btn.dataset.act]) EDIT_ACTIONS[btn.dataset.act]();
  });
  bgInput.addEventListener('change', () => changePaper(bgInput.value));

  // 레이어 목록: 고르기·보이기·투명도·순서·삭제
  layerList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const row = e.target.closest('.layer-row');
    if (!btn || !row) return;
    const L = layerById(Number(row.dataset.id));
    if (!L) return;
    const act = btn.dataset.act;
    if (act === 'select') selectLayer(L);
    else if (act === 'up') moveLayer(L, 1);
    else if (act === 'down') moveLayer(L, -1);
    else if (act === 'del') deleteLayer(L);
  });
  layerList.addEventListener('input', (e) => {
    const row = e.target.closest('.layer-row');
    const L = row && layerById(Number(row.dataset.id));
    if (!L) return;
    if (e.target.dataset.act === 'opacity') {
      L.opacity = Number(e.target.value) / 100;
      L.canvas.style.opacity = String(L.opacity);
    } else if (e.target.dataset.act === 'visible') {
      L.visible = e.target.checked;
      L.canvas.hidden = !L.visible;
    }
  });

  // 화면 테마: 자동(기기 설정) / 밝게 / 어둡게 — 그림이 아니라 보기 설정만 기억한다.
  function applyTheme(v) {
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
    else delete document.documentElement.dataset.theme;
  }
  try { themeSelect.value = localStorage.getItem('paint-app-theme') || 'auto'; } catch (_) { /* 무시 */ }
  applyTheme(themeSelect.value);
  themeSelect.addEventListener('change', () => {
    applyTheme(themeSelect.value);
    try { localStorage.setItem('paint-app-theme', themeSelect.value); } catch (_) { /* 무시 */ }
  });

  // 확대 중 표시 — 누르면 100%로
  zoomBadge.addEventListener('click', () => setZoom(1));
  // PC: Ctrl+휠 확대/축소, 휠 = 확대한 화면 이동
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      setZoom(state.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    } else {
      state.panX -= e.shiftKey ? e.deltaY : e.deltaX;
      state.panY -= e.shiftKey ? 0 : e.deltaY;
      applyView();
    }
  }, { passive: false });

  // 그림을 저장하지 않고 나가려 하면 한 번 묻는다.
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty || state.index < 0) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ── 키보드 단축키 ─────────────────────────────────────
  const KEY_TOOLS = {
    b: 'pen', u: 'brush', p: 'pencil', h: 'highlighter', e: 'eraser', l: 'line',
    r: 'rect', o: 'ellipse', g: 'fill', t: 'text', i: 'picker', c: 'crop',
  };

  window.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const meta = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (meta && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && key === 'y') { e.preventDefault(); redo(); return; }
    if (meta && key === 's') { e.preventDefault(); savePNG(); return; }
    if (meta && key === 'o') { e.preventDefault(); imageInput.click(); return; }
    if (meta && e.key === 'Delete') { e.preventDefault(); clearAll(); return; }

    if (!meta && KEY_TOOLS[key]) { setTool(KEY_TOOLS[key]); return; }
    if (!meta && key === 'f') { shapeFillBtn.click(); return; }
    if (!meta && (key === '+' || key === '=')) { setZoom(state.zoom * 1.25); return; }
    if (!meta && key === '-') { setZoom(state.zoom / 1.25); return; }
    if (!meta && key === '0') { setZoom(1); return; }

    if (!meta && (key === '[' || key === ']')) {
      setSize(state.size + (key === ']' ? 1 : -1));
    }
  });

  // 제스처로 인한 확대/스크롤 방지 (iOS)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  // ── 초기화 ────────────────────────────────────────────
  addLayer();
  setPaper(state.paper);
  setTool('pen');
  setFillShape(false);
  setColor(state.color);
  sizeValue.textContent = String(state.size);
  updateHistoryButtons();
  resizeCanvases();

  // 첫 실행 안내
  // (그림 데이터가 아니라 안내를 봤는지 여부만 기억한다)
  let hintShown = true;
  try { hintShown = !!localStorage.getItem('paint-app-hint-shown'); } catch (_) { /* 무시 */ }
  if (!hintShown) {
    setTimeout(() => toast('손가락으로 그리고, 두 손가락 탭으로 실행 취소해요'), 500);
    try { localStorage.setItem('paint-app-hint-shown', '1'); } catch (_) { /* 무시 */ }
  }

  // ── PWA 서비스 워커 ───────────────────────────────────
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* 오프라인 캐시 없이 동작 */ });
    });
  }
})();

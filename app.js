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
  const board = document.getElementById('board');
  const preview = document.getElementById('preview');
  const stage = document.getElementById('stage');
  const toolbar = document.getElementById('toolbar');
  const swatchWrap = document.getElementById('swatches');
  const colorInput = document.getElementById('colorInput');
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
  const canvasWrap = document.getElementById('canvasWrap');
  const zoomBtn = document.getElementById('zoomBtn');

  const ctx = board.getContext('2d', { willReadFrequently: true });
  const pctx = preview.getContext('2d');

  // ── 상수 ───────────────────────────────────────────────
  const PAPER = '#ffffff';
  const MAX_HISTORY = 80;          // 되돌리기 최대 단계
  const HISTORY_SLACK = 20;        // 이만큼 넘치면 오래된 연산을 바탕 그림으로 한 번에 굳힌다
  const MAX_POINTS = 400000;       // 점 저장량 상한(메모리 보호)
  const FILL_TOLERANCE = 40;       // 페인트통 색 허용 오차
  const MAX_DPR = 3;
  const TAP_MS = 350;              // 두 손가락 탭으로 인정할 두 번째 손가락 도착 시간
  const TAP_MOVE = 18;             // 두 손가락 탭 중 허용 이동 거리(px)
  const HOLD_MS = 500;             // 이만큼 가만히 누르고 있으면 스포이트
  const HOLD_MOVE = 8;             // 길게 누르기로 인정할 최대 이동 거리(px)
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 6;
  const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Malgun Gothic", "Noto Sans KR", system-ui, sans-serif';

  const PALETTE = [
    '#111827', '#64748b', '#ef4444', '#f97316', '#facc15',
    '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  ];

  const TOOLS = {
    pen:         { label: '펜',     width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    highlighter: { label: '형광펜', width: (s) => s * 2.4, alpha: 0.32, composite: 'source-over',    cursor: 'crosshair' },
    eraser:      { label: '지우개', width: (s) => s * 2.6, alpha: 1,    composite: 'destination-out', cursor: 'cell' },
    line:        { label: '직선',   width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    rect:        { label: '사각형', width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    ellipse:     { label: '원',     width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
    fill:        { label: '채우기', width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'copy' },
    text:        { label: '글자',   width: (s) => s,       alpha: 1,    composite: 'source-over',    cursor: 'text' },
    picker:      { label: '스포이트', width: (s) => s,     alpha: 1,    composite: 'source-over',    cursor: 'crosshair' },
  };
  const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse']);
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
    lastClient: null, // 현재 포인터의 마지막 화면 좌표
    holdTimer: 0,     // 길게 눌러 스포이트 타이머
    holdPick: false,  // 길게 눌러 색을 고르는 중
  };

  // 보기 배율·이동 (화면 표시만 바꾼다. 그림 좌표·연산은 그대로)
  const view = { z: 1, x: 0, y: 0 };

  // 히스토리에서 밀려난 오래된 연산을 굳혀 두는 바탕 그림 (기기 픽셀 단위)
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let baseEmpty = true;

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

    if (board.width === bitmapW && board.height === bitmapH) return;

    // 크기가 바뀌기 전 그림을 보관해 두었다가 같은 위치에 되살린다.
    const scale = dpr / state.dpr;
    resizeKeeping(board, ctx, bitmapW, bitmapH, scale);
    if (!baseEmpty) resizeKeeping(base, bctx, bitmapW, bitmapH, scale);
    else { base.width = bitmapW; base.height = bitmapH; }
    preview.width = bitmapW;
    preview.height = bitmapH;
    state.dpr = dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.lastMid = null;
    applyView();
  }

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

  // ── 확대·이동 ──────────────────────────────────────────
  /** 배율·이동을 허용 범위로 맞추고 화면에 반영한다. (캔버스가 늘 stage 를 덮도록) */
  function applyView() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    view.z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z));
    if (view.z < 1.02) view.z = 1;
    view.x = Math.min(0, Math.max(w - w * view.z, view.x));
    view.y = Math.min(0, Math.max(h - h * view.z, view.y));
    canvasWrap.style.transform = view.z === 1 ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    zoomBtn.hidden = view.z === 1;
    zoomBtn.textContent = `${Math.round(view.z * 100)}%`;
  }

  /** 그림 좌표 (ax, ay)가 stage 기준 화면 좌표 (sx, sy)에 오도록 배율 z로 맞춘다. */
  function zoomAround(ax, ay, sx, sy, z) {
    view.z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    view.x = sx - ax * view.z;
    view.y = sy - ay * view.z;
    applyView();
  }

  function resetView() {
    view.z = 1;
    view.x = 0;
    view.y = 0;
    applyView();
  }

  /** 화면 좌표 → 그림(CSS 픽셀) 좌표. rect 는 확대가 반영된 board 의 사각형 */
  function toCanvas(clientX, clientY, rect) {
    return { x: (clientX - rect.left) / view.z, y: (clientY - rect.top) / view.z };
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

  function clearBoard() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, board.width, board.height);
    ctx.restore();
  }

  function clearPreview() {
    pctx.save();
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.restore();
  }

  // ── 페인트통 (Flood Fill, 스캔라인) ────────────────────
  function floodFill(x, y, color) {
    const w = board.width;
    const h = board.height;
    if (!w || !h) return false;
    const sx = Math.floor(x * state.dpr);
    const sy = Math.floor(y * state.dpr);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;

    const img = ctx.getImageData(0, 0, w, h);
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

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(img, 0, 0);
    ctx.restore();
    return true;
  }

  // ── 연산 재생 / 히스토리 ───────────────────────────────
  function paintOp(c, op) {
    if (op.type === 'stroke') drawStroke(c, op);
    else if (op.type === 'shape') drawShape(c, op);
    else if (op.type === 'fill') floodFill(op.x, op.y, op.color);
    else if (op.type === 'text') drawText(c, op);
    else if (op.type === 'image') drawImageOp(c, op);
    else if (op.type === 'clear') clearBoard();
  }

  /** 바탕 그림(히스토리에서 밀려난 연산의 결과)을 깔고 시작한다. */
  function drawBase() {
    clearBoard();
    if (baseEmpty) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.restore();
  }

  function replay() {
    drawBase();
    for (let i = 0; i <= state.index; i++) paintOp(ctx, state.ops[i]);
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
    for (let i = 0; i < drop; i++) paintOp(ctx, state.ops[i]);
    base.width = board.width;
    base.height = board.height;
    bctx.drawImage(board, 0, 0);
    baseEmpty = false;
    for (let i = drop; i <= state.index; i++) paintOp(ctx, state.ops[i]);

    state.ops.splice(0, drop);
    state.index = Math.max(-1, state.index - drop);
  }

  function pushOp(op) {
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
    clearBoard();
    clearPreview();
    pushOp({ type: 'clear' });
    toast('전체 지우기 — 실행 취소로 되돌릴 수 있어요');
  }

  // ── PNG 저장 / 공유 ───────────────────────────────────
  /** 흰 배경 위에 합성한 PNG Blob을 만든다. */
  function renderPNG() {
    return new Promise((resolve) => {
      if (!board.width || !board.height) { resolve(null); return; }
      const out = document.createElement('canvas');
      out.width = board.width;
      out.height = board.height;
      const octx = out.getContext('2d');
      octx.fillStyle = PAPER;                    // 투명 대신 배경색을 깔아 PNG에 유지
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(board, 0, 0);
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
    const cssW = board.width / state.dpr;
    const cssH = board.height / state.dpr;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih || !cssW || !cssH) return;

    // 캔버스 안에 비율을 유지해 가운데 맞춤 (확대는 하지 않음)
    const fit = Math.min(cssW / iw, cssH / ih, 1);
    const w = iw * fit;
    const h = ih * fit;

    // 원본 대신 화면 해상도로 줄인 사본을 보관해 메모리를 아낀다.
    const src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(w * state.dpr));
    src.height = Math.max(1, Math.round(h * state.dpr));
    const sctx = src.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img, 0, 0, src.width, src.height);

    const op = { type: 'image', src, x: (cssW - w) / 2, y: (cssH - h) / 2, w, h };
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
    const maxW = board.width / state.dpr - textEdit.x;
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
  /** 그림의 한 픽셀 색을 흰 종이 위에 놓인 색으로 읽는다. */
  function pickColorAt(p) {
    const sx = Math.floor(p.x * state.dpr);
    const sy = Math.floor(p.y * state.dpr);
    if (sx < 0 || sy < 0 || sx >= board.width || sy >= board.height) return;
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    const a = d[3] / 255;
    const ch = (v) => Math.round(v * a + 255 * (1 - a)).toString(16).padStart(2, '0');
    setColor(`#${ch(d[0])}${ch(d[1])}${ch(d[2])}`);
  }

  // ── 입력 처리 ─────────────────────────────────────────
  function pointFromEvent(e) {
    const { x, y } = toCanvas(e.clientX, e.clientY, board.getBoundingClientRect());
    return {
      x,
      y,
      p: e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : null,
    };
  }

  function drawPreview() {
    clearPreview();
    if (!state.start || !state.end) return;
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
    const { x, y } = toCanvas(clientX, clientY, rect);
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
    if ((state.tool === 'picker' || state.holdPick) && state.pickColorBefore) setColor(state.pickColorBefore);
    const id = state.pointerId;
    resetPointer();
    try { board.releasePointerCapture(id); } catch (_) { /* 무시 */ }
    if (hadStroke) replay(); else clearPreview();
  }

  function startGesture(e) {
    const pos = new Map();
    const first = state.lastClient || state.downClient;
    pos.set(state.pointerId, { x: first.x, y: first.y });
    pos.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 두 손가락 가운데 아래의 그림 좌표를 기억해 두고, 벌리고 옮기는 동안 그 점을 손가락 가운데에 붙여 둔다.
    const r = stage.getBoundingClientRect();
    const mx = (first.x + e.clientX) / 2 - r.left;
    const my = (first.y + e.clientY) / 2 - r.top;
    const pinch = {
      d0: Math.max(1, Math.hypot(first.x - e.clientX, first.y - e.clientY)),
      z0: view.z,
      ax: (mx - view.x) / view.z,
      ay: (my - view.y) / view.z,
    };
    gesture = { pos, cur: new Map(pos), max: 2, start: state.downAt, moved: false, pinch };
    abortCurrent();
  }

  function gestureMove(e) {
    const o = gesture.pos.get(e.pointerId);
    if (!o) return;
    gesture.cur.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.hypot(e.clientX - o.x, e.clientY - o.y) > TAP_MOVE) gesture.moved = true;
    if (!gesture.moved || gesture.max !== 2 || gesture.cur.size !== 2) return;
    // 두 손가락으로 벌리기 = 확대, 함께 옮기기 = 이동
    const [a, b] = [...gesture.cur.values()];
    const r = stage.getBoundingClientRect();
    const k = gesture.pinch;
    zoomAround(k.ax, k.ay, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top,
      k.z0 * Math.hypot(a.x - b.x, a.y - b.y) / k.d0);
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
    clearPreview();   // 굵기 미리보기 원이 남아 있으면 지운다

    state.pointerId = e.pointerId;
    state.pointerType = e.pointerType;
    state.downAt = performance.now();
    state.downClient = { x: e.clientX, y: e.clientY };
    state.lastClient = state.downClient;
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

    // 손가락·펜으로 가만히 누르고 있으면 그 자리 색을 집는다(지우개 제외).
    if (e.pointerType !== 'mouse' && state.tool !== 'eraser') {
      const id = e.pointerId;
      state.holdTimer = setTimeout(() => startHoldPick(id), HOLD_MS);
    }

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

  /** 길게 누르기: 그리던 점·도형을 지우고 그 자리 색을 집는 모드로 바꾼다. */
  function startHoldPick(id) {
    state.holdTimer = 0;
    if (gesture || state.pointerId !== id) return;
    const hadStroke = !!state.op;
    state.op = null;
    state.holdPick = true;
    state.pickColorBefore = state.color;
    if (hadStroke) replay(); else clearPreview();
    pickColorAt(toCanvas(state.lastClient.x, state.lastClient.y, board.getBoundingClientRect()));
    if (navigator.vibrate) navigator.vibrate(12);
    toast('스포이트 — 끌어서 색을 고르세요');
  }

  function onPointerMove(e) {
    if (gesture) return;                  // 제스처는 window 에서 처리
    if (state.pointerId !== e.pointerId) return;
    state.lastClient = { x: e.clientX, y: e.clientY };
    if (state.holdTimer
      && Math.hypot(e.clientX - state.downClient.x, e.clientY - state.downClient.y) > HOLD_MOVE) {
      clearTimeout(state.holdTimer);
      state.holdTimer = 0;
    }

    if (state.tool === 'picker' || state.holdPick) {
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
      if (floodFill(p.x, p.y, state.color)) pushOp({ type: 'fill', x: p.x, y: p.y, color: state.color });
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

    if (state.holdPick) {
      toast(`색을 골랐어요 ${state.color}`);
    } else if (TAP_TOOLS.has(state.tool)) {
      finishTapTool();
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
    if (state.holdPick) { resetPointer(); return; }
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
    clearTimeout(state.holdTimer);
    state.holdTimer = 0;
    state.holdPick = false;
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
  // PC: 휠로 마우스 위치를 중심으로 확대·축소
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    zoomAround((sx - view.x) / view.z, (sy - view.y) / view.z, sx, sy, view.z * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  zoomBtn.addEventListener('click', resetView);

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

  function setColor(hex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    state.color = hex.toLowerCase();
    colorInput.value = state.color;
    for (const sw of swatchWrap.querySelectorAll('button[data-color]')) {
      sw.classList.toggle('is-active', sw.dataset.color === state.color);
    }
    if (textEdit) {                     // 입력 중인 글자 색도 함께 바꾼다
      textEdit.color = state.color;
      textEditor.style.color = state.color;
    }
    updateSizeDot();
  }

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

  /** 굵기를 바꾸는 동안 보이는 화면 가운데에 실제 붓 크기 원을 잠깐 보여 준다. */
  let sizePreviewTimer = 0;
  function showSizePreview() {
    if (state.pointerId !== null || TAP_TOOLS.has(state.tool)) return;
    const t = TOOLS[state.tool];
    const cx = (stage.clientWidth / 2 - view.x) / view.z;
    const cy = (stage.clientHeight / 2 - view.y) / view.z;
    clearPreview();
    pctx.save();
    pctx.beginPath();
    pctx.arc(cx, cy, Math.max(t.width(state.size) / 2, 0.5), 0, Math.PI * 2);
    if (state.tool !== 'eraser') {
      pctx.globalAlpha = t.alpha;
      pctx.fillStyle = state.color;
      pctx.fill();
      pctx.globalAlpha = 1;
    }
    pctx.lineWidth = 1 / view.z;
    pctx.strokeStyle = 'rgba(100, 116, 139, .9)';
    pctx.stroke();
    pctx.restore();
    clearTimeout(sizePreviewTimer);
    sizePreviewTimer = setTimeout(() => { if (state.pointerId === null) clearPreview(); }, 700);
  }

  sizeSlider.addEventListener('input', () => { setSize(Number(sizeSlider.value)); showSizePreview(); });

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

  // 그림을 저장하지 않고 나가려 하면 한 번 묻는다.
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty || state.index < 0) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ── 키보드 단축키 ─────────────────────────────────────
  const KEY_TOOLS = {
    b: 'pen', h: 'highlighter', e: 'eraser', l: 'line',
    r: 'rect', o: 'ellipse', g: 'fill', t: 'text', i: 'picker',
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

    if (!meta && (key === '[' || key === ']')) {
      setSize(state.size + (key === ']' ? 1 : -1));
      showSizePreview();
      return;
    }
    if (!meta && key === '0') resetView();
  });

  // 제스처로 인한 확대/스크롤 방지 (iOS)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  // ── 초기화 ────────────────────────────────────────────
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

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

  const ctx = board.getContext('2d', { willReadFrequently: true });
  const pctx = preview.getContext('2d');

  // ── 상수 ───────────────────────────────────────────────
  const PAPER = '#ffffff';
  const MAX_HISTORY = 80;          // 되돌리기 최대 단계
  const MAX_POINTS = 400000;       // 점 저장량 상한(메모리 보호)
  const FILL_TOLERANCE = 40;       // 페인트통 색 허용 오차
  const MAX_DPR = 3;

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
  };
  const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse']);

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
  };

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
    let saved = null;
    if (board.width > 0 && board.height > 0) {
      saved = document.createElement('canvas');
      saved.width = board.width;
      saved.height = board.height;
      saved.getContext('2d').drawImage(board, 0, 0);
    }
    const savedDpr = state.dpr;

    board.width = bitmapW;
    board.height = bitmapH;
    preview.width = bitmapW;
    preview.height = bitmapH;
    state.dpr = dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (saved) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(saved, 0, 0, saved.width / savedDpr, saved.height / savedDpr);
      ctx.restore();
    }
    state.lastMid = null;
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
    c.stroke();
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
    else if (op.type === 'clear') clearBoard();
  }

  function replay() {
    clearBoard();
    for (let i = 0; i <= state.index; i++) paintOp(ctx, state.ops[i]);
    clearPreview();
  }

  function trimHistory() {
    while (state.ops.length > MAX_HISTORY) {
      state.ops.shift();
      state.index--;
    }
    let total = 0;
    for (const op of state.ops) if (op.points) total += op.points.length;
    while (total > MAX_POINTS && state.ops.length > 1) {
      const removed = state.ops.shift();
      state.index--;
      if (removed.points) total -= removed.points.length;
    }
    if (state.index < -1) state.index = -1;
  }

  function pushOp(op) {
    if (state.index < state.ops.length - 1) state.ops.length = state.index + 1;
    state.ops.push(op);
    state.index = state.ops.length - 1;
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
    pushOp({ type: 'clear' });
    clearBoard();
    clearPreview();
    toast('전체 지우기 — 실행 취소로 되돌릴 수 있어요');
  }

  // ── PNG 저장 ──────────────────────────────────────────
  function savePNG() {
    if (!board.width || !board.height) return;
    const out = document.createElement('canvas');
    out.width = board.width;
    out.height = board.height;
    const octx = out.getContext('2d');
    octx.fillStyle = PAPER;                    // 투명 대신 배경색을 깔아 PNG에 유지
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(board, 0, 0);

    const name = `그림판_${stamp()}.png`;
    const finish = (blob) => {
      if (!blob) { toast('저장에 실패했어요'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('PNG로 저장했어요');
    };

    if (out.toBlob) out.toBlob(finish, 'image/png');
    else finish(null);
  }

  // ── 입력 처리 ─────────────────────────────────────────
  function pointFromEvent(e) {
    const rect = board.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
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
    });
  }

  function addPoint(clientX, clientY, rect, pressure) {
    const last = state.points[state.points.length - 1];
    if (!last) return;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
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

  function onPointerDown(e) {
    if (state.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (state.penDown && e.pointerType === 'touch') return;   // S펜 사용 중 손바닥 무시
    if (e.pointerType === 'touch' || e.pointerType === 'pen') e.preventDefault();

    if (state.tool === 'fill') {
      const p = pointFromEvent(e);
      const op = { type: 'fill', x: p.x, y: p.y, color: state.color };
      if (floodFill(p.x, p.y, state.color)) pushOp(op);
      else toast('이미 같은 색이에요');
      return;
    }

    state.pointerId = e.pointerId;
    state.pointerType = e.pointerType;
    if (e.pointerType === 'pen') state.penDown = true;
    try { board.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }

    const p = pointFromEvent(e);
    state.start = p;
    state.end = p;
    state.points = [p];
    state.lastMid = { x: p.x, y: p.y };
    state.moved = false;
    state.shift = !!e.shiftKey;

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
    if (state.pointerId !== e.pointerId) return;

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

  function onPointerUp(e) {
    if (state.pointerId !== e.pointerId) return;

    if (SHAPE_TOOLS.has(state.tool)) {
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
        };
        pushOp(op);
        drawShape(ctx, op);
      }
    } else {
      finishStroke();
    }
    resetPointer();
  }

  function onPointerCancel(e) {
    if (state.pointerId !== e.pointerId) return;
    // 캔버스 밖으로 나가거나 제스처가 끼어들어도 그린 것은 남긴다.
    if (SHAPE_TOOLS.has(state.tool)) {
      clearPreview();
    } else {
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
  }

  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('pointermove', onPointerMove);
  board.addEventListener('pointerup', onPointerUp);
  board.addEventListener('pointercancel', onPointerCancel);
  board.addEventListener('lostpointercapture', (e) => {
    if (state.pointerId === e.pointerId) resetPointer();
  });
  board.addEventListener('contextmenu', (e) => e.preventDefault());
  board.addEventListener('dragstart', (e) => e.preventDefault());

  // ── UI 바인딩 ─────────────────────────────────────────
  function setTool(tool) {
    if (!TOOLS[tool]) return;
    state.tool = tool;
    for (const btn of toolbar.querySelectorAll('button[data-tool]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tool === tool));
    }
    board.style.cursor = TOOLS[tool].cursor;
    updateSizeDot();
  }

  function setColor(hex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    state.color = hex.toLowerCase();
    colorInput.value = state.color;
    for (const sw of swatchWrap.querySelectorAll('button[data-color]')) {
      sw.classList.toggle('is-active', sw.dataset.color === state.color);
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
    swatchWrap.appendChild(b);
  }

  colorInput.addEventListener('input', () => setColor(colorInput.value));

  sizeSlider.addEventListener('input', () => {
    state.size = Number(sizeSlider.value);
    sizeValue.textContent = String(state.size);
    updateSizeDot();
  });

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tool]');
    if (btn) setTool(btn.dataset.tool);
  });

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  clearBtn.addEventListener('click', clearAll);
  saveBtn.addEventListener('click', savePNG);

  // ── 키보드 단축키 ─────────────────────────────────────
  const KEY_TOOLS = {
    b: 'pen', h: 'highlighter', e: 'eraser', l: 'line',
    r: 'rect', o: 'ellipse', g: 'fill',
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
    if (meta && e.key === 'Delete') { e.preventDefault(); clearAll(); return; }

    if (!meta && KEY_TOOLS[key]) { setTool(KEY_TOOLS[key]); return; }

    if (!meta && (key === '[' || key === ']')) {
      const next = Math.min(80, Math.max(1, state.size + (key === ']' ? 1 : -1)));
      state.size = next;
      sizeSlider.value = String(next);
      sizeValue.textContent = String(next);
      updateSizeDot();
    }
  });

  // 제스처로 인한 확대/스크롤 방지 (iOS)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  // ── 초기화 ────────────────────────────────────────────
  setTool('pen');
  setColor(state.color);
  sizeValue.textContent = String(state.size);
  updateHistoryButtons();
  resizeCanvases();

  // 첫 실행 안내
  if (!localStorage.getItem('paint-app-hint-shown')) {
    setTimeout(() => toast('손가락이나 마우스로 바로 그려 보세요'), 500);
    try { localStorage.setItem('paint-app-hint-shown', '1'); } catch (_) { /* 무시 */ }
  }

  // ── PWA 서비스 워커 ───────────────────────────────────
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* 오프라인 캐시 없이 동작 */ });
    });
  }
})();

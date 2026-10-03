/**
 * NBD INSPECTION EDITOR v2.0
 * Professional Damage Annotation & Assessment Tool
 *
 * Public API:
 *   window.NBDPhotoEditor.open(photoUrl, photoId, leadId, photoData, allPhotos?)
 *   window.NBDPhotoEditor.close()
 */
(function () {
  'use strict';

  /* ==========================================
     CONSTANTS & CONFIG
     ========================================== */
  // R-03: image loads go through the shared NBDSignedUrl helper
  // (js/signed-image-url.js), which calls signImageUrl and caches the
  // short-lived signed URL for 14 minutes. The legacy imageProxy
  // Cloud Function was removed — it double-egressed every byte
  // (Storage → Function → Client) and couldn't survive a 10k-user
  // spike on a 256Mi runtime.

  const TOOLS = {
    SELECT: 'select', PEN: 'pen', LINE: 'line', ARROW: 'arrow',
    RECT: 'rect', CIRCLE: 'circle', TEXT: 'text', CALLOUT: 'callout',
    ERASER: 'eraser', STAMP: 'stamp', MEASURE: 'measure',
  };

  const STAMP_LIBRARY = [
    { id: 'hail', icon: '⬤', label: 'Hail Hit', color: '#ef4444' },
    { id: 'wind_lift', icon: '⤴', label: 'Wind Lift', color: '#f97316' },
    { id: 'wind_crease', icon: '〰', label: 'Wind Crease', color: '#f97316' },
    { id: 'missing_shingle', icon: '▢', label: 'Missing Shingle', color: '#eab308' },
    { id: 'cracked', icon: '⚡', label: 'Cracked', color: '#eab308' },
    { id: 'exposed_nail', icon: '📌', label: 'Exposed Nail', color: '#a855f7' },
    { id: 'lifted_flash', icon: '⇧', label: 'Lifted Flashing', color: '#ec4899' },
    { id: 'granule_loss', icon: '◌', label: 'Granule Loss', color: '#f59e0b' },
    { id: 'bruise', icon: '◉', label: 'Bruise', color: '#dc2626' },
    { id: 'ice_dam', icon: '❄', label: 'Ice Dam', color: '#38bdf8' },
    { id: 'leak', icon: '💧', label: 'Leak/Water', color: '#3b82f6' },
    { id: 'mold', icon: '🟢', label: 'Mold', color: '#22c55e' },
    { id: 'rot', icon: '🟤', label: 'Rot', color: '#92400e' },
    { id: 'sagging', icon: '⌒', label: 'Sagging', color: '#78716c' },
    { id: 'rust', icon: '🔶', label: 'Rust', color: '#ea580c' },
    { id: 'gutter', icon: '⌓', label: 'Gutter Damage', color: '#6366f1' },
    { id: 'fascia', icon: '▬', label: 'Fascia Damage', color: '#8b5cf6' },
    { id: 'skylight', icon: '◇', label: 'Skylight Issue', color: '#06b6d4' },
    { id: 'chimney', icon: '⌂', label: 'Chimney', color: '#b91c1c' },
    { id: 'vent', icon: '◎', label: 'Vent Damage', color: '#64748b' },
  ];

  // damageType canon lives in docs/pro/js/photo-damage-types.js — this
  // list used to be a private Title Case vocabulary ('Hail', 'Flashing
  // Damage', 'Soffit/Fascia', …) that no other surface wrote, so a photo
  // tagged here never grouped with one tagged in Review & Sort or the
  // bulk bar. Falls back to the old literals only if the shared script
  // failed to load, so the panel never renders an empty dropdown.
  // Resolved per call rather than captured at load: this file is one of
  // ~60 deferred scripts on customer.html and a load-order change should
  // degrade the labels, never blank the dropdown.
  const _DMG = () => window.NBD_PHOTO_DAMAGE || null;
  const _dmgNorm = (v) => { const D = _DMG(); return D ? D.normalize(v) : String(v == null ? '' : v).trim(); };
  const DAMAGE_TYPES = () => (_DMG() ? _DMG().options() : [
    ['hail', 'Hail'], ['wind', 'Wind'], ['leak', 'Leak'], ['other', 'Other']
  ]);
  const SEVERITY_LEVELS = { minor: { label: 'Minor', color: '#eab308' }, moderate: { label: 'Moderate', color: '#f97316' }, severe: { label: 'Severe', color: '#ef4444' } };
  const ROOF_LOCATIONS = ['Ridge', 'Hip', 'Valley', 'Field/Slope', 'Edge/Drip', 'Flashing', 'Vent/Pipe Boot', 'Chimney', 'Skylight', 'Gutter', 'Downspout', 'Soffit', 'Fascia', 'Dormer', 'Flat Section'];
  const PHASES = ['Before', 'During', 'After'];
  const COLOR_PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ffffff', '#000000'];

  const GUIDED_PRESETS = {
    general: { label: 'General Inspection', items: ['Overall roof condition', 'Ridge line/caps', 'Valleys', 'Field/slope area', 'Flashing points', 'Vents & pipe boots', 'Gutters & downspouts', 'Soffit & fascia', 'Chimney & skylight'] },
    hail: { label: 'Hail Damage', items: ['Soft metal dents (gutters, vents, AC)', 'Shingle bruising', 'Granule displacement', 'Cracked shingles', 'Collateral damage (fence, deck, siding)', 'Measure hail diameter'] },
    wind: { label: 'Wind Damage', items: ['Missing shingles', 'Lifted/creased shingles', 'Exposed nails/underlayment', 'Ridge cap damage', 'Flashing displacement', 'Debris impact'] },
    water: { label: 'Water/Leak', items: ['Entry point on roof', 'Interior water stains', 'Attic moisture/mold', 'Flashing condition', 'Valley wear', 'Ice dam evidence'] },
  };

  /* ==========================================
     STATE
     ========================================== */
  const S = {
    tool: TOOLS.PEN,
    color: '#ef4444',
    lineWidth: 3,
    opacity: 100,
    fillShapes: false,
    stampId: 'hail',
    calloutNum: 1,
    autoNumber: true,

    // Image / doc
    photoUrl: null, photoId: null, leadId: null, userId: null, photoData: null,
    // Pristine pre-annotation backup bookkeeping (see uploadBlob()'s
    // save-over branch): the live url/storagePath as read at open time,
    // and whether the doc already carries an originalUrl/originalStoragePath
    // backup, so a save-over only writes the backup once, ever.
    origUrl: null, origStoragePath: null, hasOriginalBackup: false,

    // Tags
    damageType: '', severity: '', location: '', phase: 'Before', notes: '', tags: [],

    // View
    zoom: 1, panX: 0, panY: 0,
    isPanning: false, panStartX: 0, panStartY: 0,

    // Selection
    selectedId: null, hoverAnnoId: null,
    dragMode: null, // 'move' | 'resize-tl' | 'resize-br' etc.
    dragStartX: 0, dragStartY: 0,
    dragOrigAnno: null,

    // Canvas
    imgW: 0, imgH: 0,
    originalImage: null,
    brightness: 0, contrast: 0,

    // Multi-photo
    allPhotos: [],
    currentPhotoIndex: 0,
    stripCollapsed: true,

    // Guided
    guidedActive: false,
    guidedPreset: null,
    guidedChecked: [],

    hasUnsaved: false,
  };

  let root = null;          // .nbd-editor-overlay
  let mainCanvas = null;    // bottom canvas (image)
  let annoCanvas = null;    // overlay canvas (annotations)
  let mCtx = null;
  let aCtx = null;
  let annotations = [];
  let undoStack = [];
  let redoStack = [];
  let isDrawing = false;
  let drawStart = { x: 0, y: 0 };
  let drawPoints = [];
  let animFrame = null;

  /* ==========================================
     UTILITY
     ========================================== */
  // roundRect polyfill for older browsers
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
      if (typeof r === 'number') r = [r, r, r, r];
      const [tl, tr, br, bl] = r;
      this.moveTo(x + tl, y);
      this.lineTo(x + w - tr, y); this.arcTo(x + w, y, x + w, y + tr, tr);
      this.lineTo(x + w, y + h - br); this.arcTo(x + w, y + h, x + w - br, y + h, br);
      this.lineTo(x + bl, y + h); this.arcTo(x, y + h, x, y + h - bl, bl);
      this.lineTo(x, y + tl); this.arcTo(x, y, x + tl, y, tl);
      this.closePath();
    };
  }

  const uid = () => 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dist = (x1, y1, x2, y2) => Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

  function toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = 'nbd-toast ' + type;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2400);
  }

  /* ==========================================
     UNDO / REDO
     ========================================== */
  function pushUndo() {
    undoStack.push(JSON.parse(JSON.stringify(annotations)));
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    S.hasUnsaved = true;
    refreshUndoButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.parse(JSON.stringify(annotations)));
    annotations = undoStack.pop();
    S.selectedId = null;
    renderAnnotations();
    refreshUndoButtons();
    refreshAnnList();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.parse(JSON.stringify(annotations)));
    annotations = redoStack.pop();
    S.selectedId = null;
    renderAnnotations();
    refreshUndoButtons();
    refreshAnnList();
  }
  function refreshUndoButtons() {
    const u = root?.querySelector('[data-act="undo"]');
    const r = root?.querySelector('[data-act="redo"]');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }

  /* ==========================================
     IMAGE LOADING (signed URL → blob → CORS fallback)
     The editor needs an un-tainted canvas so hand-drawn damage
     annotations can be exported. We get that by fetching through a
     signed URL, materializing a blob, and loading the blob URL into
     a same-origin <img>. Fallback chain if signing or fetch fails:
     anonymous <img crossOrigin> → bare <img>.
     ========================================== */
  function getStoragePath(url) {
    try { const m = url.match(/\/o\/([^?]+)/); if (m) return decodeURIComponent(m[1]); } catch (e) { }
    return null;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const trySigned = async () => {
        const path = getStoragePath(url);
        if (!path || !window.NBDSignedUrl) { tryDirect(); return; }
        try {
          const signedUrl = await window.NBDSignedUrl.get(path);
          if (!signedUrl) { tryDirect(); return; }
          const resp = await fetch(signedUrl);
          if (!resp.ok) throw new Error(resp.status);
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(blobUrl); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(blobUrl); tryDirect(); };
          img.src = blobUrl;
        } catch (e) { tryDirect(); }
      };
      const tryDirect = () => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => {
          const img2 = new Image();
          img2.onload = () => resolve(img2);
          img2.onerror = () => reject(new Error('Failed to load image'));
          img2.src = url;
        };
        img.src = url;
      };
      trySigned();
    });
  }

  /* ==========================================
     COORDINATE TRANSFORMS
     Uses the canvas wrapper's own bounding rect for accuracy.
     The wrapper is positioned with transform-origin: 0 0 and
     translate + scale, so its getBoundingClientRect gives us
     the exact on-screen position and size.
     ========================================== */
  function screenToCanvas(clientX, clientY) {
    const wrapper = root?.querySelector('.nbd-canvas-wrapper');
    if (!wrapper) return { x: 0, y: 0 };
    const rect = wrapper.getBoundingClientRect();
    // rect already accounts for zoom (scale) since getBoundingClientRect returns rendered size
    return {
      x: (clientX - rect.left) / S.zoom,
      y: (clientY - rect.top) / S.zoom
    };
  }

  function applyTransform() {
    const wrapper = root?.querySelector('.nbd-canvas-wrapper');
    if (!wrapper) return;
    const area = root.querySelector('.nbd-canvas-area');
    if (!area) return;
    const areaRect = area.getBoundingClientRect();
    const scaledW = S.imgW * S.zoom, scaledH = S.imgH * S.zoom;
    // Center the scaled canvas in the area, then apply pan offset
    const tx = (areaRect.width - scaledW) / 2 + S.panX;
    const ty = (areaRect.height - scaledH) / 2 + S.panY;
    wrapper.style.width = S.imgW + 'px';
    wrapper.style.height = S.imgH + 'px';
    wrapper.style.transformOrigin = '0 0';
    wrapper.style.position = 'absolute';
    wrapper.style.left = '0';
    wrapper.style.top = '0';
    wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${S.zoom})`;
  }

  /* ==========================================
     DRAWING PRIMITIVES
     ========================================== */
  function drawAnno(ctx, a, preview) {
    ctx.save();
    ctx.globalAlpha = (a.opacity ?? 100) / 100;
    const c = a.color || S.color;
    const lw = a.lineWidth || S.lineWidth;

    switch (a.type) {
      case 'pen': {
        if (!a.points || a.points.length < 2) break;
        ctx.strokeStyle = c; ctx.lineWidth = lw;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(a.points[0].x, a.points[0].y);
        for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
        break;
      }
      case 'arrow': {
        ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = lw; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
        const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const hl = Math.max(14, lw * 4);
        ctx.beginPath();
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(a.x2 - hl * Math.cos(angle - Math.PI / 6), a.y2 - hl * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(a.x2 - hl * Math.cos(angle + Math.PI / 6), a.y2 - hl * Math.sin(angle + Math.PI / 6));
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'rect': {
        const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
        const w = Math.abs(a.x2 - a.x1), h = Math.abs(a.y2 - a.y1);
        ctx.strokeStyle = c; ctx.lineWidth = lw;
        if (a.fill) { ctx.fillStyle = c; ctx.globalAlpha *= 0.3; ctx.fillRect(x, y, w, h); ctx.globalAlpha = (a.opacity ?? 100) / 100; }
        ctx.strokeRect(x, y, w, h);
        break;
      }
      case 'circle': {
        const cx = (a.x1 + a.x2) / 2, cy = (a.y1 + a.y2) / 2;
        const rx = Math.abs(a.x2 - a.x1) / 2, ry = Math.abs(a.y2 - a.y1) / 2;
        ctx.strokeStyle = c; ctx.lineWidth = lw;
        ctx.beginPath(); ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, 0, Math.PI * 2);
        if (a.fill) { ctx.fillStyle = c; ctx.globalAlpha *= 0.3; ctx.fill(); ctx.globalAlpha = (a.opacity ?? 100) / 100; }
        ctx.stroke();
        break;
      }
      case 'text': {
        const fs = a.fontSize || 18;
        ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = c;
        ctx.textBaseline = 'top';
        // Background pill
        const met = ctx.measureText(a.text || '');
        const pad = 5;
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.beginPath();
        const bx = a.x - pad, by = a.y - pad, bw = met.width + pad * 2, bh = fs + pad * 2;
        ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 4) : ctx.rect(bx, by, bw, bh);
        ctx.fill();
        ctx.fillStyle = c;
        ctx.fillText(a.text || '', a.x, a.y);
        break;
      }
      case 'callout': {
        const size = 18;
        // Leader line
        if (a.leaderX != null && a.leaderY != null) {
          ctx.strokeStyle = c; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.leaderX, a.leaderY); ctx.stroke();
        }
        // Circle
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(a.x, a.y, size, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(a.number ?? ''), a.x, a.y);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        // Label below
        if (a.label) {
          ctx.font = '600 12px Inter, system-ui, sans-serif';
          const tw = ctx.measureText(a.label).width;
          ctx.fillStyle = 'rgba(0,0,0,.65)';
          ctx.beginPath();
          const lx = a.x - tw / 2 - 4, ly = a.y + size + 4;
          ctx.roundRect ? ctx.roundRect(lx, ly, tw + 8, 18, 3) : ctx.rect(lx, ly, tw + 8, 18);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(a.label, a.x, a.y + size + 17);
          ctx.textAlign = 'start';
        }
        break;
      }
      case 'stamp': {
        const stamp = STAMP_LIBRARY.find(s => s.id === a.stampId) || STAMP_LIBRARY[0];
        const sz = 32;
        // Outer ring
        ctx.strokeStyle = stamp.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(a.x, a.y, sz / 2, 0, Math.PI * 2); ctx.stroke();
        // Icon
        ctx.font = `${sz * 0.55}px serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = stamp.color;
        ctx.fillText(stamp.icon, a.x, a.y);
        // Label
        ctx.font = 'bold 10px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(stamp.label).width;
        ctx.fillStyle = 'rgba(0,0,0,.7)';
        const lx = a.x - tw / 2 - 3, ly = a.y + sz / 2 + 3;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(lx, ly, tw + 6, 14, 3) : ctx.rect(lx, ly, tw + 6, 14);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(stamp.label, a.x, a.y + sz / 2 + 13);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        // Number badge
        if (a.number) {
          ctx.fillStyle = stamp.color;
          ctx.beginPath(); ctx.arc(a.x + sz / 2 - 2, a.y - sz / 2 + 2, 9, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(a.number), a.x + sz / 2 - 2, a.y - sz / 2 + 2);
          ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        }
        break;
      }
      case 'measure': {
        ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
        ctx.setLineDash([]);
        // End caps
        [{ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }].forEach(p => {
          ctx.fillStyle = '#ffcc00';
          ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
        });
        const mx = (a.x1 + a.x2) / 2, my = (a.y1 + a.y2) / 2;
        const d = dist(a.x1, a.y1, a.x2, a.y2).toFixed(0) + 'px';
        ctx.font = 'bold 12px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,.7)';
        const tw = ctx.measureText(d).width;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(mx - tw / 2 - 4, my - 18, tw + 8, 18, 3) : ctx.rect(mx - tw / 2 - 4, my - 18, tw + 8, 18);
        ctx.fill();
        ctx.fillStyle = '#ffcc00';
        ctx.textAlign = 'center'; ctx.fillText(d, mx, my - 5);
        ctx.textAlign = 'start';
        break;
      }
      case 'eraser': {
        // Eraser strokes are drawn during render by compositing
        if (!a.points || a.points.length < 2) break;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = a.lineWidth || 20;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(a.points[0].x, a.points[0].y);
        for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
    }

    ctx.restore();

    // Selection outline
    if (!preview && S.selectedId === a.id) {
      drawSelectionOutline(ctx, a);
    }
  }

  function getAnnoBounds(a) {
    switch (a.type) {
      case 'pen': case 'eraser': {
        if (!a.points || !a.points.length) return { x: 0, y: 0, w: 0, h: 0 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        a.points.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
        return { x: minX - 5, y: minY - 5, w: maxX - minX + 10, h: maxY - minY + 10 };
      }
      case 'line': case 'arrow': case 'measure':
        return { x: Math.min(a.x1, a.x2) - 5, y: Math.min(a.y1, a.y2) - 5, w: Math.abs(a.x2 - a.x1) + 10, h: Math.abs(a.y2 - a.y1) + 10 };
      case 'rect': case 'circle':
        return { x: Math.min(a.x1, a.x2) - 5, y: Math.min(a.y1, a.y2) - 5, w: Math.abs(a.x2 - a.x1) + 10, h: Math.abs(a.y2 - a.y1) + 10 };
      case 'text':
        return { x: a.x - 5, y: a.y - 5, w: 200, h: (a.fontSize || 18) + 15 };
      case 'callout':
        return { x: a.x - 22, y: a.y - 22, w: 44, h: 60 };
      case 'stamp':
        return { x: a.x - 22, y: a.y - 22, w: 44, h: 60 };
      default:
        return { x: 0, y: 0, w: 0, h: 0 };
    }
  }

  function drawSelectionOutline(ctx, a) {
    const b = getAnnoBounds(a);
    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    // Corner handles
    const hs = 7;
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(([hx, hy]) => {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2;
      ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    });
    ctx.restore();
  }

  function hitTestAnno(x, y) {
    // Iterate reverse (top-most first)
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      const b = getAnnoBounds(a);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return a;
    }
    return null;
  }

  /* ==========================================
     RENDER
     ========================================== */
  function renderImage() {
    if (!mCtx || !mainCanvas || !S.originalImage) return;
    mCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
    mCtx.drawImage(S.originalImage, 0, 0, S.imgW, S.imgH);
    if (S.brightness !== 0 || S.contrast !== 0) {
      const imgData = mCtx.getImageData(0, 0, S.imgW, S.imgH);
      const d = imgData.data;
      const cf = S.contrast / 100 + 1;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = clamp((d[i] - 128) * cf + 128 + S.brightness, 0, 255);
        d[i + 1] = clamp((d[i + 1] - 128) * cf + 128 + S.brightness, 0, 255);
        d[i + 2] = clamp((d[i + 2] - 128) * cf + 128 + S.brightness, 0, 255);
      }
      mCtx.putImageData(imgData, 0, 0);
    }
  }

  function renderAnnotations() {
    if (!aCtx || !annoCanvas) return;
    aCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
    annotations.forEach(a => drawAnno(aCtx, a));
  }

  function render() {
    renderAnnotations();
    applyTransform();
    renderMinimap();
  }

  /* ==========================================
     MINIMAP
     ========================================== */
  function renderMinimap() {
    const mc = root?.querySelector('.nbd-minimap canvas');
    if (!mc || !mainCanvas) return;
    const mmCtx = mc.getContext('2d');
    mc.width = mc.offsetWidth * (window.devicePixelRatio || 1);
    mc.height = mc.offsetHeight * (window.devicePixelRatio || 1);
    mmCtx.clearRect(0, 0, mc.width, mc.height);
    mmCtx.drawImage(mainCanvas, 0, 0, mc.width, mc.height);
    mmCtx.drawImage(annoCanvas, 0, 0, mc.width, mc.height);

    // Viewport rect
    const area = root.querySelector('.nbd-canvas-area');
    if (!area) return;
    const areaRect = area.getBoundingClientRect();
    const viewW = areaRect.width / S.zoom, viewH = areaRect.height / S.zoom;
    const dispW = S.imgW * S.zoom, dispH = S.imgH * S.zoom;
    const offX = (areaRect.width - dispW) / 2 + S.panX;
    const offY = (areaRect.height - dispH) / 2 + S.panY;
    const vx = -offX / S.zoom, vy = -offY / S.zoom;
    const scaleX = mc.width / S.imgW, scaleY = mc.height / S.imgH;
    mmCtx.strokeStyle = '#A14A22'; mmCtx.lineWidth = 2;
    mmCtx.strokeRect(vx * scaleX, vy * scaleY, viewW * scaleX, viewH * scaleY);
  }

  /* ==========================================
     CANVAS EVENT HANDLERS
     ========================================== */
  function onPointerDown(e) {
    // Only handle left-click or touch on the canvas area
    if (e.button && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const coords = screenToCanvas(e.clientX, e.clientY);

    // Middle mouse = pan
    if (e.button === 1) { startPan(e); return; }
    // Space + click = pan (handled via keydown flag)
    if (S.isPanning) { startPan(e); return; }

    if (S.tool === TOOLS.SELECT) {
      const hit = hitTestAnno(coords.x, coords.y);
      if (hit) {
        S.selectedId = hit.id;
        S.dragMode = 'move';
        S.dragStartX = coords.x; S.dragStartY = coords.y;
        S.dragOrigAnno = JSON.parse(JSON.stringify(hit));
        render();
        refreshAnnList();
      } else {
        S.selectedId = null;
        render();
        refreshAnnList();
      }
      return;
    }

    if (S.tool === TOOLS.TEXT) {
      promptText(coords.x, coords.y);
      return;
    }

    if (S.tool === TOOLS.CALLOUT) {
      const label = prompt('Callout label (optional):') || '';
      const num = S.autoNumber ? S.calloutNum++ : '';
      pushUndo();
      annotations.push({ id: uid(), type: 'callout', x: coords.x, y: coords.y, number: num, label, color: S.color, opacity: S.opacity });
      render();
      refreshAnnList();
      return;
    }

    if (S.tool === TOOLS.STAMP) {
      pushUndo();
      const num = S.autoNumber ? S.calloutNum++ : null;
      annotations.push({ id: uid(), type: 'stamp', x: coords.x, y: coords.y, stampId: S.stampId, number: num, opacity: S.opacity });
      render();
      refreshAnnList();
      return;
    }

    isDrawing = true;
    drawStart = { x: coords.x, y: coords.y };
    drawPoints = [{ x: coords.x, y: coords.y }];

    if (S.tool === TOOLS.PEN || S.tool === TOOLS.ERASER) {
      pushUndo();
    }
  }

  function onPointerMove(e) {
    if (!root) return;
    if (S.isPanning && S.dragMode === 'pan') {
      S.panX += e.clientX - S.panStartX;
      S.panY += e.clientY - S.panStartY;
      S.panStartX = e.clientX;
      S.panStartY = e.clientY;
      applyTransform();
      renderMinimap();
      return;
    }

    const coords = screenToCanvas(e.clientX, e.clientY);

    // Selection drag
    if (S.tool === TOOLS.SELECT && S.dragMode === 'move' && S.selectedId) {
      const a = annotations.find(a => a.id === S.selectedId);
      if (!a || !S.dragOrigAnno) return;
      const dx = coords.x - S.dragStartX, dy = coords.y - S.dragStartY;
      moveAnno(a, S.dragOrigAnno, dx, dy);
      render();
      return;
    }

    if (!isDrawing) return;

    if (S.tool === TOOLS.PEN || S.tool === TOOLS.ERASER) {
      drawPoints.push({ x: coords.x, y: coords.y });
      renderAnnotations();
      // Draw live stroke
      const preview = {
        type: S.tool === TOOLS.ERASER ? 'eraser' : 'pen',
        points: drawPoints,
        color: S.color,
        lineWidth: S.tool === TOOLS.ERASER ? Math.max(S.lineWidth * 3, 15) : S.lineWidth,
        opacity: S.opacity
      };
      drawAnno(aCtx, preview, true);
    } else {
      renderAnnotations();
      const preview = buildShapePreview(coords);
      if (preview) drawAnno(aCtx, preview, true);
    }
  }

  function onPointerUp(e) {
    if (!root) return;
    if (S.dragMode === 'pan') { S.dragMode = null; return; }

    // Selection drag end
    if (S.tool === TOOLS.SELECT && S.dragMode === 'move') {
      if (S.dragOrigAnno) pushUndo();
      S.dragMode = null;
      S.dragOrigAnno = null;
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;
    const coords = screenToCanvas(e.clientX, e.clientY);

    if (S.tool === TOOLS.PEN) {
      annotations.push({ id: uid(), type: 'pen', points: [...drawPoints], color: S.color, lineWidth: S.lineWidth, opacity: S.opacity });
      // pushUndo already called on down
    } else if (S.tool === TOOLS.ERASER) {
      annotations.push({ id: uid(), type: 'eraser', points: [...drawPoints], lineWidth: Math.max(S.lineWidth * 3, 15) });
    } else {
      pushUndo();
      const shape = buildShapePreview(coords);
      if (shape) { shape.id = uid(); annotations.push(shape); }
    }

    drawPoints = [];
    render();
    refreshAnnList();
  }

  function startPan(e) {
    S.dragMode = 'pan';
    S.panStartX = e.clientX;
    S.panStartY = e.clientY;
  }

  function onWheel(e) {
    e.preventDefault();
    const area = root?.querySelector('.nbd-canvas-area');
    if (!area) return;
    const areaRect = area.getBoundingClientRect();

    // Mouse position relative to area center
    const mx = e.clientX - areaRect.left - areaRect.width / 2;
    const my = e.clientY - areaRect.top - areaRect.height / 2;

    const oldZoom = S.zoom;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    S.zoom = clamp(S.zoom * factor, 0.15, 8);
    const ratio = S.zoom / oldZoom;

    // Adjust pan so zoom centers on cursor position
    S.panX = mx - ratio * (mx - S.panX);
    S.panY = my - ratio * (my - S.panY);

    applyTransform();
    renderMinimap();
    updateZoomDisplay();
  }

  function buildShapePreview(coords) {
    const t = S.tool;
    const base = { color: S.color, lineWidth: S.lineWidth, opacity: S.opacity };
    if (t === TOOLS.LINE) return { ...base, type: 'line', x1: drawStart.x, y1: drawStart.y, x2: coords.x, y2: coords.y };
    if (t === TOOLS.ARROW) return { ...base, type: 'arrow', x1: drawStart.x, y1: drawStart.y, x2: coords.x, y2: coords.y };
    if (t === TOOLS.RECT) return { ...base, type: 'rect', x1: drawStart.x, y1: drawStart.y, x2: coords.x, y2: coords.y, fill: S.fillShapes };
    if (t === TOOLS.CIRCLE) return { ...base, type: 'circle', x1: drawStart.x, y1: drawStart.y, x2: coords.x, y2: coords.y, fill: S.fillShapes };
    if (t === TOOLS.MEASURE) return { ...base, type: 'measure', x1: drawStart.x, y1: drawStart.y, x2: coords.x, y2: coords.y };
    return null;
  }

  function moveAnno(a, orig, dx, dy) {
    if (a.x != null) { a.x = orig.x + dx; a.y = orig.y + dy; }
    if (a.x1 != null) { a.x1 = orig.x1 + dx; a.y1 = orig.y1 + dy; a.x2 = orig.x2 + dx; a.y2 = orig.y2 + dy; }
    if (a.points) { a.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy })); }
    if (a.leaderX != null) { a.leaderX = orig.leaderX + dx; a.leaderY = orig.leaderY + dy; }
  }

  function promptText(x, y) {
    const text = prompt('Enter text:');
    if (!text) return;
    pushUndo();
    annotations.push({ id: uid(), type: 'text', x, y, text, color: S.color, fontSize: 18, opacity: S.opacity });
    render();
    refreshAnnList();
  }

  /* ==========================================
     TOUCH SUPPORT
     ========================================== */
  let lastTouchDist = 0;

  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      lastTouchDist = dist(e.touches[0].clientX, e.touches[0].clientY, e.touches[1].clientX, e.touches[1].clientY);
      return;
    }
    const fake = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, button: 0, preventDefault: () => {} };
    onPointerDown(fake);
  }
  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      const d = dist(e.touches[0].clientX, e.touches[0].clientY, e.touches[1].clientX, e.touches[1].clientY);
      const scale = d / lastTouchDist;
      const oldZoom = S.zoom;
      S.zoom = clamp(S.zoom * scale, 0.15, 8);
      const ratio = S.zoom / oldZoom;

      // Center zoom on midpoint between two fingers
      const canvasArea = root?.querySelector('.nbd-canvas-area');
      if (canvasArea) {
        const rect = canvasArea.getBoundingClientRect();
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const cx = rect.width / 2, cy = rect.height / 2;
        S.panX = midX - ratio * (midX - S.panX);
        S.panY = midY - ratio * (midY - S.panY);
      }

      lastTouchDist = d;
      applyTransform();
      renderMinimap();
      updateZoomDisplay();
      return;
    }
    const fake = { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
    onPointerMove(fake);
  }
  function onTouchEnd(e) {
    e.preventDefault();
    const fake = { clientX: 0, clientY: 0 };
    if (e.changedTouches && e.changedTouches.length) {
      fake.clientX = e.changedTouches[0].clientX;
      fake.clientY = e.changedTouches[0].clientY;
    }
    onPointerUp(fake);
  }

  /* ==========================================
     KEYBOARD SHORTCUTS
     ========================================== */
  let spaceHeld = false;

  function onKeyDown(e) {
    if (!root) return;
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if (e.key === ' ') { e.preventDefault(); spaceHeld = true; S.isPanning = true; return; }
    if (e.key === 'Escape') { if (S.guidedActive) { S.guidedActive = false; refreshGuided(); } else { closeWithPrompt(); } return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); return; }
      if (e.key === 's') { e.preventDefault(); flattenAndSaveOver(); return; }
    }

    const map = {
      v: TOOLS.SELECT, p: TOOLS.PEN, l: TOOLS.LINE, a: TOOLS.ARROW,
      r: TOOLS.RECT, c: TOOLS.CIRCLE, t: TOOLS.TEXT, e: TOOLS.ERASER,
      s: TOOLS.STAMP, q: TOOLS.CALLOUT, m: TOOLS.MEASURE,
    };
    if (map[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setTool(map[e.key.toLowerCase()]);
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') { spaceHeld = false; S.isPanning = false; }
  }

  /* ==========================================
     TOOL MANAGEMENT
     ========================================== */
  function setTool(tool) {
    S.tool = tool;
    S.selectedId = null;
    updateToolButtons();
    updateCursor();
    render();
  }

  function updateToolButtons() {
    if (!root) return;
    root.querySelectorAll('.nbd-tool-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === S.tool);
    });
  }

  function updateCursor() {
    const wrapper = root?.querySelector('.nbd-canvas-wrapper');
    if (!wrapper) return;
    const map = {
      [TOOLS.SELECT]: 'default', [TOOLS.PEN]: 'crosshair', [TOOLS.LINE]: 'crosshair',
      [TOOLS.ARROW]: 'crosshair', [TOOLS.RECT]: 'crosshair', [TOOLS.CIRCLE]: 'crosshair',
      [TOOLS.TEXT]: 'text', [TOOLS.ERASER]: 'cell', [TOOLS.STAMP]: 'copy',
      [TOOLS.CALLOUT]: 'crosshair', [TOOLS.MEASURE]: 'crosshair',
    };
    wrapper.style.cursor = S.isPanning ? 'grab' : (map[S.tool] || 'crosshair');
  }

  function deleteSelected() {
    if (!S.selectedId) return;
    pushUndo();
    annotations = annotations.filter(a => a.id !== S.selectedId);
    S.selectedId = null;
    render();
    refreshAnnList();
  }

  function updateZoomDisplay() {
    const el = root?.querySelector('.nbd-zoom-val');
    if (el) el.textContent = Math.round(S.zoom * 100) + '%';
  }

  /* ==========================================
     SAVE WORKFLOWS
     ========================================== */
  async function saveTagsOnly() {
    if (!S.photoId) { toast('No photo ID', 'error'); return; }
    try {
      // brightness/contrast are persisted non-destructively here (the
      // original image is untouched; openEditor re-applies them on load).
      // annotations: persist the vector shape data on a plain tags-only
      // save too — previously only a flatten (uploadBlob) ever wrote
      // anything, so "Save Tags" silently discarded every drawn shape.
      const meta = { damageType: _dmgNorm(S.damageType), severity: S.severity, location: S.location, phase: S.phase, notes: S.notes, tags: S.tags, brightness: S.brightness, contrast: S.contrast, annotations: JSON.parse(JSON.stringify(annotations)) };
      await window.updateDoc(window.doc(window.db, 'photos', S.photoId), meta);
      toast('Tags saved!', 'success');
      S.hasUnsaved = false;
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  }

  function flattenCanvas() {
    const fc = document.createElement('canvas');
    fc.width = S.imgW; fc.height = S.imgH;
    const fCtx = fc.getContext('2d');
    fCtx.drawImage(mainCanvas, 0, 0);
    fCtx.drawImage(annoCanvas, 0, 0);
    return fc;
  }

  async function flattenAndSaveAs() {
    try {
      const fc = flattenCanvas();
      fc.toBlob(async blob => {
        if (!blob) { toast('Failed to create image', 'error'); return; }
        await uploadBlob(blob, false);
      }, 'image/jpeg', 0.95);
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  }

  async function flattenAndSaveOver() {
    if (!S.photoId) { toast('No photo ID', 'error'); return; }
    try {
      const fc = flattenCanvas();
      fc.toBlob(async blob => {
        if (!blob) { toast('Failed to create image', 'error'); return; }
        await uploadBlob(blob, true);
      }, 'image/jpeg', 0.95);
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  }

  function downloadLocal() {
    try {
      const fc = flattenCanvas();
      fc.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inspection_${S.photoId || 'photo'}_${Date.now()}.jpg`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Downloaded!', 'success');
      }, 'image/jpeg', 0.95);
    } catch (err) { toast('Download failed: ' + err.message, 'error'); }
  }

  async function uploadBlob(blob, overwrite) {
    try {
      // Storage rules (2026-04-11 hardening) require `photos/{uid}/...`.
      // The local `uid()` helper in this file is the annotation ID
      // generator — it is NOT the Firebase auth UID. Use S.userId
      // (set when the editor is opened) for the storage path.
      const authUid = S.userId || (window.auth && window.auth.currentUser && window.auth.currentUser.uid);
      if (!authUid) throw new Error('Not signed in');
      const leadSegment = S.leadId ? (S.leadId + '/') : '';
      const fileName = overwrite ? `photo_${S.photoId}.jpg` : `photo_${uid()}.jpg`;
      // storagePath mirrors the upload key so the image pipeline
      // (functions/image-pipeline.js) can find this doc by equality
      // and stamp fresh `urls` variants for the flattened image.
      const storagePath = `photos/${authUid}/${leadSegment}${fileName}`;
      const storageRef = window.ref(window.storage, storagePath);
      await window.uploadBytes(storageRef, blob);
      const url = await window.getDownloadURL(storageRef);
      // Flatten bakes the current brightness/contrast into the pixels, so
      // the saved copy's stored adjustments reset to 0 — otherwise reopening
      // would double-apply them on top of the already-adjusted image.
      // annotations: also persist the vector shapes here (not just the
      // baked-in pixels) so a flattened photo can still be reopened with
      // its shapes editable, instead of only the flattened image.
      const meta = { damageType: _dmgNorm(S.damageType), severity: S.severity, location: S.location, phase: S.phase, notes: S.notes, tags: S.tags, isAnnotated: true, annotatedAt: window.serverTimestamp(), brightness: 0, contrast: 0, annotations: JSON.parse(JSON.stringify(annotations)) };
      if (overwrite && S.photoId) {
        // storagePath moves with the save-over: url and storagePath must
        // point at the SAME object (deletion + pipeline stamping both key
        // off storagePath). The doc's old `urls` variants go stale for the
        // seconds until the pipeline re-stamps them from the new object —
        // acceptable; renderers fall back sanely either way.
        const patch = { url, storagePath, ...meta };
        // Back up the pristine pre-annotation camera photo exactly ONCE:
        // the first save-over on this doc stashes the live url/storagePath
        // (captured at open time, before this overwrite) into
        // originalUrl/originalStoragePath so it isn't silently orphaned in
        // Storage once `url`/`storagePath` get overwritten with the
        // flattened copy. S.hasOriginalBackup (read from the doc at open
        // time) guards against a later save-over clobbering the real
        // original with an already-annotated intermediate copy.
        if (!S.hasOriginalBackup && S.origUrl && S.origStoragePath) {
          patch.originalUrl = S.origUrl;
          patch.originalStoragePath = S.origStoragePath;
        }
        await window.updateDoc(window.doc(window.db, 'photos', S.photoId), patch);
        if (patch.originalUrl) S.hasOriginalBackup = true;
      } else {
        // Use the resolved authUid (guaranteed non-empty above), not the raw
        // S.userId — S.userId is '' when the editor was opened while
        // auth.currentUser was momentarily null, which made the Storage upload
        // succeed (it falls back to currentUser) while the Firestore create was
        // denied (userId:'' != request.auth.uid), silently losing the save.
        // Stamp the canonical `createdAt` (serverTimestamp) so this annotated
        // copy appears in the Recent feed + per-lead gallery, which both
        // orderBy('createdAt'). Without it the new doc had no ordering field
        // and was silently excluded. (annotatedAt stays in `meta` as the
        // edit timestamp — distinct from doc-create time.)
        // companyId: tenant key (claims.companyId || uid) so the annotated
        // copy is visible to company-scoped team reads like the original.
        await window.addDoc(window.collection(window.db, 'photos'), { url, storagePath, originalPhotoId: S.photoId, leadId: S.leadId, userId: authUid, companyId: (window._userClaims && window._userClaims.companyId) || authUid, createdAt: window.serverTimestamp(), ...meta });
      }
      S.hasUnsaved = false;
      toast('Saved!', 'success');
    } catch (err) { toast('Upload failed: ' + err.message, 'error'); }
  }

  /* ==========================================
     BUILD UI
     ========================================== */
  function buildEditor() {
    root = document.createElement('div');
    root.className = 'nbd-editor-overlay';
    root.innerHTML = `
      <!-- TOP BAR -->
      <div class="nbd-topbar">
        <div class="nbd-topbar-left">
          <button class="nbd-btn" data-act="back" title="Back (Esc)">
            <svg class="nbd-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
            Back
          </button>
        </div>
        <div class="nbd-topbar-center">
          <span class="nbd-topbar-title">Inspection Editor</span>
        </div>
        <div class="nbd-topbar-right">
          <button class="nbd-icon-btn" data-act="undo" title="Undo (Ctrl+Z)" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 10h13a4 4 0 010 8H9"/><path d="M7 6L3 10l4 4"/></svg>
          </button>
          <button class="nbd-icon-btn" data-act="redo" title="Redo (Ctrl+Y)" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10H8a4 4 0 000 8h7"/><path d="M17 6l4 4-4 4"/></svg>
          </button>
          <div class="pex-wd1px-hei24px-bgnbdborde"></div>
          <button class="nbd-btn" data-act="download" title="Download Local">
            <svg class="nbd-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </button>
          <button class="nbd-btn" data-act="save-tags">Save Tags</button>
          <button class="nbd-btn" data-act="save-copy">Save Copy</button>
          <button class="nbd-btn primary" data-act="save-over">
            <svg class="nbd-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save
          </button>
          <div class="pex-wd1px-hei24px-bgnbdborde"></div>
          <button class="nbd-icon-btn" data-act="guided" title="Guided Inspection">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
          </button>
          <button class="nbd-icon-btn" data-act="toggle-panel" title="Toggle Panel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
          </button>
        </div>
      </div>

      <!-- BODY -->
      <div class="nbd-editor-body">
        <!-- LEFT TOOLBAR -->
        <div class="nbd-toolbar" id="nbd-toolbar">
          ${buildToolbarHTML()}
        </div>

        <!-- CANVAS AREA -->
        <div class="nbd-canvas-area">
          <div class="nbd-canvas-wrapper"></div>
          <div class="nbd-minimap"><canvas></canvas></div>
        </div>

        <!-- RIGHT PANEL -->
        <div class="nbd-panel" id="nbd-panel">
          <div class="nbd-panel-scroll">
            ${buildPanelHTML()}
          </div>
        </div>
      </div>

      <!-- PROPERTY BAR -->
      <div class="nbd-propbar">
        ${buildPropbarHTML()}
      </div>

      <!-- PHOTO STRIP -->
      <div class="nbd-photostrip ${S.allPhotos.length < 2 ? 'collapsed' : ''}" id="nbd-photostrip">
        ${buildPhotoStripHTML()}
      </div>
    `;

    document.body.appendChild(root);
  }

  function buildToolbarHTML() {
    const groups = [
      { label: 'Select', tools: [{ id: TOOLS.SELECT, icon: svgPointer, label: 'Select', key: 'V' }] },
      { label: 'Draw', tools: [
        { id: TOOLS.PEN, icon: svgPen, label: 'Pen', key: 'P' },
        { id: TOOLS.ERASER, icon: svgEraser, label: 'Eraser', key: 'E' },
      ]},
      { label: 'Shape', tools: [
        { id: TOOLS.LINE, icon: svgLine, label: 'Line', key: 'L' },
        { id: TOOLS.ARROW, icon: svgArrow, label: 'Arrow', key: 'A' },
        { id: TOOLS.RECT, icon: svgRect, label: 'Rect', key: 'R' },
        { id: TOOLS.CIRCLE, icon: svgCircle, label: 'Circle', key: 'C' },
      ]},
      { label: 'Annotate', tools: [
        { id: TOOLS.TEXT, icon: svgText, label: 'Text', key: 'T' },
        { id: TOOLS.CALLOUT, icon: svgCallout, label: 'Callout', key: 'Q' },
        { id: TOOLS.MEASURE, icon: svgMeasure, label: 'Measure', key: 'M' },
      ]},
      { label: 'Stamps', tools: [
        { id: TOOLS.STAMP, icon: svgStamp, label: 'Stamp', key: 'S', hasSubmenu: true },
      ]},
    ];

    let html = '';
    groups.forEach((g, gi) => {
      if (gi > 0) html += '<div class="nbd-tool-sep"></div>';
      g.tools.forEach(t => {
        html += `<button class="nbd-tool-btn ${S.tool === t.id ? 'active' : ''}" data-tool="${t.id}" title="${t.label} (${t.key})">
          ${t.icon}
          <span class="pex-fs9px">${t.label}</span>
          <span class="nbd-tool-key">${t.key}</span>
        </button>`;
      });
    });

    // Stamp flyout
    html += `<div class="nbd-stamp-flyout" id="nbd-stamp-flyout">
      ${STAMP_LIBRARY.map(s => `<div class="nbd-stamp-item ${S.stampId === s.id ? 'active' : ''}" data-stamp="${s.id}" title="${s.label}">
        <span class="pex-fs18px">${s.icon}</span>
        <span>${s.label.split(' ')[0]}</span>
      </div>`).join('')}
    </div>`;

    return html;
  }

  function buildPanelHTML() {
    return `
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Damage Type</div>
        <select class="nbd-select" data-field="damageType">
          <option value="">Select type...</option>
          ${DAMAGE_TYPES().map(([id, label]) => `<option value="${id}" ${_dmgNorm(S.damageType) === id ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Severity</div>
        <div class="nbd-severity-group">
          ${Object.entries(SEVERITY_LEVELS).map(([k, v]) => `<div class="nbd-severity-pill ${S.severity === k ? 'active' : ''}" data-sev="${k}">${v.label}</div>`).join('')}
        </div>
      </div>
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Location</div>
        <select class="nbd-select" data-field="location">
          <option value="">Select location...</option>
          ${ROOF_LOCATIONS.map(l => `<option value="${l}" ${S.location === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Phase</div>
        <div class="nbd-phase-tabs">
          ${PHASES.map(p => `<div class="nbd-phase-tab ${S.phase === p ? 'active' : ''}" data-phase="${p}">${p}</div>`).join('')}
        </div>
      </div>
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Tags</div>
        <div class="pex-dflex-gap6px-mb6px">
          <input class="nbd-input pex-fx1" id="nbd-tag-input" placeholder="Add tag + Enter">
        </div>
        <div id="nbd-tags-wrap" class="pex-dflex-flewrap-gap4px">${S.tags.map(t => `<span class="nbd-tag">${esc(t)}<button class="nbd-tag-remove" data-tag="${esc(t)}">&times;</button></span>`).join('')}</div>
      </div>
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Notes</div>
        <textarea class="nbd-textarea" id="nbd-notes" placeholder="Inspection notes...">${esc(S.notes)}</textarea>
      </div>
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Annotations (${annotations.length})</div>
        <div id="nbd-ann-list">${buildAnnListHTML()}</div>
      </div>
      <div class="nbd-panel-section">
        <div class="nbd-panel-label">Image Adjust</div>
        <div class="pex-dflex-flecolumn-gap8px">
          <div class="pex-dflex-aicenter-gap6px">
            <span class="pex-fs11px-cnbdtextd-minw58px">Brightness</span>
            <input type="range" class="nbd-slider pex-fx1" min="-100" max="100" value="${S.brightness}" data-adjust="brightness">
            <span class="nbd-slider-val" data-adjust-val="brightness">${S.brightness}</span>
          </div>
          <div class="pex-dflex-aicenter-gap6px">
            <span class="pex-fs11px-cnbdtextd-minw58px">Contrast</span>
            <input type="range" class="nbd-slider pex-fx1" min="-100" max="100" value="${S.contrast}" data-adjust="contrast">
            <span class="nbd-slider-val" data-adjust-val="contrast">${S.contrast}</span>
          </div>
        </div>
      </div>
    `;
  }

  function buildAnnListHTML() {
    if (!annotations.length) return '<div class="pex-p8px-tacenter-cnbdtextm">No annotations yet</div>';
    return annotations.map((a, i) => {
      const icon = getAnnoIcon(a);
      const label = a.type === 'stamp' ? (STAMP_LIBRARY.find(s => s.id === a.stampId)?.label || a.type) : a.type;
      return `<div class="nbd-ann-item ${S.selectedId === a.id ? 'selected' : ''}" data-ann-id="${a.id}">
        <span class="nbd-ann-item-icon">${icon}</span>
        <span class="nbd-ann-item-label">${label}${a.number ? ' #' + a.number : ''}${a.text ? ': ' + esc(a.text.substring(0, 20)) : ''}</span>
        <span class="nbd-ann-item-num">${i + 1}</span>
        <button class="nbd-ann-item-delete" data-del-id="${a.id}" title="Delete">&times;</button>
      </div>`;
    }).join('');
  }

  function getAnnoIcon(a) {
    const map = { pen: '✏️', line: '—', arrow: '→', rect: '▭', circle: '⬭', text: 'A', callout: '①', stamp: '⊛', measure: '📏', eraser: '⌫' };
    return map[a.type] || '·';
  }

  function buildPropbarHTML() {
    return `
      <div class="nbd-prop-group">
        <span class="nbd-prop-label">Color</span>
        ${COLOR_PALETTE.map(c => `<div class="nbd-swatch ${S.color === c ? 'active' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}
        <div class="nbd-color-picker-wrap">
          <div class="nbd-color-picker-btn" id="nbd-custom-color" style="background:${S.color}"></div>
          <input type="color" class="nbd-color-native" id="nbd-color-input" value="${S.color}">
        </div>
      </div>
      <div class="nbd-prop-sep"></div>
      <div class="nbd-prop-group">
        <span class="nbd-prop-label">Width</span>
        <input type="range" class="nbd-slider" min="1" max="12" value="${S.lineWidth}" data-prop="lineWidth">
        <span class="nbd-slider-val" data-prop-val="lineWidth">${S.lineWidth}px</span>
      </div>
      <div class="nbd-prop-sep"></div>
      <div class="nbd-prop-group">
        <span class="nbd-prop-label">Opacity</span>
        <input type="range" class="nbd-slider" min="10" max="100" value="${S.opacity}" data-prop="opacity">
        <span class="nbd-slider-val" data-prop-val="opacity">${S.opacity}%</span>
      </div>
      <div class="nbd-prop-sep"></div>
      <div class="nbd-prop-group">
        <label class="pex-dflex-aicenter-gap4px">
          <input type="checkbox" id="nbd-fill" ${S.fillShapes ? 'checked' : ''}> Fill
        </label>
      </div>
      <div class="nbd-prop-sep"></div>
      <div class="nbd-prop-group">
        <label class="pex-dflex-aicenter-gap4px">
          <input type="checkbox" id="nbd-autonum" ${S.autoNumber ? 'checked' : ''}> Auto #
        </label>
      </div>
      <div class="nbd-prop-sep"></div>
      <div class="nbd-prop-group">
        <span class="nbd-prop-label">Zoom</span>
        <button class="nbd-icon-btn pex-wd26px-hei26px" data-act="zoom-out" title="Zoom Out">−</button>
        <span class="nbd-zoom-val pex-fs11px-minw38px-tacenter">${Math.round(S.zoom * 100)}%</span>
        <button class="nbd-icon-btn pex-wd26px-hei26px" data-act="zoom-in" title="Zoom In">+</button>
        <button class="nbd-icon-btn pex-wd26px-hei26px" data-act="zoom-fit" title="Fit">⊡</button>
      </div>
    `;
  }

  function buildPhotoStripHTML() {
    if (!S.allPhotos || S.allPhotos.length < 2) return '';
    return S.allPhotos.map((p, i) => {
      const url = typeof p === 'string' ? p : (p.url || p.thumbUrl || '');
      return `<img class="nbd-strip-thumb ${i === S.currentPhotoIndex ? 'active' : ''}" src="${url}" data-photo-idx="${i}" alt="Photo ${i + 1}">`;
    }).join('');
  }

  /* ==========================================
     WIRE UP EVENTS
     ========================================== */
  function wireEvents() {
    if (!root) return;

    // Top bar buttons
    root.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const act = btn.dataset.act;
        if (act === 'back') closeWithPrompt();
        else if (act === 'undo') undo();
        else if (act === 'redo') redo();
        else if (act === 'download') downloadLocal();
        else if (act === 'save-tags') saveTagsOnly();
        else if (act === 'save-copy') flattenAndSaveAs();
        else if (act === 'save-over') flattenAndSaveOver();
        else if (act === 'guided') toggleGuided();
        else if (act === 'toggle-panel') togglePanel();
        else if (act === 'zoom-in') { S.zoom = clamp(S.zoom * 1.2, 0.15, 8); applyTransform(); renderMinimap(); updateZoomDisplay(); }
        else if (act === 'zoom-out') { S.zoom = clamp(S.zoom / 1.2, 0.15, 8); applyTransform(); renderMinimap(); updateZoomDisplay(); }
        else if (act === 'zoom-fit') { fitZoom(); }
      });
    });

    // Tool buttons
    root.querySelectorAll('.nbd-tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (tool === TOOLS.STAMP) {
          const flyout = root.querySelector('#nbd-stamp-flyout');
          if (flyout) flyout.classList.toggle('open');
        }
        setTool(tool);
      });
    });

    // Stamp items
    root.querySelectorAll('.nbd-stamp-item').forEach(item => {
      item.addEventListener('click', () => {
        S.stampId = item.dataset.stamp;
        root.querySelectorAll('.nbd-stamp-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        setTool(TOOLS.STAMP);
        const flyout = root.querySelector('#nbd-stamp-flyout');
        if (flyout) flyout.classList.remove('open');
      });
    });

    // Close stamp flyout on outside click
    document.addEventListener('click', (e) => {
      const flyout = root?.querySelector('#nbd-stamp-flyout');
      if (flyout && flyout.classList.contains('open') && !e.target.closest('.nbd-stamp-flyout') && !e.target.closest('[data-tool="stamp"]')) {
        flyout.classList.remove('open');
      }
    });

    // Color swatches
    root.querySelectorAll('.nbd-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        S.color = sw.dataset.color;
        root.querySelectorAll('.nbd-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
        root.querySelector('#nbd-custom-color').style.background = S.color;
      });
    });

    // Custom color picker
    const colorBtn = root.querySelector('#nbd-custom-color');
    const colorInput = root.querySelector('#nbd-color-input');
    if (colorBtn && colorInput) {
      colorBtn.addEventListener('click', () => colorInput.click());
      colorInput.addEventListener('input', () => {
        S.color = colorInput.value;
        colorBtn.style.background = S.color;
        root.querySelectorAll('.nbd-swatch').forEach(s => s.classList.remove('active'));
      });
    }

    // Property sliders
    root.querySelectorAll('[data-prop]').forEach(slider => {
      slider.addEventListener('input', () => {
        const prop = slider.dataset.prop;
        S[prop] = parseInt(slider.value);
        const valEl = root.querySelector(`[data-prop-val="${prop}"]`);
        if (valEl) valEl.textContent = prop === 'opacity' ? S[prop] + '%' : S[prop] + 'px';
      });
    });

    // Fill & auto-number checkboxes
    const fillCb = root.querySelector('#nbd-fill');
    if (fillCb) fillCb.addEventListener('change', () => { S.fillShapes = fillCb.checked; });
    const autoNumCb = root.querySelector('#nbd-autonum');
    if (autoNumCb) autoNumCb.addEventListener('change', () => { S.autoNumber = autoNumCb.checked; });

    // Panel fields
    root.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('change', () => { S[el.dataset.field] = el.value; S.hasUnsaved = true; });
    });

    // Severity pills
    root.querySelectorAll('.nbd-severity-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        S.severity = pill.dataset.sev;
        root.querySelectorAll('.nbd-severity-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        S.hasUnsaved = true;
      });
    });

    // Phase tabs
    root.querySelectorAll('.nbd-phase-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        S.phase = tab.dataset.phase;
        root.querySelectorAll('.nbd-phase-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        S.hasUnsaved = true;
      });
    });

    // Tags
    const tagInput = root.querySelector('#nbd-tag-input');
    if (tagInput) {
      tagInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && tagInput.value.trim()) {
          addTag(tagInput.value.trim());
          tagInput.value = '';
        }
      });
    }

    // Notes
    const notesTA = root.querySelector('#nbd-notes');
    if (notesTA) notesTA.addEventListener('input', () => { S.notes = notesTA.value; S.hasUnsaved = true; });

    // Image adjustments
    root.querySelectorAll('[data-adjust]').forEach(slider => {
      slider.addEventListener('input', () => {
        const field = slider.dataset.adjust;
        S[field] = parseInt(slider.value);
        S.hasUnsaved = true;
        const valEl = root.querySelector(`[data-adjust-val="${field}"]`);
        if (valEl) valEl.textContent = S[field];
        renderImage();
        render();
      });
    });

    // Annotation list events (delegated)
    wireAnnListEvents();

    // Photo strip
    root.querySelectorAll('.nbd-strip-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => switchPhoto(parseInt(thumb.dataset.photoIdx)));
    });

    // Canvas events — listen on the canvas area for draw/click
    const canvasArea = root.querySelector('.nbd-canvas-area');
    if (canvasArea) {
      canvasArea.addEventListener('mousedown', onPointerDown);
      canvasArea.addEventListener('wheel', onWheel, { passive: false });
      canvasArea.addEventListener('touchstart', onTouchStart, { passive: false });
      canvasArea.addEventListener('touchmove', onTouchMove, { passive: false });
      canvasArea.addEventListener('touchend', onTouchEnd, { passive: false });

      // Context menu on right-click
      canvasArea.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const coords = screenToCanvas(e.clientX, e.clientY);
        const hit = hitTestAnno(coords.x, coords.y);
        if (hit) showContextMenu(e.clientX, e.clientY, hit);
      });
    }

    // Mouse move/up on window so drags work even when cursor leaves canvas
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', (e) => {
      onPointerUp(e);
      if (S.dragMode === 'pan') S.dragMode = null;
    });

    // Keyboard
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
  }

  function wireAnnListEvents() {
    root?.querySelectorAll('.nbd-ann-item').forEach(item => {
      item.addEventListener('click', () => {
        S.selectedId = item.dataset.annId;
        S.tool = TOOLS.SELECT;
        updateToolButtons();
        render();
        refreshAnnList();
      });
    });
    root?.querySelectorAll('.nbd-ann-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo();
        annotations = annotations.filter(a => a.id !== btn.dataset.delId);
        if (S.selectedId === btn.dataset.delId) S.selectedId = null;
        render();
        refreshAnnList();
      });
    });
  }

  function refreshAnnList() {
    const container = root?.querySelector('#nbd-ann-list');
    if (!container) return;
    container.innerHTML = buildAnnListHTML();
    wireAnnListEvents();
    // Update count
    const countLabel = root?.querySelector('.nbd-panel-label');
    // Not critical, just nice to have
  }

  function addTag(tag) {
    if (!tag || S.tags.includes(tag)) return;
    S.tags.push(tag);
    S.hasUnsaved = true;
    refreshTags();
  }

  function removeTag(tag) {
    S.tags = S.tags.filter(t => t !== tag);
    S.hasUnsaved = true;
    refreshTags();
  }

  function refreshTags() {
    const wrap = root?.querySelector('#nbd-tags-wrap');
    if (!wrap) return;
    wrap.innerHTML = S.tags.map(t => `<span class="nbd-tag">${esc(t)}<button class="nbd-tag-remove" data-tag="${esc(t)}">&times;</button></span>`).join('');
    wrap.querySelectorAll('.nbd-tag-remove').forEach(btn => {
      btn.addEventListener('click', () => removeTag(btn.dataset.tag));
    });
  }

  /* ==========================================
     PANEL TOGGLE
     ========================================== */
  function togglePanel() {
    const panel = root?.querySelector('#nbd-panel');
    if (!panel) return;
    if (window.innerWidth <= 768) {
      panel.classList.toggle('open');
    } else {
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
    }
  }

  /* ==========================================
     ZOOM
     ========================================== */
  function fitZoom() {
    const area = root?.querySelector('.nbd-canvas-area');
    if (!area || !S.imgW || !S.imgH) return;
    const areaRect = area.getBoundingClientRect();
    // If area hasn't laid out yet (zero size), retry after frame
    if (areaRect.width < 10 || areaRect.height < 10) {
      requestAnimationFrame(fitZoom);
      return;
    }
    const pad = 30; // padding around image
    const scaleX = (areaRect.width - pad * 2) / S.imgW;
    const scaleY = (areaRect.height - pad * 2) / S.imgH;
    S.zoom = Math.min(scaleX, scaleY, 1.5); // allow slight upscale for small images
    S.panX = 0;
    S.panY = 0;
    applyTransform();
    renderMinimap();
    updateZoomDisplay();
  }

  /* ==========================================
     CONTEXT MENU
     ========================================== */
  function showContextMenu(cx, cy, anno) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'nbd-context-menu';
    menu.style.left = cx + 'px';
    menu.style.top = cy + 'px';
    menu.innerHTML = `
      <div class="nbd-context-item" data-ctx="select">Select</div>
      <div class="nbd-context-item" data-ctx="duplicate">Duplicate</div>
      <div class="nbd-context-item" data-ctx="bring-front">Bring to Front</div>
      <div class="nbd-context-item" data-ctx="send-back">Send to Back</div>
      <div class="nbd-context-item danger" data-ctx="delete">Delete</div>
    `;
    document.body.appendChild(menu);

    menu.querySelectorAll('.nbd-context-item').forEach(item => {
      item.addEventListener('click', () => {
        const act = item.dataset.ctx;
        if (act === 'select') { S.selectedId = anno.id; S.tool = TOOLS.SELECT; updateToolButtons(); render(); refreshAnnList(); }
        else if (act === 'duplicate') { pushUndo(); const dup = JSON.parse(JSON.stringify(anno)); dup.id = uid(); if (dup.x != null) { dup.x += 20; dup.y += 20; } if (dup.x1 != null) { dup.x1 += 20; dup.y1 += 20; dup.x2 += 20; dup.y2 += 20; } annotations.push(dup); render(); refreshAnnList(); }
        else if (act === 'bring-front') { pushUndo(); annotations = annotations.filter(a => a.id !== anno.id); annotations.push(anno); render(); refreshAnnList(); }
        else if (act === 'send-back') { pushUndo(); annotations = annotations.filter(a => a.id !== anno.id); annotations.unshift(anno); render(); refreshAnnList(); }
        else if (act === 'delete') { pushUndo(); annotations = annotations.filter(a => a.id !== anno.id); if (S.selectedId === anno.id) S.selectedId = null; render(); refreshAnnList(); }
        closeContextMenu();
      });
    });

    setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 10);
  }

  function closeContextMenu() {
    document.querySelectorAll('.nbd-context-menu').forEach(m => m.remove());
  }

  /* ==========================================
     GUIDED INSPECTION
     ========================================== */
  function toggleGuided() {
    S.guidedActive = !S.guidedActive;
    refreshGuided();
  }

  function refreshGuided() {
    let overlay = root?.querySelector('.nbd-guided-overlay');
    if (!S.guidedActive) { if (overlay) overlay.remove(); return; }

    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'nbd-guided-overlay';
      root.querySelector('.nbd-canvas-area')?.appendChild(overlay);
    }

    if (!S.guidedPreset) {
      // Show preset picker
      overlay.innerHTML = `<div class="nbd-guided-card">
        <h3>Guided Inspection</h3>
        <p>Choose an inspection type to get a step-by-step checklist.</p>
        ${Object.entries(GUIDED_PRESETS).map(([k, v]) => `<button class="nbd-btn pex-wd100-mb8px-jcflexstar" data-preset="${k}">${v.label}</button>`).join('')}
        <button class="nbd-btn pex-wd100-mt4px" data-preset="cancel">Cancel</button>
      </div>`;
      overlay.querySelectorAll('[data-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.dataset.preset === 'cancel') { S.guidedActive = false; refreshGuided(); return; }
          S.guidedPreset = btn.dataset.preset;
          S.guidedChecked = [];
          refreshGuided();
        });
      });
      return;
    }

    const preset = GUIDED_PRESETS[S.guidedPreset];
    if (!preset) return;

    overlay.innerHTML = `<div class="nbd-guided-card pex-maxw440px">
      <h3>${preset.label}</h3>
      <p>Check off each item as you annotate it. Click an item to toggle.</p>
      ${preset.items.map((item, i) => `<div class="nbd-checklist-item ${S.guidedChecked.includes(i) ? 'done' : ''}" data-check="${i}">
        <div class="nbd-checklist-check">${S.guidedChecked.includes(i) ? '✓' : ''}</div>
        <span>${item}</span>
      </div>`).join('')}
      <div class="pex-dflex-gap8px-mt14px">
        <button class="nbd-btn pex-fx1" data-guide-act="minimize">Minimize</button>
        <button class="nbd-btn primary pex-fx1" data-guide-act="done">Done</button>
      </div>
    </div>`;

    overlay.querySelectorAll('.nbd-checklist-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.check);
        if (S.guidedChecked.includes(idx)) S.guidedChecked = S.guidedChecked.filter(i => i !== idx);
        else S.guidedChecked.push(idx);
        refreshGuided();
      });
    });

    overlay.querySelector('[data-guide-act="minimize"]')?.addEventListener('click', () => {
      S.guidedActive = false;
      refreshGuided();
      // Could show a small floating badge instead — keeping it simple for now
    });
    overlay.querySelector('[data-guide-act="done"]')?.addEventListener('click', () => {
      S.guidedActive = false;
      S.guidedPreset = null;
      S.guidedChecked = [];
      refreshGuided();
    });
  }

  /* ==========================================
     MULTI-PHOTO
     ========================================== */
  async function switchPhoto(idx) {
    if (idx === S.currentPhotoIndex || idx < 0 || idx >= S.allPhotos.length) return;
    // Guard against silent loss of annotations when the user clicks
    // a different photo without saving. If anything's been drawn /
    // marked / typed, confirm before discarding.
    if (annotations.length > 0) {
      // Batch 2 (iOS PWA): nbdConfirm so the unsaved-annotation gate
      // actually blocks the switch in standalone (native confirm
      // returns true unconditionally there).
      const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      const proceed = await _ask(
        `You have ${annotations.length} unsaved annotation${annotations.length === 1 ? '' : 's'} on this photo.\n\nSwitching photos will discard them. Continue?`
      );
      if (!proceed) return;
    }
    S.currentPhotoIndex = idx;
    const photo = S.allPhotos[idx];
    const url = typeof photo === 'string' ? photo : (photo.url || '');
    // Re-key persistence to the newly-selected photo. saveTagsOnly() and
    // uploadBlob() both write to /photos/{S.photoId} — leaving this
    // pointed at whichever photo the editor was FIRST opened with would
    // silently save this photo's tags/annotations onto a different
    // photo's Firestore doc. A bare-URL string entry carries no id to
    // key off of; null it out so the existing "No photo ID" guard in
    // saveTagsOnly()/uploadBlob() blocks the save instead of
    // mis-targeting one.
    S.photoId = (photo && typeof photo === 'object' && photo.id) ? photo.id : null;
    S.photoUrl = url;
    // Load this photo's own persisted adjustments (0 if none / a bare URL),
    // so each photo shows its own — not the previously-viewed photo's.
    S.brightness = Number(photo && photo.brightness) || 0;
    S.contrast = Number(photo && photo.contrast) || 0;
    try {
      S.originalImage = await loadImage(url);
      S.imgW = S.originalImage.width;
      S.imgH = S.originalImage.height;
      if (S.imgW > 1600) { const ratio = S.imgH / S.imgW; S.imgW = 1600; S.imgH = S.imgW * ratio; }
      if (S.imgH > 1000) { const ratio = S.imgW / S.imgH; S.imgH = 1000; S.imgW = S.imgH * ratio; }
      S.imgW = Math.round(S.imgW);
      S.imgH = Math.round(S.imgH);
      initCanvases();
      renderImage();
      // Restore this photo's own saved shapes (falls back to blank for a
      // photo that was never annotated, or whose allPhotos entry doesn't
      // carry the field) instead of always discarding them on switch.
      annotations = (photo && Array.isArray(photo.annotations)) ? JSON.parse(JSON.stringify(photo.annotations)) : [];
      undoStack = [];
      redoStack = [];
      render();
      fitZoom();
      refreshAnnList();
      syncAdjustUI();
      // Update strip active
      root?.querySelectorAll('.nbd-strip-thumb').forEach((t, i) => t.classList.toggle('active', i === idx));
    } catch (err) { toast('Failed to load photo', 'error'); }
  }

  /* ==========================================
     CANVAS INIT
     ========================================== */
  function initCanvases() {
    const wrapper = root?.querySelector('.nbd-canvas-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';
    wrapper.style.width = S.imgW + 'px';
    wrapper.style.height = S.imgH + 'px';

    mainCanvas = document.createElement('canvas');
    mainCanvas.width = S.imgW; mainCanvas.height = S.imgH;
    mainCanvas.style.cssText = 'position:absolute;top:0;left:0';

    annoCanvas = document.createElement('canvas');
    annoCanvas.width = S.imgW; annoCanvas.height = S.imgH;
    annoCanvas.style.cssText = 'position:absolute;top:0;left:0';

    wrapper.appendChild(mainCanvas);
    wrapper.appendChild(annoCanvas);

    mCtx = mainCanvas.getContext('2d', { willReadFrequently: true });
    aCtx = annoCanvas.getContext('2d');
  }

  /* ==========================================
     SVG ICONS (inline for zero dependencies)
     ========================================== */
  const svgPointer = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>`;
  const svgPen = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>`;
  const svgLine = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/></svg>`;
  const svgArrow = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
  const svgRect = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;
  const svgCircle = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`;
  const svgText = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9.5" y1="20" x2="14.5" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`;
  const svgCallout = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><text x="12" y="16" text-anchor="middle" font-size="12" fill="currentColor" stroke="none">1</text></svg>`;
  const svgEraser = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14.8 1.4c.8-.8 2-.8 2.8 0l5 5c.8.8.8 2 0 2.8L11 20"/><path d="M18 13L11 6"/></svg>`;
  const svgStamp = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21h14"/><path d="M5 21V11l3-3h8l3 3v10"/><circle cx="12" cy="7" r="4"/></svg>`;
  const svgMeasure = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.3 15.3a2.4 2.4 0 010 3.4l-2.6 2.6a2.4 2.4 0 01-3.4 0L2.7 8.7a2.4 2.4 0 010-3.4l2.6-2.6a2.4 2.4 0 013.4 0z"/><path d="M14.5 12.5l2-2"/><path d="M11.5 9.5l2-2"/><path d="M8.5 6.5l2-2"/><path d="M17.5 15.5l2-2"/></svg>`;

  /* ==========================================
     CLOSE
     ========================================== */
  async function closeWithPrompt() {
    if (S.hasUnsaved) {
      // Batch 2 (iOS PWA): real async gate.
      const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      if (!(await _ask('You have unsaved changes. Close anyway?'))) return;
    }
    closeEditor();
  }

  // Audit batch 1: native browser navigation guard. The in-app close
  // button already prompts on unsaved (closeWithPrompt), but a rep who
  // hits the back button / closes the tab / pulls down to refresh
  // bypasses that. beforeunload fires the browser's "Leave site?"
  // warning when S.hasUnsaved is true — fires on every navigation
  // away from the page, regardless of how it's triggered. Standard
  // unsaved-changes pattern; harmless when nothing is unsaved.
  function _onBeforeUnload(e) {
    if (!S.hasUnsaved) return;
    // Chrome/Safari ignore custom messages now; presence of returnValue
    // is what triggers the prompt. Set a string for older browsers.
    e.preventDefault();
    e.returnValue = 'You have unsaved photo annotations. Leave anyway?';
    return e.returnValue;
  }

  function closeEditor() {
    if (root) root.remove();
    root = null;
    mainCanvas = null; annoCanvas = null;
    mCtx = null; aCtx = null;
    annotations = [];
    undoStack = []; redoStack = [];
    S.selectedId = null;
    S.guidedActive = false;
    S.guidedPreset = null;
    isDrawing = false;
    S.dragMode = null;
    S.isPanning = false;
    // Clean up window-level listeners
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onPointerMove);
    window.removeEventListener('beforeunload', _onBeforeUnload);
    // Note: anonymous mouseup wrapper can't be removed, but it safely no-ops when root is null
  }

  /* ==========================================
     PUBLIC API: OPEN
     ========================================== */
  async function openEditor(photoUrl, photoId, leadId, photoData, allPhotos) {
    closeEditor(); // Clean up any previous instance

    S.photoUrl = photoUrl;
    S.photoId = photoId;
    S.leadId = leadId;
    S.userId = window.auth?.currentUser?.uid || '';
    S.photoData = photoData;
    S.calloutNum = 1;
    S.hasUnsaved = false;
    // Audit batch 1: arm the beforeunload guard so the browser warns
    // on back / tab-close / refresh while annotations are pending.
    // closeEditor() removes it on the in-app close path.
    window.addEventListener('beforeunload', _onBeforeUnload);
    S.zoom = 1; S.panX = 0; S.panY = 0;
    S.brightness = 0; S.contrast = 0;
    S.selectedId = null;
    S.allPhotos = allPhotos || [];
    S.currentPhotoIndex = 0;
    annotations = [];
    undoStack = [];
    redoStack = [];
    S.origUrl = null; S.origStoragePath = null; S.hasOriginalBackup = false;

    if (photoData) {
      S.damageType = _dmgNorm(photoData.damageType);
      S.severity = photoData.severity || '';
      S.location = photoData.location || '';
      S.phase = photoData.phase || 'Before';
      S.notes = photoData.notes || '';
      S.tags = photoData.tags || [];
      // Re-apply persisted non-destructive adjustments. Set before
      // buildEditor()/renderImage() so the sliders + first paint reflect them.
      S.brightness = Number(photoData.brightness) || 0;
      S.contrast = Number(photoData.contrast) || 0;
      // Restore previously-saved vector shapes (annotations now survive
      // Save Tags / Save, not just live in-memory) instead of always
      // starting blank — see saveTagsOnly()/uploadBlob().
      annotations = Array.isArray(photoData.annotations) ? JSON.parse(JSON.stringify(photoData.annotations)) : [];
      // Track the live url/storagePath + whether a pristine backup already
      // exists, so a save-over backs it up exactly once (see uploadBlob()).
      S.origUrl = photoData.url || photoUrl || null;
      S.origStoragePath = photoData.storagePath || null;
      S.hasOriginalBackup = !!(photoData.originalUrl || photoData.originalStoragePath);
    } else {
      S.damageType = ''; S.severity = ''; S.location = ''; S.phase = 'Before'; S.notes = ''; S.tags = [];
    }

    try {
      S.originalImage = await loadImage(photoUrl);
      S.imgW = S.originalImage.width;
      S.imgH = S.originalImage.height;
      // Cap canvas size for performance
      if (S.imgW > 1600) { const ratio = S.imgH / S.imgW; S.imgW = 1600; S.imgH = Math.round(S.imgW * ratio); }
      if (S.imgH > 1000) { const ratio = S.imgW / S.imgH; S.imgH = 1000; S.imgW = Math.round(S.imgH * ratio); }
      S.imgW = Math.round(S.imgW);
      S.imgH = Math.round(S.imgH);

      buildEditor();
      initCanvases();
      renderImage();
      wireEvents();
      // Wire the ✕ buttons on any PRE-LOADED tags too: wireEvents() doesn't bind
      // them and refreshTags() otherwise only runs on add/remove/Firestore-load,
      // so tags passed in via photoData couldn't be removed until a new tag was
      // added. refreshTags() re-renders the same chips + binds their handlers.
      refreshTags();
      render();

      // Fit after layout settles — double rAF ensures DOM has painted
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitZoom();
          updateCursor();
        });
      });

      // Load existing photo metadata from Firestore
      if (photoId && !photoData) {
        try {
          const docSnap = await window.getDoc(window.doc(window.db, 'photos', photoId));
          if (docSnap.exists()) {
            const d = docSnap.data();
            S.damageType = _dmgNorm(d.damageType); S.severity = d.severity || '';
            S.location = d.location || ''; S.phase = d.phase || 'Before';
            S.notes = d.notes || ''; S.tags = d.tags || [];
            S.brightness = Number(d.brightness) || 0;
            S.contrast = Number(d.contrast) || 0;
            // Restore previously-saved vector shapes instead of leaving the
            // blank array openEditor() started with — the read-side half of
            // saveTagsOnly()/uploadBlob() persisting them.
            annotations = Array.isArray(d.annotations) ? JSON.parse(JSON.stringify(d.annotations)) : [];
            S.origUrl = d.url || photoUrl || null;
            S.origStoragePath = d.storagePath || null;
            S.hasOriginalBackup = !!(d.originalUrl || d.originalStoragePath);
            // Refresh panel fields + sliders, then repaint with the
            // loaded adjustments (this branch runs after the first render).
            refreshPanelFields();
            renderImage(); render();
            refreshAnnList();
          }
        } catch (e) { console.warn('Could not load photo metadata:', e); }
      }

    } catch (err) {
      console.error('Editor open error:', err);
      toast('Failed to open editor: ' + err.message, 'error');
      closeEditor();
    }
  }

  function refreshPanelFields() {
    if (!root) return;
    const dmgSel = root.querySelector('[data-field="damageType"]');
    if (dmgSel) dmgSel.value = _dmgNorm(S.damageType);
    const locSel = root.querySelector('[data-field="location"]');
    if (locSel) locSel.value = S.location;
    root.querySelectorAll('.nbd-severity-pill').forEach(p => p.classList.toggle('active', p.dataset.sev === S.severity));
    root.querySelectorAll('.nbd-phase-tab').forEach(t => t.classList.toggle('active', t.dataset.phase === S.phase));
    const notesTA = root.querySelector('#nbd-notes');
    if (notesTA) notesTA.value = S.notes;
    syncAdjustUI();
    refreshTags();
  }

  // Sync the brightness/contrast slider positions + value labels from S.
  // Used after loading persisted adjustments (openEditor doc-fetch branch,
  // switchPhoto) since the sliders are only seeded with S at build time.
  function syncAdjustUI() {
    if (!root) return;
    ['brightness', 'contrast'].forEach(field => {
      const sl = root.querySelector(`[data-adjust="${field}"]`);
      if (sl) sl.value = S[field];
      const v = root.querySelector(`[data-adjust-val="${field}"]`);
      if (v) v.textContent = S[field];
    });
  }

  /* ==========================================
     EXPOSE PUBLIC API
     ========================================== */
  window.NBDPhotoEditor = {
    open: openEditor,
    close: closeEditor,
  };

  console.log('NBD Inspection Editor v2.0 loaded');
})();

/**
 * NBD Pro Theme Engine - Visual Overlay Renderer
 * Creates atmospheric visual effects behind CRM content
 * Supports 37+ overlay types: CSS-only and canvas-based particle systems
 */

(function() {
  'use strict';

  const ThemeOverlays = {
    enabled: true,
    container: null,
    canvas: null,
    ctx: null,
    currentOverlay: null,
    particles: [],
    animationId: null,
    frameCount: 0,
    isHidden: false,
    minScreenWidth: 768,

    // ==================== INITIALIZATION ====================
    init() {
      if (this.container) return;

      // Create overlay container
      const container = document.createElement('div');
      container.id = 'te-overlay';
      container.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 0;
        overflow: hidden;
      `;

      // Create canvas for particle effects
      const canvas = document.createElement('canvas');
      canvas.id = 'te-canvas';
      canvas.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        display: block;
      `;

      container.appendChild(canvas);
      document.body.insertBefore(container, document.body.firstChild);

      this.container = container;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { willReadFrequently: false });
      this.setupCanvas();

      // Load persisted on/off state. Previously `enabled` was hardcoded
      // true with nothing ever overriding it from storage, so switching
      // this off in Settings did not survive a reload. Mirrors ThemeSounds'
      // localStorage pattern (nbd-theme-sound).
      try {
        const saved = localStorage.getItem('nbd-theme-overlays');
        if (saved !== null) this.enabled = saved === 'true';
      } catch (_) {}

      // Visibility listener — actually stop the animation loop while
      // hidden instead of only skipping its work. Previously this flipped
      // `isHidden` and the loop kept rescheduling requestAnimationFrame
      // forever, just no-op'ing the callback each tick; browsers throttle
      // a hidden tab's rAF on their own, but it was never truly cancelled.
      document.addEventListener('visibilitychange', () => {
        this.isHidden = document.hidden;
        if (this.isHidden) {
          if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
          }
        } else if (this._loopCallback && !this.animationId) {
          this.animationLoop(this._loopCallback);
        }
      });

      // Resize listener (debounced)
      let resizeTimeout;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => this.setupCanvas(), 150);
      });
    },

    setupCanvas() {
      if (!this.canvas || !this.ctx) return;
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
    },

    // ==================== PUBLIC API ====================
    apply(overlayConfig) {
      if (!this.enabled) return;
      if (!this.container) this.init();

      this.destroy();

      if (!overlayConfig || !overlayConfig.type) return;

      // Self-gated overlays (shader-gradient) run on phones and handle
      // reduced motion themselves — one static frame instead of nothing —
      // because they ARE the theme's wallpaper, not decoration on top of it.
      // They stay cheap: reduced-resolution render, 30fps cap, paused when
      // the tab is hidden.
      const selfGated = !!this.selfGatedOverlays[overlayConfig.type];

      // Mobile optimization
      if (!selfGated && window.innerWidth < this.minScreenWidth) {
        console.log('[ThemeOverlays] Mobile detected, skipping overlay');
        return;
      }

      // Respect reduced motion — the OS-level preference and this app's
      // own Comfort-tab toggle (data-motion="reduce" on <html>) are two
      // independent signals; neither implies the other, so both are
      // checked. Previously neither was checked anywhere in this file.
      if (!selfGated && this.prefersReducedMotion()) {
        console.log('[ThemeOverlays] Reduced motion preferred, skipping overlay');
        return;
      }

      const { type, ...config } = overlayConfig;
      const overlayFunc = this.overlayLibrary[type];

      if (!overlayFunc) {
        console.warn(`[ThemeOverlays] Unknown overlay type: ${type}`);
        return;
      }

      this.currentOverlay = { type, config };
      overlayFunc.call(this, this.container, config);
    },

    destroy() {
      if (this.animationId) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
      this._loopCallback = null;

      // Per-overlay teardown (shader-gradient: resize listener, GL context,
      // the container z-index it lowered). Runs before the child sweep below.
      if (typeof this._overlayCleanup === 'function') {
        try { this._overlayCleanup(); } catch (_) {}
      }
      this._overlayCleanup = null;

      this.particles = [];
      this.frameCount = 0;

      if (this.canvas && this.ctx) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.style.display = 'none';
      }

      if (this.container) {
        // Keep canvas, clear other content
        const children = Array.from(this.container.children);
        children.forEach(child => {
          if (child.id !== 'te-canvas') {
            child.remove();
          }
        });
      }
    },

    setEnabled(enabled) {
      this.enabled = enabled;
      try { localStorage.setItem('nbd-theme-overlays', enabled ? 'true' : 'false'); } catch (_) {}
      if (!enabled && this.container) {
        this.destroy();
      }
    },

    isEnabled() {
      return this.enabled;
    },

    prefersReducedMotion() {
      let osPref = false;
      try { osPref = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
      const appPref = document.documentElement.getAttribute('data-motion') === 'reduce';
      return !!(osPref || appPref);
    },

    // ==================== SHADER GRADIENT HELPERS ====================
    // Overlay types that bypass the phone-width and reduced-motion skips in
    // apply() because they gate themselves (see 'shader-gradient').
    selfGatedOverlays: { 'shader-gradient': true },

    // Resolve a colour stop to [r,g,b] in 0..1. Accepts '#rrggbb' / '#rgb'
    // or a custom-property name ('--bg') read from the ACTIVE theme, so a
    // theme can point its wallpaper at its own tokens.
    shaderColor(value, fallback) {
      let v = value;
      if (typeof v === 'string' && v.indexOf('--') === 0) {
        try { v = getComputedStyle(document.documentElement).getPropertyValue(v).trim(); } catch (_) { v = ''; }
      }
      const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
      if (!m) return fallback || [0.03, 0.04, 0.14];
      let h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    },

    shaderRgb(c) {
      return 'rgb(' + c.map((x) => Math.round(x * 255)).join(',') + ')';
    },

    // Non-WebGL fallback: a static CSS layered radial gradient in the same
    // stops, so the theme keeps its wallpaper on GPUs/browsers with WebGL
    // disabled (and after a lost context).
    shaderFallback(container, stops) {
      const [c0, c1, c2, c3] = stops.map((c) => this.shaderRgb(c));
      const div = document.createElement('div');
      div.className = 'te-shader-fallback';
      div.style.cssText =
        'position:absolute;inset:0;pointer-events:none;' +
        'background:' +
        'radial-gradient(70% 55% at 18% 12%,' + c1 + ' 0%,transparent 70%),' +
        'radial-gradient(60% 50% at 85% 30%,' + c2 + ' 0%,transparent 70%),' +
        'radial-gradient(65% 55% at 60% 95%,' + c3 + ' 0%,transparent 72%),' +
        c0 + ';';
      container.appendChild(div);
      return div;
    },

    // Hand-written fragment shader (no third-party code): two-level
    // domain-warped value-noise fbm slowly drifts a 4-stop gradient, with a
    // soft vignette back to the base colour and a faint STATIC grain to kill
    // banding. Rendered at reduced resolution and CSS-upscaled — the noise
    // is low-frequency, so the upscale is invisible.
    shaderSource: {
      vert:
        'attribute vec2 aPos;' +
        'void main(){gl_Position=vec4(aPos,0.0,1.0);}',
      frag: [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'uniform vec2 uRes;',
        'uniform float uTime;',
        'uniform vec3 uC0;',
        'uniform vec3 uC1;',
        'uniform vec3 uC2;',
        'uniform vec3 uC3;',
        'uniform float uGrain;',
        'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
        'float vnoise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);',
        '  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x),u.y);}',
        'float fbm(vec2 p){float v=0.0;float a=0.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);',
        '  for(int i=0;i<4;i++){v+=a*vnoise(p);p=m*p;a*=0.5;}return v;}',
        'void main(){',
        '  vec2 uv=gl_FragCoord.xy/uRes;',
        '  vec2 p=vec2(uv.x*(uRes.x/uRes.y),uv.y);',
        '  float t=uTime*0.035;',
        '  vec2 q=vec2(fbm(p*1.1+vec2(0.0,t)),fbm(p*1.1+vec2(5.2,-t*0.8)));',
        '  float n=fbm(p*1.3+1.7*q+vec2(t*0.6,-t*0.3));',
        '  float m=fbm(p*0.9-1.3*q+vec2(-t*0.4,t*0.5)+3.7);',
        '  vec3 col=uC0;',
        '  col=mix(col,uC1,smoothstep(0.28,0.78,n));',
        '  col=mix(col,uC2,smoothstep(0.42,0.82,m)*0.85);',
        '  col=mix(col,uC3,smoothstep(0.30,0.62,n*m*1.5)*0.75);',
        '  float vig=smoothstep(1.3,0.3,length(uv-vec2(0.5,0.55)));',
        '  col=mix(uC0,col,0.65+0.35*vig);',
        '  col+=(hash(floor(gl_FragCoord.xy))-0.5)*uGrain;',
        '  gl_FragColor=vec4(col,1.0);',
        '}'
      ].join('\n')
    },

    // ==================== UTILITY HELPERS ====================
    createSVG(width, height, viewBox) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', width);
      svg.setAttribute('height', height);
      svg.setAttribute('viewBox', viewBox);
      return svg;
    },

    // `respawn` is an optional zero-arg function returning a fresh
    // {x,y,vx,vy,size,life,maxLife,opacity} — when a finite-life particle
    // dies, updateParticles() resets it in place via this instead of
    // removing it, for the handful of overlays meant to be a persistent
    // ambient field (embers, drifting motes) rather than a one-shot burst
    // (e.g. the star-field shooting-star trail, which correctly disappears
    // and is left with no respawn so it keeps its current behavior).
    addParticle(x, y, vx, vy, size, color, opacity, life, respawn) {
      this.particles.push({
        x, y, vx, vy, size, color, opacity, life, maxLife: life, respawn
      });
    },

    animationLoop(callback) {
      this._loopCallback = callback;
      if (this.isHidden) return;
      const tick = () => {
        this.frameCount++;
        // Frame skipping for 30fps (skip every other frame @ 60fps)
        if (this.frameCount % 2 === 0) {
          callback();
        }

        this.animationId = requestAnimationFrame(tick);
      };
      this.animationId = requestAnimationFrame(tick);
    },

    // ==================== OVERLAY LIBRARY ====================
    overlayLibrary: {

      // WEBGL WALLPAPER
      //
      // 'shader-gradient' (2026-10-01, Live Ops theme): a full-viewport
      // slowly-moving noise gradient behind the app. Config:
      //   colors: 4 stops — '#hex' or a token name ('--bg'); [0] is the base
      //   speed:  time multiplier (default 1)
      //   scale:  render-resolution factor vs CSS px (default 0.5)
      //   grain:  static grain amplitude (default 0.018)
      //   darkOnly: skip entirely when the app resolves to light mode
      // Gates: reduced motion → ONE static frame, no loop; hidden tab →
      // the engine's visibilitychange handler cancels the rAF loop, and the
      // frame callback itself also bails on document.hidden; 30fps cap is
      // time-based (not frame-parity) so 120Hz screens don't double it;
      // no WebGL / shader compile failure / lost context → static CSS
      // gradient in the same stops.
      'shader-gradient'(container, config) {
        const self = this;
        const html = document.documentElement;
        if (config.darkOnly && html.getAttribute('data-mode') === 'light') return;

        const fallbackStops = [[0.027, 0.043, 0.141], [0.08, 0.16, 0.47], [0.19, 0.1, 0.43], [0.04, 0.24, 0.36]];
        const raw = Array.isArray(config.colors) ? config.colors : [];
        const stops = [0, 1, 2, 3].map((i) => self.shaderColor(raw[i], fallbackStops[i]));
        const reduced = self.prefersReducedMotion();
        const speed = typeof config.speed === 'number' ? config.speed : 1;
        const scale = Math.min(1, Math.max(0.25, config.scale || 0.5));
        const grain = typeof config.grain === 'number' ? config.grain : 0.018;

        // Paint BEHIND the app: the shared container is z-index 0, which
        // stacks above in-flow content; a full-bleed opaque wallpaper must
        // sit at -1. Restored in cleanup so other overlays are unchanged.
        const prevZ = container.style.zIndex;
        container.style.zIndex = '-1';
        html.classList.add('te-wallpaper-on');

        let fallbackEl = null;
        let canvas = document.createElement('canvas');
        canvas.className = 'te-shader';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
        container.appendChild(canvas);

        const goFallback = () => {
          if (canvas) { canvas.remove(); canvas = null; }
          if (!fallbackEl) fallbackEl = self.shaderFallback(container, stops);
        };

        let gl = null;
        try {
          const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
          gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
        } catch (_) { gl = null; }

        let onResize = null;
        // Set on teardown. loseContext() below fires 'webglcontextlost'
        // asynchronously on THIS canvas — by then a newer overlay may own the
        // container and the rAF loop, so the handler must not touch either.
        let disposed = false;
        self._overlayCleanup = () => {
          disposed = true;
          if (onResize) window.removeEventListener('resize', onResize);
          if (gl) {
            try { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (_) {}
          }
          container.style.zIndex = prevZ || '0';
          html.classList.remove('te-wallpaper-on');
        };

        if (!gl) { goFallback(); return; }

        const compile = (type, src) => {
          const sh = gl.createShader(type);
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
          if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.warn('[ThemeOverlays] shader compile failed:', gl.getShaderInfoLog(sh));
            return null;
          }
          return sh;
        };
        const vs = compile(gl.VERTEX_SHADER, self.shaderSource.vert);
        const fs = compile(gl.FRAGMENT_SHADER, self.shaderSource.frag);
        const prog = vs && fs ? gl.createProgram() : null;
        if (prog) {
          gl.attachShader(prog, vs);
          gl.attachShader(prog, fs);
          gl.linkProgram(prog);
        }
        if (!prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) { goFallback(); return; }
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        const uRes = gl.getUniformLocation(prog, 'uRes');
        const uTime = gl.getUniformLocation(prog, 'uTime');
        gl.uniform3fv(gl.getUniformLocation(prog, 'uC0'), stops[0]);
        gl.uniform3fv(gl.getUniformLocation(prog, 'uC1'), stops[1]);
        gl.uniform3fv(gl.getUniformLocation(prog, 'uC2'), stops[2]);
        gl.uniform3fv(gl.getUniformLocation(prog, 'uC3'), stops[3]);
        gl.uniform1f(gl.getUniformLocation(prog, 'uGrain'), grain);

        // Time starts mid-flow so the static (reduced-motion) frame is a
        // composed picture, not the noise field's origin.
        let t = 40;
        const sizeCanvas = () => {
          if (!canvas) return;
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const w = Math.max(1, Math.round(window.innerWidth * dpr * scale));
          const h = Math.max(1, Math.round(window.innerHeight * dpr * scale));
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          gl.viewport(0, 0, w, h);
          gl.uniform2f(uRes, w, h);
        };
        const draw = () => {
          if (!canvas || gl.isContextLost()) return;
          gl.uniform1f(uTime, t);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        };

        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          if (disposed) return; // our own teardown released it
          if (self.animationId) { cancelAnimationFrame(self.animationId); self.animationId = null; }
          self._loopCallback = null;
          goFallback();
        });

        let resizeTimer = null;
        onResize = () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => { if (!disposed) { sizeCanvas(); draw(); } }, 150);
        };
        window.addEventListener('resize', onResize);

        sizeCanvas();

        // Reduced motion: ONE static frame, no animation loop at all.
        if (reduced) {
          draw();
          return;
        }

        let last = performance.now();
        const FRAME_MS = 1000 / 30;
        draw();
        self.animationLoop(() => {
          if (document.hidden) return;
          const now = performance.now();
          const dt = now - last;
          if (dt < FRAME_MS - 1) return; // 30fps cap regardless of refresh rate
          last = now;
          t += Math.min(dt, 100) / 1000 * speed; // no jump after a pause
          draw();
        });
      },

      // CSS-ONLY OVERLAYS

      'film-grain'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          opacity: 0.03;
          background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><filter id="noise"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" result="noise" /></filter><rect width="100" height="100" fill="white" filter="url(%23noise)" /></svg>');
          will-change: transform;
          animation: grain-shift 0.2s infinite;
        `;

        if (!document.querySelector('style[data-grain-animation]')) {
          const style = document.createElement('style');
          style.setAttribute('data-grain-animation', 'true');
          style.textContent = `
            @keyframes grain-shift {
              0% { transform: translate(0, 0); }
              10% { transform: translate(-2px, -1px); }
              20% { transform: translate(-1px, 2px); }
              30% { transform: translate(1px, -2px); }
              40% { transform: translate(2px, 1px); }
              50% { transform: translate(-1px, -1px); }
              60% { transform: translate(1px, 2px); }
              70% { transform: translate(-2px, -2px); }
              80% { transform: translate(2px, -1px); }
              90% { transform: translate(-1px, 1px); }
              100% { transform: translate(0, 0); }
            }
          `;
          document.head.appendChild(style);
        }

        this.container.appendChild(div);
      },

      'ruled-lines'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          opacity: 0.04;
          background: repeating-linear-gradient(
            0deg,
            transparent,
            transparent 24px,
            rgba(0, 0, 0, 0.3) 24px,
            rgba(0, 0, 0, 0.3) 25px
          );
        `;
        this.container.appendChild(div);
      },

      'vertical-lines'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          opacity: 0.05;
          background: repeating-linear-gradient(
            90deg,
            transparent,
            transparent 19px,
            rgba(128, 128, 128, 0.4) 19px,
            rgba(128, 128, 128, 0.4) 20px
          );
        `;
        this.container.appendChild(div);
      },

      'hexagonal'() {
        const svg = this.createSVG('100%', '100%', '0 0 100 100');
        svg.style.cssText = 'position: absolute; top: 0; left: 0; opacity: 0.04;';

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
        pattern.setAttribute('id', 'hex-pattern');
        pattern.setAttribute('x', '20');
        pattern.setAttribute('y', '20');
        pattern.setAttribute('width', '50');
        pattern.setAttribute('height', '50');
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M25,5 L45,15 L45,35 L25,45 L5,35 L5,15 Z');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'rgba(0, 0, 0, 0.8)');
        path.setAttribute('stroke-width', '0.5');

        pattern.appendChild(path);
        defs.appendChild(pattern);
        svg.appendChild(defs);

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', '100%');
        rect.setAttribute('height', '100%');
        rect.setAttribute('fill', 'url(#hex-pattern)');
        svg.appendChild(rect);

        this.container.appendChild(svg);
      },

      'wood-grain'() {
        const svg = this.createSVG('100%', '100%', '0 0 200 200');
        svg.style.cssText = 'position: absolute; top: 0; left: 0; opacity: 0.05;';

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', 'wood');

        const turbulence = document.createElementNS('http://www.w3.org/2000/svg', 'feTurbulence');
        turbulence.setAttribute('type', 'fractalNoise');
        turbulence.setAttribute('baseFrequency', '0.02');
        turbulence.setAttribute('numOctaves', '5');
        turbulence.setAttribute('result', 'noise');

        const displacement = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap');
        displacement.setAttribute('in', 'SourceGraphic');
        displacement.setAttribute('in2', 'noise');
        displacement.setAttribute('scale', '20');

        filter.appendChild(turbulence);
        filter.appendChild(displacement);
        defs.appendChild(filter);
        svg.appendChild(defs);

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', '100%');
        rect.setAttribute('height', '100%');
        rect.setAttribute('fill', 'rgba(139, 69, 19, 0.1)');
        rect.setAttribute('filter', 'url(#wood)');
        svg.appendChild(rect);

        this.container.appendChild(svg);
      },

      'ink-wash'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            180deg,
            rgba(0, 0, 0, 0) 0%,
            rgba(0, 0, 0, 0.02) 25%,
            rgba(0, 0, 0, 0.04) 50%,
            rgba(0, 0, 0, 0.02) 75%,
            rgba(0, 0, 0, 0) 100%
          );
        `;
        this.container.appendChild(div);
      },

      'earth-crack'() {
        const svg = this.createSVG('100%', '100%', '0 0 1000 1000');
        svg.style.cssText = 'position: absolute; top: 0; left: 0; opacity: 0.06;';

        for (let i = 0; i < 8; i++) {
          const x1 = Math.random() * 1000;
          const y1 = Math.random() * 1000;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M${x1},${y1} Q${x1 + Math.random() * 200 - 100},${y1 + Math.random() * 200 - 100} ${x1 + Math.random() * 400 - 200},${y1 + Math.random() * 400 - 200}`);
          path.setAttribute('stroke', 'rgba(0, 0, 0, 0.8)');
          path.setAttribute('stroke-width', '2');
          path.setAttribute('fill', 'none');
          svg.appendChild(path);
        }

        this.container.appendChild(svg);
      },

      'vhs-lines'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          opacity: 0.02;
          background: repeating-linear-gradient(
            0deg,
            rgba(0, 0, 0, 0.5) 0px,
            rgba(0, 0, 0, 0.5) 1px,
            transparent 1px,
            transparent 3px
          );
        `;
        this.container.appendChild(div);
      },

      'perspective-grid'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 50%;
          left: 50%;
          width: 200%;
          height: 200%;
          transform: translate(-50%, -50%) perspective(800px) rotateX(60deg);
          opacity: 0.04;
          background-image:
            linear-gradient(0deg, transparent 24%, rgba(100, 100, 255, 0.05) 25%, rgba(100, 100, 255, 0.05) 26%, transparent 27%, transparent 74%, rgba(100, 100, 255, 0.05) 75%, rgba(100, 100, 255, 0.05) 76%, transparent 77%, transparent),
            linear-gradient(90deg, transparent 24%, rgba(100, 100, 255, 0.05) 25%, rgba(100, 100, 255, 0.05) 26%, transparent 27%, transparent 74%, rgba(100, 100, 255, 0.05) 75%, rgba(100, 100, 255, 0.05) 76%, transparent 77%, transparent);
          background-size: 50px 50px;
        `;
        this.container.appendChild(div);
      },

      'watercolor'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          opacity: 0.04;
        `;

        for (let i = 0; i < 6; i++) {
          const spot = document.createElement('div');
          const colors = ['rgba(180, 140, 100)', 'rgba(120, 160, 140)', 'rgba(160, 120, 140)'];
          const color = colors[Math.floor(Math.random() * colors.length)];
          spot.style.cssText = `
            position: absolute;
            border-radius: 50%;
            filter: blur(80px);
            opacity: 0.15;
            background: radial-gradient(ellipse at 30% 30%, ${color}, transparent);
            width: 300px;
            height: 300px;
            top: ${Math.random() * 100}%;
            left: ${Math.random() * 100}%;
            transform: translate(-50%, -50%);
          `;
          div.appendChild(spot);
        }

        this.container.appendChild(div);
      },

      'journal-symbols'() {
        const symbols = ['∞', '◊', '◆', '✦', '※', '◈', '✧', '⟡'];
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
        `;

        for (let i = 0; i < 15; i++) {
          const span = document.createElement('span');
          span.textContent = symbols[Math.floor(Math.random() * symbols.length)];
          span.style.cssText = `
            position: absolute;
            opacity: 0.03;
            font-size: ${20 + Math.random() * 40}px;
            color: black;
            top: ${Math.random() * 100}%;
            left: ${Math.random() * 100}%;
            transform: rotate(${Math.random() * 360}deg) translate(-50%, -50%);
          `;
          div.appendChild(span);
        }

        this.container.appendChild(div);
      },

      'dramatic-lines'() {
        const svg = this.createSVG('100%', '100%', '0 0 1000 1000');
        svg.style.cssText = 'position: absolute; top: 0; left: 0; opacity: 0.04;';

        for (let i = 0; i < 20; i++) {
          const angle = (i / 20) * Math.PI * 2;
          const x = 500 + Math.cos(angle) * 400;
          const y = 500 + Math.sin(angle) * 400;
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', '500');
          line.setAttribute('y1', '500');
          line.setAttribute('x2', x);
          line.setAttribute('y2', y);
          line.setAttribute('stroke', 'rgba(0, 0, 0, 0.5)');
          line.setAttribute('stroke-width', '1');
          svg.appendChild(line);
        }

        this.container.appendChild(svg);
      },

      'slash-marks'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          opacity: 0.04;
          background: repeating-linear-gradient(
            45deg,
            transparent,
            transparent 10px,
            rgba(0, 0, 0, 0.3) 10px,
            rgba(0, 0, 0, 0.3) 12px
          );
        `;
        this.container.appendChild(div);
      },

      'spotlight-vignette'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: radial-gradient(ellipse at center, transparent 0%, rgba(0, 0, 0, 0.6) 100%);
          opacity: 0.5;
        `;
        this.container.appendChild(div);
      },

      'scroll-texture'() {
        const svg = this.createSVG('100%', '100%', '0 0 200 200');
        svg.style.cssText = 'position: absolute; top: 0; left: 0; opacity: 0.04;';

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', 'parchment');

        const feTurbulence = document.createElementNS('http://www.w3.org/2000/svg', 'feTurbulence');
        feTurbulence.setAttribute('type', 'fractalNoise');
        feTurbulence.setAttribute('baseFrequency', '0.04');
        feTurbulence.setAttribute('numOctaves', '4');

        filter.appendChild(feTurbulence);
        defs.appendChild(filter);
        svg.appendChild(defs);

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', '100%');
        rect.setAttribute('height', '100%');
        rect.setAttribute('fill', 'rgba(240, 235, 220, 0.1)');
        rect.setAttribute('filter', 'url(#parchment)');
        svg.appendChild(rect);

        this.container.appendChild(svg);
      },

      'compass-rose'() {
        const svg = this.createSVG('300', '300', '0 0 100 100');
        svg.style.cssText = `
          position: absolute;
          bottom: 40px;
          right: 40px;
          opacity: 0.08;
        `;

        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '50');
        circle.setAttribute('cy', '50');
        circle.setAttribute('r', '40');
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', 'rgba(0, 0, 0, 0.5)');
        circle.setAttribute('stroke-width', '1');

        const points = [
          { dir: 'N', x: 50, y: 10 },
          { dir: 'E', x: 90, y: 50 },
          { dir: 'S', x: 50, y: 90 },
          { dir: 'W', x: 10, y: 50 }
        ];

        points.forEach(p => {
          const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('x', p.x);
          text.setAttribute('y', p.y);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('font-size', '8');
          text.setAttribute('fill', 'rgba(0, 0, 0, 0.6)');
          text.textContent = p.dir;
          svg.appendChild(text);
        });

        svg.appendChild(circle);
        this.container.appendChild(svg);
      },

      'cloud-top'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 15%;
          background: linear-gradient(
            180deg,
            rgba(255, 255, 255, 0.05) 0%,
            transparent 100%
          );
        `;
        this.container.appendChild(div);
      },

      'cloud-drift'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
        `;

        if (!document.querySelector('style[data-cloud-animation]')) {
          const style = document.createElement('style');
          style.setAttribute('data-cloud-animation', 'true');
          style.textContent = `
            @keyframes cloud-drift {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(100%); }
            }
            .cloud-shape {
              position: absolute;
              background: radial-gradient(ellipse at 30% 40%, rgba(200, 200, 200, 0.15), transparent);
              border-radius: 100px;
              will-change: transform;
            }
          `;
          document.head.appendChild(style);
        }

        for (let i = 0; i < 4; i++) {
          const cloud = document.createElement('div');
          cloud.className = 'cloud-shape';
          const size = 100 + Math.random() * 150;
          cloud.style.cssText = `
            width: ${size}px;
            height: ${size * 0.4}px;
            top: ${20 + Math.random() * 30}%;
            left: 0;
            animation: cloud-drift ${15 + Math.random() * 10}s linear infinite;
            animation-delay: ${i * 4}s;
          `;
          div.appendChild(cloud);
        }

        this.container.appendChild(div);
      },

      'fog-edge'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          bottom: 0;
          left: 0;
          width: 100%;
          height: 40%;
          background: linear-gradient(
            180deg,
            transparent 0%,
            rgba(100, 100, 120, 0.08) 50%,
            rgba(80, 80, 100, 0.12) 100%
          );
        `;
        this.container.appendChild(div);
      },

      'dark-fog'() {
        const div = document.createElement('div');
        div.style.cssText = `
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            180deg,
            rgba(40, 40, 60, 0.08) 0%,
            rgba(40, 40, 60, 0.12) 50%,
            rgba(40, 40, 60, 0.1) 100%
          );
        `;
        this.container.appendChild(div);
      },

      'dna-helix'() {
        const svg = this.createSVG('100%', '100%', '0 0 400 800');
        svg.style.cssText = 'position: absolute; top: 0; left: 0; opacity: 0.06;';

        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('id', 'helix1');
        path1.setAttribute('d', 'M 100,0 Q 150,25 100,50 Q 50,75 100,100 Q 150,125 100,150 Q 50,175 100,200 Q 150,225 100,250 Q 50,275 100,300 Q 150,325 100,350 Q 50,375 100,400 Q 150,425 100,450 Q 50,475 100,500 Q 150,525 100,550 Q 50,575 100,600 Q 150,625 100,650 Q 50,675 100,700 Q 150,725 100,750 Q 50,775 100,800');
        path1.setAttribute('stroke', 'rgba(100, 200, 100, 0.6)');
        path1.setAttribute('stroke-width', '2');
        path1.setAttribute('fill', 'none');

        const path2 = path1.cloneNode();
        path2.setAttribute('id', 'helix2');
        path2.setAttribute('d', 'M 300,0 Q 250,25 300,50 Q 350,75 300,100 Q 250,125 300,150 Q 350,175 300,200 Q 250,225 300,250 Q 350,275 300,300 Q 250,325 300,350 Q 350,375 300,400 Q 250,425 300,450 Q 350,475 300,500 Q 250,525 300,550 Q 350,575 300,600 Q 250,625 300,650 Q 350,675 300,700 Q 250,725 300,750 Q 350,775 300,800');

        defs.appendChild(path1);
        defs.appendChild(path2);
        svg.appendChild(defs);

        const use1 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use1.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#helix1');
        svg.appendChild(use1);

        const use2 = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use2.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#helix2');
        svg.appendChild(use2);

        this.container.appendChild(svg);
      },

      // CANVAS-BASED PARTICLE OVERLAYS

      'bubbles'(container, config) {
        const color = config.color || 'rgba(100, 200, 255, 0.4)';
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const particleCount = Math.floor(40 * density);
        for (let i = 0; i < particleCount; i++) {
          this.addParticle(
            Math.random() * this.canvas.width,
            Math.random() * this.canvas.height,
            (Math.random() - 0.5) * 0.5 * speed,
            -Math.random() * 1.5 * speed,
            Math.random() * 8 + 4,
            color,
            0.6,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => this.renderParticles());
      },

      'star-twinkle'(container, config) {
        const color = config.color || 'rgba(255, 255, 200, 0.8)';
        const density = config.density || 0.5;

        const starCount = Math.floor(60 * density);
        for (let i = 0; i < starCount; i++) {
          this.addParticle(
            Math.random() * this.canvas.width,
            Math.random() * this.canvas.height,
            0,
            0,
            Math.random() * 2 + 1,
            color,
            Math.random() * 0.5 + 0.3,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.particles.forEach(p => {
            p.opacity = Math.abs(Math.sin((Date.now() + p.x + p.y) / 500)) * 0.7 + 0.2;
          });
          this.renderParticles();
        });
      },

      'star-field'(container, config) {
        const color = config.color || 'rgba(255, 255, 255, 0.9)';
        const density = config.density || 0.5;
        const speed = config.speed || 0.3;

        // Galaxy Drift: two depth layers (far = smaller/dimmer/slower
        // twinkle, near = bigger/brighter/faster) drawn directly rather
        // than through the shared particle pool, since twinkle needs a
        // per-star opacity-over-time term the pool's generic
        // updateParticles()/renderParticles() has no concept of. Each
        // star's phase is randomized so the field never pulses in unison.
        const farStars = [];
        const farCount = Math.floor(60 * density);
        for (let i = 0; i < farCount; i++) {
          farStars.push({ x: Math.random() * this.canvas.width, y: Math.random() * this.canvas.height, r: Math.random() * 0.9 + 0.4, phase: Math.random() * Math.PI * 2 });
        }
        const nearStars = [];
        const nearCount = Math.floor(22 * density);
        for (let i = 0; i < nearCount; i++) {
          nearStars.push({ x: Math.random() * this.canvas.width, y: Math.random() * this.canvas.height, r: Math.random() * 1.4 + 1.2, phase: Math.random() * Math.PI * 2 });
        }
        // Two hand-shaded planets. Gradients are built ONCE here, never
        // rebuilt per frame — no rotation, no per-frame gradient
        // recompute, which is the one cost this design deliberately avoids.
        const planetA = { x: this.canvas.width * 0.85, y: this.canvas.height * 0.15, r: 30 };
        const planetB = { x: this.canvas.width * 0.12, y: this.canvas.height * 0.82, r: 18 };
        const gradA = this.ctx.createRadialGradient(planetA.x - planetA.r * 0.3, planetA.y - planetA.r * 0.3, 1, planetA.x, planetA.y, planetA.r);
        gradA.addColorStop(0, 'rgba(224,64,251,.55)'); gradA.addColorStop(1, 'rgba(20,5,35,.15)');
        const gradB = this.ctx.createRadialGradient(planetB.x - planetB.r * 0.3, planetB.y - planetB.r * 0.3, 1, planetB.x, planetB.y, planetB.r);
        gradB.addColorStop(0, 'rgba(206,147,216,.4)'); gradB.addColorStop(1, 'transparent');

        // Occasional shooting star — unchanged, still goes through the
        // shared particle pool, since a moving finite-life trail is
        // exactly what that pool already handles correctly.
        const shootingStarInterval = setInterval(() => {
          const sx = Math.random() * this.canvas.width;
          const sy = Math.random() * this.canvas.height * 0.5;
          for (let i = 0; i < 40; i++) {
            this.addParticle(
              sx + (i * 8),
              sy,
              speed * 3,
              0,
              1,
              color,
              0.6 * (1 - i / 40),
              1000
            );
          }
        }, 4000);

        this.canvas.style.display = 'block';
        let t = 0;
        this.animationLoop(() => {
          t += 0.05;
          this.updateParticles();
          // renderParticles() clears the canvas and draws any in-flight
          // shooting-star trail; planets + twinkling stars are drawn on
          // top of that in the same frame, not before (it would just
          // clear them again).
          this.renderParticles();
          this.ctx.fillStyle = gradA; this.ctx.beginPath(); this.ctx.arc(planetA.x, planetA.y, planetA.r, 0, Math.PI * 2); this.ctx.fill();
          this.ctx.fillStyle = gradB; this.ctx.beginPath(); this.ctx.arc(planetB.x, planetB.y, planetB.r, 0, Math.PI * 2); this.ctx.fill();
          farStars.forEach((s) => {
            this.ctx.globalAlpha = 0.35 + 0.3 * Math.sin(t + s.phase);
            this.ctx.fillStyle = color;
            this.ctx.beginPath(); this.ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); this.ctx.fill();
          });
          nearStars.forEach((s) => {
            this.ctx.globalAlpha = 0.55 + 0.45 * Math.sin(t * 1.6 + s.phase);
            this.ctx.fillStyle = color;
            this.ctx.beginPath(); this.ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); this.ctx.fill();
          });
          this.ctx.globalAlpha = 1;
        });

        // Cleanup interval on destroy
        const originalDestroy = this.destroy.bind(this);
        this.destroy = () => {
          clearInterval(shootingStarInterval);
          originalDestroy();
        };
      },

      'ember-particles'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        // Ambient field, not a one-shot burst — embers should keep rising
        // forever, so each one resets in place (via `respawn`, see
        // addParticle/updateParticles) rather than being removed on death.
        const spawnEmber = () => ({
          x: Math.random() * this.canvas.width,
          y: this.canvas.height,
          vx: (Math.random() - 0.5) * 0.8,
          vy: -Math.random() * 2 * speed,
          size: Math.random() * 6 + 3,
          opacity: 0.7,
          life: 3000,
          maxLife: 3000
        });

        const emberCount = Math.floor(35 * density);
        for (let i = 0; i < emberCount; i++) {
          const p = spawnEmber();
          this.addParticle(p.x, p.y, p.vx, p.vy, p.size, 'rgba(255, 140, 60, 0.6)', p.opacity, p.life, spawnEmber);
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.renderParticles();
        });
      },

      'water-flow'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const waveCount = Math.floor(30 * density);
        for (let i = 0; i < waveCount; i++) {
          this.addParticle(
            0,
            Math.random() * this.canvas.height,
            3 * speed,
            (Math.random() - 0.5) * 0.5,
            Math.random() * 20 + 15,
            'rgba(100, 180, 255, 0.3)',
            0.5,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.renderParticles();
        });
      },

      'water-current'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const currentCount = Math.floor(25 * density);
        for (let i = 0; i < currentCount; i++) {
          this.addParticle(
            Math.random() * this.canvas.width,
            0,
            (Math.random() - 0.5) * 0.8,
            2 * speed,
            Math.random() * 15 + 10,
            'rgba(100, 180, 255, 0.35)',
            0.4,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.renderParticles();
        });
      },

      'dark-particles'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        // Same shape as ember-particles (rises from the bottom, ambient
        // field) and the same bug: finite life with no respawn meant this
        // went permanently blank a few seconds after any theme using it
        // was selected.
        const spawnDark = () => ({
          x: Math.random() * this.canvas.width,
          y: this.canvas.height,
          vx: (Math.random() - 0.5) * 1,
          vy: -Math.random() * 1.5 * speed,
          size: Math.random() * 5 + 2,
          opacity: 0.6,
          life: 4000,
          maxLife: 4000
        });

        const particleCount = Math.floor(40 * density);
        for (let i = 0; i < particleCount; i++) {
          const p = spawnDark();
          this.addParticle(p.x, p.y, p.vx, p.vy, p.size, 'rgba(200, 150, 255, 0.5)', p.opacity, p.life, spawnDark);
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.renderParticles();
        });
      },

      'shadow-particles'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        // Same ambient-field shape and same bug as ember/dark-particles.
        const spawnShadow = () => ({
          x: Math.random() * this.canvas.width,
          y: this.canvas.height,
          vx: (Math.random() - 0.5) * 0.6,
          vy: -Math.random() * 1.2 * speed,
          size: Math.random() * 4 + 2,
          opacity: 0.5,
          life: 3500,
          maxLife: 3500
        });

        const shadowCount = Math.floor(35 * density);
        for (let i = 0; i < shadowCount; i++) {
          const p = spawnShadow();
          this.addParticle(p.x, p.y, p.vx, p.vy, p.size, 'rgba(30, 60, 150, 0.5)', p.opacity, p.life, spawnShadow);
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.renderParticles();
        });
      },

      'silver-cascade'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const cascadeCount = Math.floor(50 * density);
        for (let i = 0; i < cascadeCount; i++) {
          this.addParticle(
            Math.random() * this.canvas.width,
            0,
            (Math.random() - 0.5) * 0.5,
            2.5 * speed,
            Math.random() * 5 + 2,
            'rgba(220, 220, 255, 0.7)',
            0.6,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.renderParticles();
        });
      },

      'portal-swirl'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const swirCount = Math.floor(40 * density);
        const centerX = this.canvas.width * 0.1;
        const centerY = this.canvas.height * 0.1;

        for (let i = 0; i < swirCount; i++) {
          const angle = Math.random() * Math.PI * 2;
          const distance = Math.random() * 100 + 50;
          this.addParticle(
            centerX + Math.cos(angle) * distance,
            centerY + Math.sin(angle) * distance,
            Math.cos(angle + Math.PI / 2) * 1.5 * speed,
            Math.sin(angle + Math.PI / 2) * 1.5 * speed,
            Math.random() * 4 + 2,
            'rgba(100, 255, 100, 0.6)',
            0.5,
            Infinity
          );
        }

        let swirAngle = 0;
        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          swirAngle += 0.02 * speed;
          this.particles.forEach(p => {
            const angle = Math.atan2(p.y - centerY, p.x - centerX);
            const distance = Math.hypot(p.x - centerX, p.y - centerY);
            const newAngle = angle + swirAngle;
            p.x = centerX + Math.cos(newAngle) * distance;
            p.y = centerY + Math.sin(newAngle) * distance;
          });
          this.updateParticles();
          this.renderParticles();
        });
      },

      'aura-waves'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        let waveRadius = 0;
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          waveRadius += 2 * speed;
          if (waveRadius > Math.hypot(centerX, centerY)) {
            waveRadius = 0;
          }

          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

          for (let i = 0; i < 8 * density; i++) {
            const opacity = Math.max(0, 0.6 - (waveRadius / 500) * 0.6);
            const radius = waveRadius + i * 30;
            this.ctx.strokeStyle = `rgba(100, 150, 255, ${opacity})`;
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            this.ctx.stroke();
          }
        });
      },

      'matrix-rain'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;
        const chars = '01アイウエオカキクケコサシスセソタチツテト';

        const columnCount = Math.floor(20 * density);
        const columns = [];
        const colWidth = this.canvas.width / columnCount;

        for (let i = 0; i < columnCount; i++) {
          columns.push({
            x: i * colWidth,
            y: Math.random() * this.canvas.height,
            speed: 1 * speed + Math.random() * 1
          });
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

          this.ctx.fillStyle = 'rgba(0, 255, 100, 0.7)';
          this.ctx.font = 'bold 16px monospace';

          columns.forEach(col => {
            col.y += col.speed;
            if (col.y > this.canvas.height) {
              col.y = -20;
            }
            const char = chars[Math.floor(Math.random() * chars.length)];
            this.ctx.fillText(char, col.x, col.y);
          });
        });
      },

      'data-stream'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const characters = '0123456789ABCDEF';
        const streamCount = Math.floor(8 * density);
        const streams = [];

        for (let i = 0; i < streamCount; i++) {
          streams.push({
            x: (i / streamCount) * this.canvas.width,
            y: Math.random() * this.canvas.height,
            speed: speed * 2 + Math.random() * 1
          });
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
          this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

          this.ctx.fillStyle = 'rgba(200, 100, 255, 0.8)';
          this.ctx.font = '14px monospace';

          streams.forEach(stream => {
            stream.x += stream.speed;
            if (stream.x > this.canvas.width) {
              stream.x = -50;
            }

            for (let i = 0; i < 12; i++) {
              const char = characters[Math.floor(Math.random() * characters.length)];
              this.ctx.fillText(char, stream.x - i * 12, stream.y);
            }
          });
        });
      },

      'rain'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const rainCount = Math.floor(80 * density);
        for (let i = 0; i < rainCount; i++) {
          this.addParticle(
            Math.random() * this.canvas.width,
            Math.random() * this.canvas.height,
            0,
            4 * speed,
            Math.random() * 2 + 1,
            'rgba(100, 150, 255, 0.6)',
            0.7,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

          this.particles.forEach(p => {
            if (p.y > this.canvas.height) p.y = -10;
            this.ctx.strokeStyle = `rgba(100, 150, 255, ${p.opacity})`;
            this.ctx.lineWidth = p.size;
            this.ctx.beginPath();
            this.ctx.moveTo(p.x, p.y);
            this.ctx.lineTo(p.x, p.y + 30);
            this.ctx.stroke();
          });
        });
      },

      'snow'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const snowCount = Math.floor(60 * density);
        for (let i = 0; i < snowCount; i++) {
          this.addParticle(
            Math.random() * this.canvas.width,
            Math.random() * this.canvas.height,
            (Math.random() - 0.5) * 0.5,
            0.5 * speed,
            Math.random() * 5 + 2,
            'rgba(255, 255, 255, 0.8)',
            0.7,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.renderParticles();
        });
      },

      'creepy-fog'(container, config) {
        const density = config.density || 0.5;
        const speed = config.speed || 1;

        const fogCount = Math.floor(45 * density);
        for (let i = 0; i < fogCount; i++) {
          this.addParticle(
            Math.random() * this.canvas.width,
            this.canvas.height * 0.7,
            (Math.random() - 0.5) * 0.3,
            -0.3 * speed,
            Math.random() * 60 + 40,
            'rgba(80, 90, 110, 0.2)',
            0.3,
            Infinity
          );
        }

        this.canvas.style.display = 'block';
        this.animationLoop(() => {
          this.updateParticles();
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

          this.particles.forEach(p => {
            this.ctx.fillStyle = `rgba(80, 90, 110, ${p.opacity * 0.4})`;
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
            this.ctx.fill();
          });
        });
      }
    },

    // ==================== PARTICLE RENDERING ====================
    updateParticles() {
      // Real elapsed time between calls, not a hardcoded 60fps-shaped
      // constant. This callback only runs at the ~30fps the frame-skip
      // above already enforces, so `p.life -= 16` was ticking every
      // finite-life particle at roughly half the intended rate — a
      // configured `life: 3000` (3s) actually took ~6.3 real seconds to
      // expire. Capped at 100ms so resuming from a backgrounded tab
      // doesn't age everything by one huge jump on the first frame back.
      const now = performance.now();
      const delta = this._lastParticleTick != null ? Math.min(now - this._lastParticleTick, 100) : 16;
      this._lastParticleTick = now;

      // Iterate backwards so removing a dead particle mid-loop (splice)
      // never skips the particle that shifts into its place — the
      // previous forward `.forEach` was doing exactly that.
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.x += p.vx;
        p.y += p.vy;

        if (p.maxLife !== Infinity) {
          p.life -= delta;
          if (p.life <= 0) {
            if (typeof p.respawn === 'function') {
              // Ambient overlays (embers, drifting motes) reset in place
              // instead of disappearing. Previously every finite-life
              // particle was simply removed and never replaced, which is
              // why e.g. avatar-fire's ember field went permanently blank
              // a few seconds after the theme was selected.
              Object.assign(p, p.respawn());
            } else {
              this.particles.splice(i, 1);
              continue;
            }
          } else {
            p.opacity = (p.life / p.maxLife) * p.opacity;
          }
        }

        // Wrap around edges
        if (p.x < -50) p.x = this.canvas.width + 50;
        if (p.x > this.canvas.width + 50) p.x = -50;
        if (p.y < -50) p.y = this.canvas.height + 50;
        if (p.y > this.canvas.height + 50) p.y = -50;
      }
    },

    renderParticles() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      this.particles.forEach(p => {
        this.ctx.fillStyle = p.color.replace(')', `, ${p.opacity})`).replace('rgba(', 'rgba(');
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
        this.ctx.fill();
      });
    }
  };

  // Expose globally
  window.ThemeOverlays = ThemeOverlays;

})();

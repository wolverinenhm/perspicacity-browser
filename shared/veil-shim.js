/*
 * Perspicacity VEIL fingerprint-uniformity shim (PSC-FP-003 §4, runtime layer).
 *
 * Runs in the page's main world before any page script, in every frame. The host
 * (Electron preload or Android document-start script) evaluates this file and then
 * calls perspicacityVeilShim(cfg). Everything here reports ONE canonical value per
 * surface, so that every Perspicacity user looks the same; nothing is randomised.
 *
 * cfg = {
 *   platform, hardwareConcurrency, deviceMemory, maxTouchPoints, languages[],
 *   timerPrecisionMs, devicePixelRatio (or null to leave alone),
 *   uaData: { brands[], mobile, platform, platformVersion, architecture, bitness, model, fullVersion } | null,
 *   disableWebGL, blockCanvasReadback, utcTimezone
 * }
 */
function perspicacityVeilShim(cfg) {
  'use strict';
  const G = globalThis;

  // ---- native-looking patch helpers -------------------------------------
  const nativeToString = Function.prototype.toString;
  const masks = new WeakMap();
  const toStringImpl = {
    toString() {
      return masks.has(this) ? masks.get(this) : nativeToString.call(this);
    },
  }.toString;
  masks.set(toStringImpl, 'function toString() { [native code] }');
  try {
    Object.defineProperty(Function.prototype, 'toString', { value: toStringImpl, writable: true, configurable: true, enumerable: false });
  } catch (_) { /* frozen by page: continue without masking */ }

  const mask = (fn, label) => { masks.set(fn, `function ${label}() { [native code] }`); return fn; };

  function getter(obj, prop, compute) {
    if (!obj) return;
    const desc = Object.getOwnPropertyDescriptor(obj, prop);
    if (desc && !desc.configurable) return;
    const g = Object.getOwnPropertyDescriptor({ get [prop]() { return compute.call(this); } }, prop).get;
    mask(g, `get ${prop}`);
    try {
      Object.defineProperty(obj, prop, { get: g, set: undefined, enumerable: desc ? desc.enumerable : true, configurable: true });
    } catch (_) { /* ignore */ }
  }

  function method(obj, prop, makeImpl) {
    if (!obj || typeof obj[prop] !== 'function') return;
    const desc = Object.getOwnPropertyDescriptor(obj, prop);
    if (desc && !desc.configurable && !desc.writable) return;
    const orig = obj[prop];
    const impl = makeImpl(orig);
    const named = { [prop](...args) { return impl.apply(this, args); } }[prop];
    mask(named, prop);
    try {
      Object.defineProperty(obj, prop, { value: named, writable: true, enumerable: desc ? desc.enumerable : false, configurable: true });
    } catch (_) { /* ignore */ }
  }

  function remove(obj, prop) {
    try { if (obj && prop in obj) delete obj[prop]; } catch (_) { /* ignore */ }
  }

  // ---- navigator ---------------------------------------------------------
  const NavP = G.Navigator && G.Navigator.prototype;
  if (NavP) {
    const langs = Object.freeze((cfg.languages || ['en-US', 'en']).slice());
    getter(NavP, 'hardwareConcurrency', () => cfg.hardwareConcurrency);
    if ('deviceMemory' in NavP) getter(NavP, 'deviceMemory', () => cfg.deviceMemory);
    getter(NavP, 'language', () => langs[0]);
    getter(NavP, 'languages', () => langs);
    getter(NavP, 'platform', () => cfg.platform);
    getter(NavP, 'webdriver', () => false);
    getter(NavP, 'maxTouchPoints', () => cfg.maxTouchPoints);
    getter(NavP, 'doNotTrack', () => null);
    remove(NavP, 'getBattery');
    remove(NavP, 'connection');
    remove(NavP, 'bluetooth');
    remove(NavP, 'usb');
    remove(NavP, 'hid');
    remove(NavP, 'serial');
    method(NavP, 'getGamepads', () => function () { return []; });
    if (G.MediaDevices) {
      method(G.MediaDevices.prototype, 'enumerateDevices', () => function () { return Promise.resolve([]); });
    }
    if (cfg.uaData && G.NavigatorUAData) {
      const d = cfg.uaData;
      const brands = Object.freeze(d.brands.map((b) => Object.freeze({ brand: b.brand, version: b.version })));
      const UAP = G.NavigatorUAData.prototype;
      getter(UAP, 'brands', () => brands);
      getter(UAP, 'mobile', () => d.mobile);
      getter(UAP, 'platform', () => d.platform);
      method(UAP, 'getHighEntropyValues', () => function (hints) {
        const all = {
          brands, mobile: d.mobile, platform: d.platform,
          platformVersion: d.platformVersion, architecture: d.architecture, bitness: d.bitness,
          model: d.model, uaFullVersion: d.fullVersion, wow64: false, formFactors: [d.mobile ? 'Mobile' : 'Desktop'],
          fullVersionList: d.brands.map((b) => ({ brand: b.brand, version: b.fullVersion || b.version })),
        };
        const out = { brands, mobile: d.mobile, platform: d.platform };
        for (const h of Array.isArray(hints) ? hints : []) if (h in all) out[h] = all[h];
        return Promise.resolve(out);
      });
      method(UAP, 'toJSON', () => function () { return { brands, mobile: d.mobile, platform: d.platform }; });
    }
  }

  // ---- screen and window geometry (report the letterboxed viewport) -----
  const ScrP = G.Screen && G.Screen.prototype;
  if (ScrP) {
    const w = () => G.innerWidth;
    const h = () => G.innerHeight;
    getter(ScrP, 'width', w);
    getter(ScrP, 'height', h);
    getter(ScrP, 'availWidth', w);
    getter(ScrP, 'availHeight', h);
    getter(ScrP, 'availLeft', () => 0);
    getter(ScrP, 'availTop', () => 0);
    getter(ScrP, 'colorDepth', () => 24);
    getter(ScrP, 'pixelDepth', () => 24);
    if ('isExtended' in ScrP) getter(ScrP, 'isExtended', () => false);
  }
  for (const p of ['screenX', 'screenY', 'screenLeft', 'screenTop']) getter(G, p, () => 0);
  getter(G, 'outerWidth', () => G.innerWidth);
  getter(G, 'outerHeight', () => G.innerHeight);
  if (typeof cfg.devicePixelRatio === 'number') getter(G, 'devicePixelRatio', () => cfg.devicePixelRatio);

  // ---- timers: one coarse clock for everyone ----------------------------
  const step = cfg.timerPrecisionMs || 0;
  if (step > 0) {
    const clamp = (t) => Math.floor(t / step) * step;
    if (G.Performance) method(G.Performance.prototype, 'now', (orig) => function () { return clamp(orig.call(this)); });
    method(G.Date, 'now', (orig) => function () { return clamp(orig.call(this)); });
    if (G.Event) {
      const tsDesc = Object.getOwnPropertyDescriptor(G.Event.prototype, 'timeStamp');
      if (tsDesc && tsDesc.get) {
        const origGet = tsDesc.get;
        getter(G.Event.prototype, 'timeStamp', function () { return clamp(origGet.call(this)); });
      }
    }
  }

  // ---- timezone: UTC for everyone ---------------------------------------
  if (cfg.utcTimezone && G.Intl && G.Intl.DateTimeFormat) {
    const NativeDTF = G.Intl.DateTimeFormat;
    const DTF = new Proxy(NativeDTF, {
      construct(target, args, nt) {
        const opts = Object.assign({}, args[1] || {});
        if (opts.timeZone === undefined) opts.timeZone = 'UTC';
        return Reflect.construct(target, [args[0], opts], nt);
      },
      apply(target, thisArg, args) {
        const opts = Object.assign({}, args[1] || {});
        if (opts.timeZone === undefined) opts.timeZone = 'UTC';
        return Reflect.apply(target, thisArg, [args[0], opts]);
      },
    });
    try { G.Intl.DateTimeFormat = DTF; } catch (_) { /* ignore */ }

    const DP = G.Date.prototype;
    const pairs = [
      ['getFullYear', 'getUTCFullYear'], ['getMonth', 'getUTCMonth'], ['getDate', 'getUTCDate'],
      ['getDay', 'getUTCDay'], ['getHours', 'getUTCHours'], ['getMinutes', 'getUTCMinutes'],
      ['getSeconds', 'getUTCSeconds'], ['getMilliseconds', 'getUTCMilliseconds'],
      ['setFullYear', 'setUTCFullYear'], ['setMonth', 'setUTCMonth'], ['setDate', 'setUTCDate'],
      ['setHours', 'setUTCHours'], ['setMinutes', 'setUTCMinutes'], ['setSeconds', 'setUTCSeconds'],
      ['setMilliseconds', 'setUTCMilliseconds'],
    ];
    for (const [local, utc] of pairs) {
      const u = DP[utc];
      method(DP, local, () => function (...a) { return u.apply(this, a); });
    }
    method(DP, 'getTimezoneOffset', () => function () { return 0; });
    const utcString = DP.toUTCString;
    const fmt = (d, kind) => {
      if (isNaN(d.getTime())) return 'Invalid Date';
      const s = utcString.call(d); // "Tue, 01 Jan 2030 00:00:00 GMT"
      const m = /^(\w+), (\d+) (\w+) (-?\d+) ([\d:]+) GMT$/.exec(s);
      if (!m) return s;
      const date = `${m[1]} ${m[3]} ${m[2]} ${m[4]}`;
      const time = `${m[5]} GMT+0000 (Coordinated Universal Time)`;
      return kind === 'date' ? date : kind === 'time' ? time : `${date} ${time}`;
    };
    method(DP, 'toString', () => function () { return fmt(this, 'full'); });
    method(DP, 'toDateString', () => function () { return fmt(this, 'date'); });
    method(DP, 'toTimeString', () => function () { return fmt(this, 'time'); });
    for (const p of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      method(DP, p, (orig) => function (loc, opts) {
        const o = Object.assign({}, opts || {});
        if (o.timeZone === undefined) o.timeZone = 'UTC';
        return orig.call(this, loc, o);
      });
    }
    const NativeDate = G.Date;
    const DateProxy = new Proxy(NativeDate, {
      construct(target, args, nt) {
        if (args.length >= 2) return Reflect.construct(target, [NativeDate.UTC(...args)], nt);
        return Reflect.construct(target, args, nt);
      },
      apply(target) { return fmt(new NativeDate(), 'full'); },
    });
    try { G.Date = DateProxy; } catch (_) { /* ignore */ }
  }

  // ---- canvas readback: uniform blank output ----------------------------
  if (cfg.blockCanvasReadback) {
    const CanvasP = G.HTMLCanvasElement && G.HTMLCanvasElement.prototype;
    const blankFor = (c) => {
      const b = G.document.createElement('canvas');
      b.width = c.width; b.height = c.height;
      return b;
    };
    if (CanvasP) {
      const nativeToDataURL = CanvasP.toDataURL;
      const nativeToBlob = CanvasP.toBlob;
      method(CanvasP, 'toDataURL', () => function (...a) { return nativeToDataURL.apply(blankFor(this), a); });
      method(CanvasP, 'toBlob', () => function (...a) { return nativeToBlob.apply(blankFor(this), a); });
    }
    const zero = (orig) => function (sx, sy, sw, sh) {
      const w = Math.max(1, Math.abs(sw | 0));
      const h = Math.max(1, Math.abs(sh | 0));
      return new G.ImageData(w, h);
    };
    if (G.CanvasRenderingContext2D) method(G.CanvasRenderingContext2D.prototype, 'getImageData', zero);
    if (G.OffscreenCanvasRenderingContext2D) method(G.OffscreenCanvasRenderingContext2D.prototype, 'getImageData', zero);
    if (G.OffscreenCanvas) {
      method(G.OffscreenCanvas.prototype, 'convertToBlob', (orig) => function (...a) {
        return orig.apply(new G.OffscreenCanvas(this.width, this.height), a);
      });
    }
  }

  // ---- WebGL --------------------------------------------------------------
  if (cfg.disableWebGL) {
    const block = (orig) => function (type, ...rest) {
      if (typeof type === 'string' && /webgl|webgpu/i.test(type)) return null;
      return orig.call(this, type, ...rest);
    };
    if (G.HTMLCanvasElement) method(G.HTMLCanvasElement.prototype, 'getContext', block);
    if (G.OffscreenCanvas) method(G.OffscreenCanvas.prototype, 'getContext', block);
    remove(G, 'WebGLRenderingContext');
    remove(G, 'WebGL2RenderingContext');
    if (NavP) remove(NavP, 'gpu');
  }

  // ---- WebRTC, speech voices, misc high-entropy APIs ---------------------
  for (const p of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCRtpReceiver', 'RTCRtpSender']) remove(G, p);
  if (G.speechSynthesis && G.SpeechSynthesis) {
    method(G.SpeechSynthesis.prototype, 'getVoices', () => function () { return []; });
  }
  if (G.StorageManager) {
    method(G.StorageManager.prototype, 'estimate', () => function () {
      return Promise.resolve({ quota: 2147483648, usage: 0 });
    });
  }
}

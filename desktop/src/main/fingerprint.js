'use strict';
// The canonical VEIL fingerprint (PSC-FP-003 §3): one value per surface for every user of
// a given build, whatever machine it runs on. Values follow the most common desktop
// configuration so that Perspicacity blends in with ordinary Chrome-on-Windows traffic.

const fs = require('fs');

function chromeMajor() {
  return String(process.versions.chrome || '140').split('.')[0];
}

function canonicalProfile() {
  const major = chromeMajor();
  const brands = [
    { brand: 'Chromium', version: major, fullVersion: `${major}.0.0.0` },
    { brand: 'Not.A/Brand', version: '99', fullVersion: '99.0.0.0' },
  ];
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: 'en-US,en;q=0.9',
    timezone: 'Etc/UTC',
    locale: 'en-US',
    shim: {
      platform: 'Win32',
      hardwareConcurrency: 4,
      deviceMemory: 8,
      maxTouchPoints: 0,
      languages: ['en-US', 'en'],
      timerPrecisionMs: 100,
      devicePixelRatio: 1,
      disableWebGL: true,
      blockCanvasReadback: true,
      utcTimezone: true,
      uaData: {
        brands, mobile: false, platform: 'Windows', platformVersion: '10.0.0',
        architecture: 'x86', bitness: '64', model: '', fullVersion: `${major}.0.0.0`,
      },
    },
    cdpMetadata: {
      brands: brands.map(({ brand, version }) => ({ brand, version })),
      fullVersionList: brands.map(({ brand, fullVersion }) => ({ brand, version: fullVersion })),
      fullVersion: `${major}.0.0.0`,
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  };
}

let cachedShim = null;
/** Source code injected into every VEIL frame: the shared shim plus its invocation. */
function shimSource(shimPath, cfg) {
  if (!cachedShim) cachedShim = fs.readFileSync(shimPath, 'utf8');
  return `${cachedShim}\nperspicacityVeilShim(${JSON.stringify(cfg)});`;
}

// Client-hint headers that carry more than the three low-entropy values.
const HIGH_ENTROPY_HINT_HEADERS = [
  'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
  'sec-ch-ua-model', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64', 'sec-ch-ua-form-factors',
  'sec-ch-device-memory', 'device-memory', 'sec-ch-dpr', 'dpr', 'sec-ch-viewport-width', 'viewport-width',
  'sec-ch-width', 'width', 'sec-ch-prefers-color-scheme', 'sec-ch-prefers-reduced-motion', 'rtt', 'downlink', 'ect',
];

module.exports = { canonicalProfile, shimSource, HIGH_ENTROPY_HINT_HEADERS };

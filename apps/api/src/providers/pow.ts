import crypto from 'node:crypto';

const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js';

const CORES = [8, 16, 24, 32];
const DOCUMENT_KEYS = ['__reactContainer$fzelfjyxej8', '_reactListening5dehydibo78', 'location'];
const SCREEN_RESOLUTIONS: Array<[number, number]> = [
  [1920, 1080],
  [1440, 900],
  [2560, 1440],
  [3840, 2160],
];

function newUuid() {
  return crypto.randomUUID();
}

function legacyParseTime() {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  };
  return now.toLocaleString('en-US', options) + ' GMT-0500 (Eastern Standard Time)';
}

export function buildPowConfig(userAgent: string, scriptSources: string[] | null = null, dataBuild = '') {
  const navigatorKeys = [
    'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
    'storage−[object StorageManager]',
    'locks−[object LockManager]',
    'appCodeName−Mozilla',
    'permissions−[object Permissions]',
    'share−function share() { [native code] }',
    'webdriver−false',
    'managed−[object NavigatorManagedData]',
    'canShare−function canShare() { [native code] }',
    'vendor−Google Inc.',
    'mediaDevices−[object MediaDevices]',
    'vibrate−function vibrate() { [native code] }',
    'storageBuckets−[object StorageBucketManager]',
    'mediaCapabilities−[object MediaCapabilities]',
    'cookieEnabled−true',
    'virtualKeyboard−[object VirtualKeyboard]',
    'product−Gecko',
    'presentation−[object Presentation]',
    'onLine−true',
    'mimeTypes−[object MimeTypeArray]',
    'credentials−[object CredentialsContainer]',
    'serviceWorker−[object ServiceWorkerContainer]',
    'keyboard−[object Keyboard]',
    'gpu−[object GPU]',
    'doNotTrack',
    'serial−[object Serial]',
    'pdfViewerEnabled−true',
    'language−zh-CN',
    'geolocation−[object Geolocation]',
    'userAgentData−[object NavigatorUAData]',
    'getUserMedia−function getUserMedia() { [native code] }',
    'sendBeacon−function sendBeacon() { [native code] }',
    'hardwareConcurrency−32',
    'windowControlsOverlay−[object WindowControlsOverlay]',
  ];

  const windowKeys = [
    '0', 'window', 'self', 'document', 'name', 'location', 'customElements',
    'history', 'navigation', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY',
    'visualViewport', 'screenX', 'screenY', 'outerWidth', 'outerHeight',
    'devicePixelRatio', 'screen', 'chrome', 'navigator', 'onresize',
    'performance', 'crypto', 'indexedDB', 'sessionStorage', 'localStorage',
    'scheduler', 'alert', 'atob', 'btoa', 'fetch', 'matchMedia',
    'postMessage', 'queueMicrotask', 'requestAnimationFrame', 'setInterval',
    'setTimeout', 'caches', '__NEXT_DATA__', '__BUILD_MANIFEST', '__NEXT_PRELOADREADY',
  ];

  const screenRes = SCREEN_RESOLUTIONS[Math.floor(Math.random() * SCREEN_RESOLUTIONS.length)];
  const screenSum = screenRes[0] + screenRes[1];
  const navigatorKey = navigatorKeys[Math.floor(Math.random() * navigatorKeys.length)];
  const docKey = DOCUMENT_KEYS[Math.floor(Math.random() * DOCUMENT_KEYS.length)];
  const winKey = windowKeys[Math.floor(Math.random() * windowKeys.length)];
  const cores = CORES[Math.floor(Math.random() * CORES.length)];
  const scriptSource = scriptSources && scriptSources.length > 0
    ? scriptSources[Math.floor(Math.random() * scriptSources.length)]
    : DEFAULT_POW_SCRIPT;

  const perfNow = performance.now();
  const timeOffset = Date.now() - perfNow;

  return [
    screenSum,
    legacyParseTime(),
    4294705152,
    1,
    userAgent,
    scriptSource,
    dataBuild,
    'en-US',
    'en-US,es-US,en,es',
    Math.random(),
    navigatorKey,
    docKey,
    winKey,
    perfNow,
    newUuid(),
    '',
    cores,
    timeOffset,
    0, 0, 0, 0, 0, 0,
    0, // 0 = edge/chrome
  ];
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function compareUint8Arrays(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < b.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function powGenerate(seed: string, difficulty: string, config: unknown[], limit = 500000) {
  const target = hexToBytes(difficulty);
  const diffLen = target.length;
  const seedBytes = Buffer.from(seed, 'utf-8');

  const static1Str = JSON.stringify(config.slice(0, 3));
  const static1 = Buffer.from(static1Str.substring(0, static1Str.length - 1) + ',');

  const static2Str = JSON.stringify(config.slice(4, 9));
  const static2 = Buffer.from(',' + static2Str.substring(1, static2Str.length - 1) + ',');

  const static3Str = JSON.stringify(config.slice(10));
  const static3 = Buffer.from(',' + static3Str.substring(1));

  for (let i = 0; i < limit; i++) {
    const part1 = Buffer.from(String(i));
    const part2 = Buffer.from(String(i >> 1));
    const finalJson = Buffer.concat([static1, part1, static2, part2, static3]);
    const encoded = finalJson.toString('base64');
    const encodedBytes = Buffer.from(encoded, 'utf-8');

    const toHash = Buffer.concat([seedBytes, encodedBytes]);
    const digest = crypto.createHash('sha3-512').update(toHash).digest();

    if (compareUint8Arrays(digest.subarray(0, diffLen), target) <= 0) {
      return { answer: encoded, solved: true };
    }
  }

  const fallback = 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + Buffer.from(JSON.stringify(seed)).toString('base64');
  return { answer: fallback, solved: false };
}

export function buildProofToken(seed: string, difficulty: string, userAgent: string, scriptSources: string[] | null = null, dataBuild = '') {
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  const { answer, solved } = powGenerate(seed, difficulty, config);
  if (!solved) {
    throw new Error(`Failed to solve proof token: difficulty=${difficulty}`);
  }
  return 'gAAAAAB' + answer;
}

export function buildLegacyRequirementsToken(userAgent: string, scriptSources: string[] | null = null, dataBuild = '') {
  const config = buildPowConfig(userAgent, scriptSources, dataBuild);
  return 'gAAAAAC' + Buffer.from(JSON.stringify(config)).toString('base64');
}

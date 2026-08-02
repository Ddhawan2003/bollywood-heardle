// Simulates the Artifact sandbox: every injected <script> is refused by CSP,
// which fires onerror. The app must flag offline rather than hanging or throwing.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'template.html'), 'utf8');
const songsStart = html.indexOf('window.BOLLYWOOD_SONGS');
const songsSrc = html.slice(songsStart, html.indexOf('</script>', songsStart));
const marker = html.indexOf('(function () {');
const appStart = html.lastIndexOf('<script>', marker) + 8;
let appSrc = html.slice(appStart, html.indexOf('</script>', appStart));
appSrc = appSrc.replace(
  'ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
  'window.__T = { resolveCatalog, resolveOne, jsonpProbe: jsonp, CATALOG };'
);

const sandbox = {
  console, setTimeout, clearTimeout, Promise, Math, Date, JSON,
  encodeURIComponent, isFinite, Error, Infinity, String, Number, Array, Object, RegExp,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
};
sandbox.window = sandbox;
sandbox.React = {
  createElement: () => ({}), Fragment: 'F',
  useState: v => [v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }),
  useMemo: f => f(), useCallback: f => f,
};
sandbox.ReactDOM = { createRoot: () => ({ render: () => {} }) };

let cleanupSeen = 0;
sandbox.document = {
  createElement: () => {
    const el = { _src: '', onerror: null, parentNode: { removeChild: () => { cleanupSeen++; } } };
    Object.defineProperty(el, 'src', {
      get() { return el._src; },
      set(v) { el._src = v; setTimeout(() => el.onerror && el.onerror(), 5); }, // CSP refusal
    });
    return el;
  },
  head: { appendChild: () => {} },
  getElementById: () => ({}),
};

const ctx = vm.createContext(sandbox);
vm.runInContext(songsSrc, ctx);
vm.runInContext(appSrc, ctx);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (x ? ' -> ' + x : ''))); };

console.log('\n--- blocked network, runtime path (one song at a time) ---');
const t1 = Date.now();
sandbox.__T.resolveOne(sandbox.__T.CATALOG[0]).then(one => {
  ok('a single resolve settles rather than hanging', true);
  ok('reports the REQUEST as failed, so demo mode is session-wide',
     one.offline === true);
  ok('no track handed back', one.track === null);
  ok('fails fast (<2s, no 12s timeout wait)', Date.now() - t1 < 2000, (Date.now() - t1) + 'ms');
  return catalogGate();
}).catch(e => {
  console.log('  FAIL  resolveOne threw instead of degrading: ' + e.message);
  process.exit(1);
});

// resolveCatalog is off the startup path now, but it is the catalog
// verification gate - it still has to degrade rather than hang.
function catalogGate() {
console.log('\n--- blocked network, verification gate (whole catalog) ---');
const t0 = Date.now();
return sandbox.__T.resolveCatalog(sandbox.__T.CATALOG, () => {}).then(res => {
  const ms = Date.now() - t0;
  ok('resolves rather than hanging', true);
  ok('flagged offline', res.offline === true);
  ok('no tracks resolved', Object.keys(res.tracks).length === 0);
  ok('fails fast (<2s, no 12s timeout wait)', ms < 2000, ms + 'ms');
  ok('injected script tags cleaned up', cleanupSeen > 0, cleanupSeen);

  // catalog must remain fully playable via the synth so the UI is explorable
  const catalog = sandbox.__T.CATALOG;
  ok('full catalog stays playable offline', catalog.length >= 18, catalog.length);
  ok('every song still has an identity offline', catalog.every((s, i) => s.uid === i));

  // every song still yields a valid Apple Music attribution link from trackId
  const links = sandbox.BOLLYWOOD_SONGS.map(s => 'https://music.apple.com/in/song/' + s.trackId);
  ok('attribution link derivable for all ' + links.length + ' offline',
     links.every(l => /\/song\/\d+$/.test(l)));

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================\n');
  process.exit(fail ? 1 : 0);
}).catch(e => {
  console.log('  FAIL  threw instead of degrading: ' + e.message);
  process.exit(1);
});
}

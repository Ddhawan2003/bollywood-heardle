// Harness: run the real app code in Node with DOM/React stubs, then exercise
// the actual JSONP resolution path against the live iTunes API.
const fs = require('fs');
const https = require('https');
const vm = require('vm');

const SP = __dirname;
const html = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'template.html'), 'utf8');

// pull the song catalog + the app IIFE straight out of the shipped file
const songsStart = html.indexOf('window.BOLLYWOOD_SONGS');
const songsEnd = html.indexOf('</script>', songsStart);
const songsSrc = html.slice(songsStart, songsEnd);

const marker = html.indexOf('(function () {');
const appStart = html.lastIndexOf('<script>', marker) + 8;
const appEnd = html.indexOf('</script>', appStart);
let appSrc = html.slice(appStart, appEnd);

// expose internals for assertions
appSrc = appSrc.replace(
  'ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
  'window.__T = { norm, scoreResult, pickBest, chunk, waveShape, label, fmt, seedFrom, songSeed,' +
  ' buildCatalog, ambiguousTitles, resolveCatalog, resolveOne, CATALOG,' +
  ' STEPS, MAX_ATTEMPTS, WAVE_BARS };'
);

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, r => {
      let b = '';
      r.on('data', d => (b += d));
      r.on('end', () => res(b));
    }).on('error', rej);
  });
}

const sandbox = {
  console,
  setTimeout, clearTimeout, Promise, Math, Date, JSON, encodeURIComponent, isFinite,
  Error, Infinity, String, Number, Array, Object, RegExp,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// Minimal React stub - we never render, we only need the module to load.
sandbox.React = {
  createElement: () => ({}), Fragment: 'F',
  useState: v => [v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }),
  useMemo: f => f(), useCallback: f => f,
};
sandbox.ReactDOM = { createRoot: () => ({ render: () => {} }) };

// JSONP shim: honour script.src exactly as the browser would, then eval the
// text/javascript response so the callback fires. This exercises the real URL
// construction and the real response parsing.
let jsonpCalls = [];
sandbox.document = {
  createElement: () => {
    const el = { _src: '', onerror: null, parentNode: null };
    Object.defineProperty(el, 'src', {
      get() { return el._src; },
      set(v) {
        el._src = v;
        jsonpCalls.push(v);
        get(v).then(body => {
          try { vm.runInContext(body, ctx); }
          catch (e) { if (el.onerror) el.onerror(); }
        }).catch(() => { if (el.onerror) el.onerror(); });
      },
    });
    return el;
  },
  head: { appendChild: () => {} },
  addEventListener: () => {}, removeEventListener: () => {},
  getElementById: () => ({}),
};

const ctx = vm.createContext(sandbox);
vm.runInContext(songsSrc, ctx);
vm.runInContext(appSrc, ctx);

const T = sandbox.__T;
const SONGS = sandbox.BOLLYWOOD_SONGS;
const CATALOG = T.CATALOG;
const uidOf = title => CATALOG.find(s => s.title === title).uid;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('\n--- catalog (' + SONGS.length + ' songs) ---');
ok('catalog is populated', SONGS.length >= 18, SONGS.length);
// movie is deliberately NOT required: an empty one marks a non-film song.
ok('every song has a title and an artist', SONGS.every(s => s.title && s.artist));
ok('every song pinned to a trackId', SONGS.every(s => typeof s.trackId === 'number'));

const nonFilm = CATALOG.filter(s => !s.isFilm);
console.log('    (' + (CATALOG.length - nonFilm.length) + ' film, ' +
            nonFilm.length + ' non-film)');

// Titles are NOT required to be unique - Hindi film music reuses them, and the
// game handles that by identity. A repeated *recording* is a harvester bug.
const ids = SONGS.map(s => s.trackId);
ok('no trackId appears twice', new Set(ids).size === ids.length,
   ids.filter((v, i) => ids.indexOf(v) !== i).join(','));
// Context, not film: non-film songs all have an empty film, so keying on it
// would make every one of them look like a duplicate of the others.
const pairs = CATALOG.map(s => s.nTitle + '|' + s.nContext);
ok('no title+context pair appears twice', new Set(pairs).size === pairs.length,
   pairs.filter((v, i) => pairs.indexOf(v) !== i).slice(0, 5).join(' / '));
ok('no song is credited to nobody', SONGS.every(s => s.artist.trim().length > 1));

console.log('\n--- identity (nothing may key off a title) ---');
ok('catalog gets a uid per song', CATALOG.length === SONGS.length &&
   CATALOG.every((s, i) => s.uid === i));
ok('uids are unique', new Set(CATALOG.map(s => s.uid)).size === CATALOG.length);
ok('normalised forms precomputed', CATALOG.every(s => s.nTitle === T.norm(s.title) &&
   s.nMovie === T.norm(s.movie)));

// Colliding titles are expected at catalog scale and must be survivable, not
// absent: each one has to resolve to songs with distinct contexts.
const ambiguous = Object.keys(T.ambiguousTitles(CATALOG));
console.log('    (' + ambiguous.length + ' titles shared' +
            (ambiguous.length ? ': ' + ambiguous.slice(0, 6).join(', ') : '') + ')');
ok('every shared title spans distinct contexts', ambiguous.every(t => {
  const ctx = CATALOG.filter(s => s.nTitle === t).map(s => s.nContext);
  return new Set(ctx).size === ctx.length;
}));

// A non-film song has no film, so the artist is what tells it apart. Without
// this the two Raabtas - Pritam's from Agent Vinod and Abdul Hannan's indie
// one - would be indistinguishable to the guess check.
ok('non-film songs fall back to the artist as context',
   nonFilm.every(s => s.context === s.artist && s.nContext === T.norm(s.artist)));
ok('film songs still use the film as context',
   CATALOG.filter(s => s.isFilm).every(s => s.context === s.movie));
ok('isFilm is set from whether there is a film',
   CATALOG.every(s => s.isFilm === !!s.movie));

// The failure this whole scheme exists to prevent: one title, two films.
const collide = T.buildCatalog([
  { title: 'Tere Bina', artist: 'A.R. Rahman', movie: 'Guru' },
  { title: 'Tere Bina', artist: 'Chitra', movie: 'Bombay' },
  { title: 'Kesariya', artist: 'Arijit Singh', movie: 'Brahmastra' },
]);
ok('same title in two films gets two uids', collide[0].uid !== collide[1].uid);
ok('duplicate title flagged as ambiguous', T.ambiguousTitles(collide)['tere bina'] === true);
ok('unique title not flagged', T.ambiguousTitles(collide)['kesariya'] === undefined);
ok('guess compare by uid says these two differ', collide[0].uid !== collide[1].uid &&
   collide[0].nTitle === collide[1].nTitle);
ok('same-title songs get different waveform seeds',
   T.songSeed(collide[0]) !== T.songSeed(collide[1]));

// Two songs called Raabta, one from a film and one not. They must stay
// distinct, and the non-film one must disappear when the flag is off.
const bothKinds = [
  { title: 'Raabta', artist: 'Arijit Singh', movie: 'Agent Vinod', trackId: 1 },
  { title: 'Raabta', artist: 'Abdul Hannan', movie: '', trackId: 2 },
];
const both = T.buildCatalog(bothKinds, true);
const filmOnly = T.buildCatalog(bothKinds, false);
ok('both kinds present when non-film is on', both.length === 2);
ok('the same title from a film and not is still ambiguous',
   T.ambiguousTitles(both)['raabta'] === true);
ok('they get different contexts', both[0].nContext !== both[1].nContext,
   both.map(s => s.nContext).join(' / '));
ok('and different waveform seeds', T.songSeed(both[0]) !== T.songSeed(both[1]));
ok('flag off drops the non-film song', filmOnly.length === 1 && filmOnly[0].isFilm);
ok('flag off leaves the film song untouched', filmOnly[0].movie === 'Agent Vinod');
ok('flag off makes the title unambiguous again',
   T.ambiguousTitles(filmOnly)['raabta'] === undefined);

console.log('\n--- rules ---');
ok('steps are 0.5,1,2,4,8,16', T.STEPS.join(',') === '0.5,1,2,4,8,16');
ok('six attempts', T.MAX_ATTEMPTS === 6);
ok('labels render', T.STEPS.map(T.label).join(' ') === '0.5s 1s 2s 4s 8s 16s', T.STEPS.map(T.label).join(' '));

console.log('\n--- normalisation (typo / diacritic safety) ---');
ok('accent-insensitive: Senorita == Señorita', T.norm('Senorita') === T.norm('Señorita'));
ok('case-insensitive', T.norm('TUM HI HO') === T.norm('tum hi ho'));
ok('punctuation-insensitive', T.norm('Kal Ho Naa Ho!') === T.norm('Kal Ho Naa Ho'));
ok('hyphen folded', T.norm('Ram-Leela') === T.norm('ram leela'));
ok('distinct songs stay distinct', T.norm('Kabira') !== T.norm('Kesariya'));

console.log('\n--- variant scoring (remix must lose to the original) ---');
const song = { title: 'Tum Hi Ho', movie: 'Aashiqui 2' };
const orig = { trackName: 'Tum Hi Ho', collectionName: 'Aashiqui 2 (Original Motion Picture Soundtrack)', previewUrl: 'x' };
const remix = { trackName: 'Tum Hi Ho (Remix)', collectionName: 'Aashiqui 2 (Original Motion Picture Soundtrack)', previewUrl: 'x' };
const noprev = { trackName: 'Tum Hi Ho', collectionName: 'Aashiqui 2 (Original Motion Picture Soundtrack)' };
ok('original beats remix', T.scoreResult(orig, song) > T.scoreResult(remix, song));
ok('preview-less result rejected', T.scoreResult(noprev, song) === -Infinity);

console.log('\n--- waveform ---');
const w = T.waveShape(T.seedFrom('Kesariya'));
ok('bar count', w.length === T.WAVE_BARS, w.length);
ok('bars within 0..1', w.every(v => v > 0 && v <= 1));
ok('deterministic per song', JSON.stringify(w) === JSON.stringify(T.waveShape(T.seedFrom('Kesariya'))));
ok('differs across songs', JSON.stringify(w) !== JSON.stringify(T.waveShape(T.seedFrom('Gerua'))));

console.log('\n--- simulated games (rules engine) ---');
function playGame(strategy) {
  let guesses = [];
  while (true) {
    const attempt = guesses.length;
    const limit = T.STEPS[Math.min(attempt, 5)];
    const move = strategy(attempt, limit);
    if (move === 'correct') { guesses.push({ type: 'correct' }); return { won: true, guesses }; }
    guesses.push({ type: move });
    if (guesses.length >= T.MAX_ATTEMPTS) return { won: false, guesses };
  }
}
const allSkip = playGame(() => 'skip');
ok('six skips loses', !allSkip.won && allSkip.guesses.length === 6, allSkip.guesses.length);
const allWrong = playGame(() => 'wrong');
ok('six wrong loses', !allWrong.won && allWrong.guesses.length === 6);
const mixed = playGame(a => (a < 3 ? (a % 2 ? 'skip' : 'wrong') : 'correct'));
ok('skip consumes an attempt and advances', mixed.won && mixed.guesses.length === 4, mixed.guesses.length);
ok('win on first guess', playGame(() => 'correct').guesses.length === 1);
const unlockAt = n => (Math.min(n, 5) + 1) / 6;
ok('unlock fraction grows monotonically', [0,1,2,3,4,5].every((n,i,a) => i===0 || unlockAt(n) > unlockAt(a[i-1])));
ok('final attempt unlocks the full 16s', T.STEPS[5] === 16 && unlockAt(5) === 1);

console.log('\n--- live iTunes resolution via JSONP ---');
T.resolveCatalog(CATALOG, () => {}).then(res => {
  const keys = Object.keys(res.tracks);
  const batches = Math.ceil(CATALOG.length / 200);
  ok('not flagged offline', res.offline === false);
  // The gate: every pinned id in the shipped catalog still resolves to a real
  // preview. A harvested id that Apple has since pulled fails right here.
  ok('all ' + CATALOG.length + ' resolved', keys.length === CATALOG.length,
     keys.length + ' of ' + CATALOG.length + ' — missing: ' +
     CATALOG.filter(s => !res.tracks[s.uid]).map(s => s.title).slice(0, 8).join(', '));
  // The bug this guards: keying the preview cache by title. Every key must be a
  // uid, so the lookups in the app (tracks[song.uid]) actually hit.
  ok('cache keyed by uid, not title',
     keys.every(k => CATALOG.some(s => String(s.uid) === k)), keys.slice(0, 3).join(','));
  ok('every catalog song has a cache entry',
     CATALOG.every(s => res.tracks[s.uid]));
  ok('resolved in ' + batches + ' batched lookup request(s), 200 ids each',
     jsonpCalls.length === batches, jsonpCalls.length + ' calls');
  ok('callback param appended (JSONP)', jsonpCalls[0].includes('callback=__itunes_cb_'));

  const missingPrev = keys.filter(k => !res.tracks[k].previewUrl);
  ok('every track has a previewUrl', missingPrev.length === 0, missingPrev.join(','));
  const missingView = keys.filter(k => !res.tracks[k].trackViewUrl);
  ok('every track has trackViewUrl (Apple attribution)', missingView.length === 0, missingView.join(','));
  const missingArt = keys.filter(k => !res.tracks[k].artwork);
  ok('every track has artwork', missingArt.length === 0, missingArt.join(','));
  ok('artwork upgraded to 600x600', res.tracks[uidOf('Kesariya')].artwork.includes('600x600'));
  ok('previews are m4a', keys.every(k => res.tracks[k].previewUrl.includes('.m4a')));

  const bad = keys.filter(k => /remix|unplugged|karaoke|cover/i.test(res.tracks[k].itunesTitle));
  ok('no remix/cover slipped into the catalog', bad.length === 0,
     bad.map(k => res.tracks[k].itunesTitle).join(','));

  console.log('\n  resolved sample:');
  ['Tum Hi Ho', 'Senorita', 'Nagada Sang Dhol'].forEach(n => {
    const t = res.tracks[uidOf(n)];
    console.log('    ' + n + ' -> ' + t.itunesTitle + ' | ' + t.itunesAlbum);
  });

  return liveSingles();
}).catch(e => {
  console.log('  FAIL  resolveCatalog threw: ' + e.message);
  process.exit(1);
});

// resolveOne is what the running game actually calls - one song, one request,
// at the moment a round needs it. Both of its branches get exercised live.
function liveSingles() {
  console.log('\n--- live single-song resolution (the runtime path) ---');
  const before = jsonpCalls.length;
  const pinned = CATALOG[uidOf('Kesariya')];
  const loose = T.buildCatalog([{ title: 'Kesariya', artist: 'Arijit Singh', movie: 'Brahmastra' }])[0];

  return T.resolveOne(pinned).then(res => {
    ok('pinned song resolves', !!res.track && !res.offline);
    ok('costs exactly one request', jsonpCalls.length === before + 1, jsonpCalls.length - before);
    ok('resolves via /lookup, not a search', jsonpCalls[before].includes('/lookup?id='));
    ok('returns the pinned recording', res.track.itunesTitle === 'Kesariya', res.track.itunesTitle);
    ok('with a playable preview', res.track.previewUrl.includes('.m4a'));
    ok('and Apple attribution', !!res.track.trackViewUrl);
    return T.resolveOne(loose);
  }).then(res => {
    ok('song with no trackId falls back to a scored search', !!res.track && !res.offline);
    ok('fallback picked the original, not a variant',
       !/remix|unplugged|karaoke|cover|lo-fi/i.test(res.track.itunesTitle), res.track.itunesTitle);
    console.log('    no trackId -> ' + res.track.itunesTitle + ' | ' + res.track.itunesAlbum);

    console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================\n');
    process.exit(fail ? 1 : 0);
  }).catch(e => {
    console.log('  FAIL  resolveOne threw: ' + e.message);
    process.exit(1);
  });
}

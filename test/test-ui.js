// Drives the real App component through whole rounds, with a hand-rolled React
// that keeps hook state and re-renders synchronously, and a JSONP responder
// that answers exactly as Apple would. Two scenarios:
//
//   BLOCKED  every injected script is refused, as under the Artifact CSP.
//            Covers song identity (naming a DIFFERENT film's song of the same
//            name must be wrong) and the transport (a new round must never
//            open showing STOP for audio that is not playing).
//
//   ONLINE   lookups answer for real, one song deliberately preview-less.
//            Covers the lazy path: nothing is fetched before the player acts
//            beyond a single prefetch, the transport waits for its audio, and
//            a dud song is dropped and re-dealt rather than stranding a round.
//
// Math.random is pinned to 0 throughout, so every pick is the first candidate
// and the fixtures decide what happens rather than luck.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'template.html'), 'utf8');
const marker = html.indexOf('(function () {');
const appStart = html.lastIndexOf('<script>', marker) + 8;
const APP_SRC = html.slice(appStart, html.indexOf('</script>', appStart)).replace(
  'ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
  'window.__T = { App: App, CATALOG: CATALOG };'
);

/* ================================================================== */
/* Harness                                                             */
/* ================================================================== */

// Stands in for the <audio> element the app mounts once and reuses. readyState
// 2 means whenPlayable() resolves at once, so play() reaches the frame loop -
// which never ticks here, leaving a started snippet "playing" indefinitely.
// That is precisely the state the transport bug needed.
function fakeAudio() {
  return {
    src: '', currentTime: 0, duration: 30, readyState: 2, playing: false,
    load() {}, pause() { this.playing = false; },
    play() { this.playing = true; return Promise.resolve(); },
    addEventListener() {}, removeEventListener() {},
  };
}

// respond(url) -> a JSONP payload, or null to refuse the script (CSP / offline)
function createHarness(fixture, respond) {
  let slots = [], cursor = 0, pendingEffects = [], dirty = false, tree = null;
  let audioEl = null;
  const urls = [];

  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const React = {
    Fragment: 'FRAGMENT',
    createElement(type, props, ...kids) {
      props = props || {};
      const children = kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false);
      if (props.ref && typeof props.ref === 'object') {
        // Only the <audio> element's ref is ever dereferenced by the app; the
        // typeahead's wrapper ref is read solely from a document listener that
        // never fires here.
        props.ref.current = type === 'audio'
          ? (audioEl || (audioEl = fakeAudio()))
          : { contains: () => false };
      }
      // Components are expanded eagerly and take the next hook slots. Every
      // component here calls its hooks unconditionally, which is the same rule
      // real React enforces, so the ordering stays stable across renders.
      if (typeof type === 'function') return type(Object.assign({}, props, { children }));
      return { type, props, kids: children };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { v: typeof init === 'function' ? init() : init };
      const slot = slots[i];
      return [slot.v, next => {
        slot.v = typeof next === 'function' ? next(slot.v) : next;
        dirty = true;
      }];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i];
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { deps, v: fn() };
      return slots[i].v;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) { slots[i] = { deps }; pendingEffects.push(fn); }
    },
  };

  function FakeAudioContext() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.resume = () => {};
    this.createOscillator = () => ({
      frequency: {}, type: '', connect() {}, start() {}, stop() {}, disconnect() {},
    });
    this.createGain = () => ({
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}, disconnect() {},
    });
  }

  const fixedMath = Object.create(Math);
  fixedMath.random = () => 0;

  const sandbox = {
    console, setTimeout, clearTimeout, Promise, Math: fixedMath, Date, JSON,
    encodeURIComponent, isFinite, Error, Infinity, String, Number, Array, Object, RegExp,
    // No frames ever fire, so playback that starts stays started.
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    AudioContext: FakeAudioContext,
    React, ReactDOM: { createRoot: () => ({ render: () => {} }) },
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);

  sandbox.document = {
    createElement: () => {
      const el = { _src: '', onerror: null, parentNode: { removeChild() {} } };
      Object.defineProperty(el, 'src', {
        get() { return el._src; },
        set(v) {
          el._src = v;
          urls.push(v);
          const data = respond(v);
          setTimeout(() => {
            if (data === null) return el.onerror && el.onerror();
            // Evaluated in the VM exactly as a text/javascript response would be.
            const cb = /callback=([^&]+)/.exec(v)[1];
            vm.runInContext(cb + '(' + JSON.stringify(data) + ');', ctx);
          }, 1);
        },
      });
      return el;
    },
    head: { appendChild() {} },
    addEventListener() {}, removeEventListener() {},
    getElementById: () => ({}),
  };

  vm.runInContext('window.BOLLYWOOD_SONGS = ' + JSON.stringify(fixture) + ';', ctx);
  vm.runInContext(APP_SRC, ctx);

  const App = sandbox.__T.App;

  function render() {
    cursor = 0;
    pendingEffects = [];
    dirty = false;
    tree = App();
    pendingEffects.forEach(fn => fn());
  }
  function flush() {
    for (let i = 0; i < 8; i++) { if (!dirty) break; render(); }
  }

  const nodes = () => walk(tree, []);
  const find = pred => nodes().find(pred);

  return {
    App,
    CATALOG: sandbox.__T.CATALOG,
    urls,
    audio: () => audioEl,
    render, flush, nodes, find,
    byText: t => find(n => n.type === 'button' && textOf(n).includes(t)),
    byClass: c => find(n => typeof n.props.className === 'string' &&
                            n.props.className.split(' ').includes(c)),
    byLabel: l => find(n => n.props['aria-label'] === l),
    options: () => nodes().filter(n => n.type === 'li' && n.props.role === 'option'),
    click(node, name) {
      if (!node) throw new Error('nothing to click: ' + name);
      if (node.props.disabled) throw new Error('clicked a disabled control: ' + name);
      node.props.onClick();
      flush();
    },
    type(value) {
      find(n => n.type === 'input').props.onChange({ target: { value } });
      flush();
    },
    pickOption(match) {
      const row = this.options().find(o => textOf(o).includes(match));
      if (!row) throw new Error('no option matching ' + match);
      row.props.onMouseDown({ preventDefault() {} });
      flush();
    },
  };
}

/* ---- tree helpers ---- */
function walk(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out; }
  out.push(node);
  (node.kids || []).forEach(n => walk(n, out));
  return out;
}
function textOf(node) {
  return walk(node, []).flatMap(n => (n.kids || []).filter(k => typeof k === 'string')).join('');
}
// The transport swaps a <path> (play) for a <rect> (stop), so the icon itself
// is what gets asserted - not just the label beside it.
const iconOf = btn => (walk(btn, []).some(n => n.type === 'rect') ? 'stop' : 'play');

const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (x ? '  -> ' + x : ''))); };

/* ================================================================== */
/* Scenario 1 - every request blocked                                  */
/* ================================================================== */

const COLLIDING = [
  { title: 'Tere Bina', artist: 'A.R. Rahman', movie: 'Guru' },
  { title: 'Tere Bina', artist: 'Chitra', movie: 'Bombay' },
  { title: 'Kesariya', artist: 'Arijit Singh', movie: 'Brahmastra' },
];

async function blockedScenario() {
  const ui = createHarness(COLLIDING, () => null);
  ui.render();

  console.log('\n--- blocked: the page is usable before anything resolves ---');
  ok('start screen renders immediately, with no loading gate', !!ui.byText('Endless / Random'));
  ok('catalog size shown from the baked list',
     textOf(ui.byClass('start')).includes('3 songs in the catalog'));

  await wait(30);
  ui.flush();
  ok('demo badge appears once the prefetch is refused', !!ui.byClass('demochip'));
  ok('demo notice explains the sandbox', !!ui.byClass('notice'));

  console.log('\n--- identity: a guess is judged by song, not by title ---');
  ui.click(ui.byText('Endless / Random'), 'start');
  await wait(10);
  ui.flush();
  const answer = ui.CATALOG[0];                    // Math.random pinned to 0
  ok('round is under way', !!ui.byClass('transport'));

  // Both fixture songs are called "Tere Bina". Typing it must NOT be
  // submittable on its own - the player has to say which film.
  ui.type('Tere Bina');
  ok('ambiguous title alone cannot be submitted', ui.byText('Submit guess').props.disabled === true);
  ok('both films offered as separate rows', ui.options().length === 2, ui.options().length);

  ui.pickOption('Bombay');                          // the wrong film's Tere Bina
  ok('picking a row makes it submittable', ui.byText('Submit guess').props.disabled === false);
  ui.click(ui.byText('Submit guess'), 'submit wrong');

  const rows = ui.nodes().filter(n => typeof n.props.className === 'string' &&
                                      n.props.className.startsWith('row row-'));
  ok('same title, different film scores WRONG',
     !!rows.find(r => r.props.className.includes('row-wrong')),
     rows.map(r => r.props.className).join(' | '));
  ok('still in the round, not on the reveal', !!ui.byClass('transport'));
  ok('the wrong guess row names the film that was guessed',
     rows.some(r => textOf(r).includes('Bombay')));

  ui.type('Tere Bina');
  ui.pickOption(answer.movie);
  ui.click(ui.byText('Submit guess'), 'submit right');
  ok('the matching song scores CORRECT',
     !!ui.byClass('verdict') && textOf(ui.byClass('verdict')).includes('Correct'));
  ok('reveal names the right film', textOf(ui.byClass('card')).includes(answer.movie));

  console.log('\n--- blocked: a new round never opens mid-"playing" ---');
  ui.click(ui.byLabel('Play the full preview'), 'mini play');
  await wait(5);
  ui.flush();
  ok('preview is playing (stop icon shown)', iconOf(ui.byClass('mini-play')) === 'stop');
  ok('label switched to Stop', ui.byClass('mini-play').props['aria-label'] === 'Stop');

  ui.click(ui.byText('Next song'), 'next song');    // leave while it is still running
  ok('new round shows the PLAY icon, not STOP', iconOf(ui.byClass('play')) === 'play',
     ui.byClass('play').props['aria-label']);
  ok('playhead reset', !ui.byClass('wave-head'));

  await wait(10);
  ui.flush();
  const transport = ui.byClass('play');
  ok('transport enabled once the round has audio', transport.props.disabled === false);
  ok('label invites a play', /^Play /.test(transport.props['aria-label']),
     transport.props['aria-label']);
  ok('idle breathing animation restored', transport.props.className.includes('is-idle'));

  ui.click(transport, 'play new round');
  await wait(5);
  ui.flush();
  ok('clicking it starts playback', iconOf(ui.byClass('play')) === 'stop');
  ui.click(ui.byClass('play'), 'stop');
  ok('clicking again stops it', iconOf(ui.byClass('play')) === 'play');

  ok('still no network was reached', ui.urls.every(u => u.includes('itunes.apple.com')));

  console.log('\n--- give up ends the round on the attempt it is pressed ---');
  // An active round always renders six placeholders, so only FILLED rows count.
  const filled = () => ui.nodes().filter(n =>
    typeof n.props.className === 'string' &&
    n.props.className.startsWith('row row-') &&
    !n.props.className.includes('row-empty'));

  ok('give up is offered from the very first attempt', !!ui.byText('Give up and show me'));
  ok('no guesses have been made yet', filled().length === 0, filled().length + ' filled');

  ui.click(ui.byText('Give up and show me'), 'give up');
  ok('the round is over immediately', !!ui.byClass('verdict'));
  ok('the song is revealed', !!ui.byClass('card'));
  // Not "out of guesses". The rows are left as they are rather than padded to
  // six, and the verdict line reads off how many there actually were.
  ok('the verdict says gave up, not out of guesses',
     textOf(ui.byClass('verdict')).includes('Gave up'), textOf(ui.byClass('verdict')));
  ok('no phantom skip rows were invented', filled().length === 0, filled().length + ' filled');
}

/* ================================================================== */
/* Scenario 2 - lookups answer, one song is a dud                      */
/* ================================================================== */

// uid 0 is deliberately first AND unplayable: with Math.random pinned to 0 it
// is what both the prefetch and the opening round reach for, so the reroll
// path is exercised rather than merely available.
const WITH_A_DUD = [
  { title: 'Silent Track', artist: 'Nobody', movie: 'Nowhere', trackId: 100 },
  { title: 'Kesariya', artist: 'Arijit Singh', movie: 'Brahmastra', trackId: 101 },
  { title: 'Gerua', artist: 'Arijit Singh', movie: 'Dilwale', trackId: 102 },
  { title: 'Ilahi', artist: 'Arijit Singh', movie: 'Yeh Jawaani Hai Deewani', trackId: 103 },
];

function appleReply(url) {
  const id = Number(/[?&]id=(\d+)/.exec(url)[1]);
  const song = WITH_A_DUD.find(s => s.trackId === id);
  // The dud resolves fine as a request - it just has no preview behind it.
  if (id === 100) return { resultCount: 1, results: [{ trackId: 100, trackName: 'Silent Track' }] };
  return {
    resultCount: 1,
    results: [{
      trackId: id,
      trackName: song.title,
      artistName: song.artist,
      collectionName: song.movie + ' (Original Motion Picture Soundtrack)',
      previewUrl: 'https://audio.example/' + id + '.m4a',
      artworkUrl100: 'https://art.example/' + id + '/100x100bb.jpg',
      trackViewUrl: 'https://music.apple.com/in/song/' + id,
    }],
  };
}

async function onlineScenario() {
  const ui = createHarness(WITH_A_DUD, appleReply);
  ui.render();

  console.log('\n--- online: nothing is fetched for songs nobody will hear ---');
  ok('start screen is immediate', !!ui.byText('Endless / Random'));

  await wait(30);
  ui.flush();
  ok('exactly one song prefetched before any click', ui.urls.length === 1, ui.urls.join(' '));
  // The old load-time sweep batched 200 ids per request; nothing may do that now.
  ok('no batched catalog sweep', ui.urls.every(u => !/id=\d+,/.test(u)), ui.urls.join(' '));
  ok('prefetch is a pinned lookup, not a search', ui.urls[0].includes('/lookup?id='), ui.urls[0]);
  ok('not in demo mode', !ui.byClass('demochip'));

  console.log('\n--- online: the transport waits for its audio ---');
  ui.click(ui.byText('Endless / Random'), 'start');
  ok('round is presented before the audio arrives', !!ui.byClass('transport'));
  ok('transport disabled while resolving', ui.byClass('play').props.disabled === true);
  ok('no breathing animation while disabled',
     !ui.byClass('play').props.className.includes('is-idle'));
  ok('guessing stays available while audio loads',
     ui.find(n => n.type === 'input').props.disabled === false);

  await wait(30);
  ui.flush();
  ok('transport enabled once audio is loaded', ui.byClass('play').props.disabled === false);

  console.log('\n--- online: a song with no preview is dropped, not dealt ---');
  ok('the dud was tried', ui.urls.some(u => u.includes('id=100')));
  ok('and re-dealt to a playable song', ui.urls.some(u => u.includes('id=101')));
  ok('the real <audio> element got the preview',
     ui.audio() && ui.audio().src === 'https://audio.example/101.m4a', ui.audio() && ui.audio().src);

  ui.click(ui.byClass('play'), 'play');
  await wait(5);
  ui.flush();
  ok('playback runs through the audio element, not the synth', ui.audio().playing === true);
  ok('transport shows stop while playing', iconOf(ui.byClass('play')) === 'stop');

  console.log('\n--- online: reveal and the next round ---');
  for (let i = 0; i < 6; i++) ui.click(ui.byText(i === 5 ? 'Give up' : 'Skip +'), 'skip ' + i);
  ok('six skips end the round', !!ui.byClass('verdict'));
  ok('the dud is never the answer', !textOf(ui.byClass('card')).includes('Silent Track'),
     textOf(ui.byClass('card')));
  ok('artwork upgraded to 600x600 on the reveal',
     !!ui.find(n => n.type === 'img' && n.props.src.includes('600x600')));
  // "Next song" has to come BEFORE the guess history in document order. It is
  // what almost everyone wants next, and on a phone anything below six rows of
  // wrong answers is off the bottom of the screen.
  const revealOrder = [];
  ui.find(n => {
    if (n.props && n.props.className === 'btn btn-primary btn-next') revealOrder.push('next');
    if (n.props && n.props.className === 'rows') revealOrder.push('rows');
    return false;
  });
  ok('next song sits above the guess history', revealOrder.join(',') === 'next,rows',
     revealOrder.join(',') || 'neither found');

  // Song 102 was prefetched while the previous round was being guessed, so the
  // new round must reuse that result rather than asking for it again - and it
  // costs exactly one further request: the prefetch of the round after this one.
  ok('the following song was prefetched during the last round',
     ui.urls.some(u => u.includes('id=102')));
  const before = ui.urls.length;
  ui.click(ui.byText('Next song'), 'next song');
  await wait(30);
  ui.flush();
  ok('next round is playable', ui.byClass('play').props.disabled === false);
  ok('it plays the prefetched song',
     ui.audio().src === 'https://audio.example/102.m4a', ui.audio().src);
  ok('with no second lookup for it',
     ui.urls.filter(u => u.includes('id=102')).length === 1,
     ui.urls.filter(u => u.includes('id=102')).length + ' lookups');
  ok('one further request, and it is the next prefetch',
     ui.urls.length === before + 1 && ui.urls[ui.urls.length - 1].includes('id=103'),
     before + ' -> ' + ui.urls.length + ' | ' + ui.urls[ui.urls.length - 1]);
}

(async function main() {
  await blockedScenario();
  await onlineScenario();
  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================\n');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('  FAIL  threw: ' + ((e && e.stack) || e));
  process.exit(1);
});

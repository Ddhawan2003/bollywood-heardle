// Drives the real App component through a round, with a hand-rolled React that
// keeps hook state and re-renders synchronously. The two things it exists to
// prove cannot be checked from the pure helpers:
//
//   1. a guess is judged by song identity, not by title - so naming a DIFFERENT
//      film's song of the same name is wrong, not a win;
//   2. starting a new round while the previous preview is still playing leaves
//      the transport showing PLAY, not STOP.
//
// The catalog is replaced with a 3-song fixture containing a deliberate title
// collision, and Math.random is pinned so the answer is always the first song.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'template.html'), 'utf8');
const marker = html.indexOf('(function () {');
const appStart = html.lastIndexOf('<script>', marker) + 8;
let appSrc = html.slice(appStart, html.indexOf('</script>', appStart));
appSrc = appSrc.replace(
  'ReactDOM.createRoot(document.getElementById("root")).render(h(App));',
  'window.__T = { App: App, CATALOG: CATALOG };'
);

const FIXTURE = [
  { title: 'Tere Bina', artist: 'A.R. Rahman', movie: 'Guru' },
  { title: 'Tere Bina', artist: 'Chitra', movie: 'Bombay' },
  { title: 'Kesariya', artist: 'Arijit Singh', movie: 'Brahmastra' },
];

/* ---------------------------------------------------------------- */
/* A very small React: one flat hook slot list, synchronous renders.  */
/* Hook order is stable because every component here calls its hooks  */
/* unconditionally, which is the same rule real React enforces.       */
/* ---------------------------------------------------------------- */
let slots = [], cursor = 0, pending = [], dirty = false, tree = null;

const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

const React = {
  Fragment: 'FRAGMENT',
  createElement(type, props, ...kids) {
    props = props || {};
    const children = kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false);
    // Components are expanded eagerly; their hooks simply take the next slots.
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
    if (!slots[i] || !sameDeps(slots[i].deps, deps)) { slots[i] = { deps }; pending.push(fn); }
  },
};

/* ---------------------------------------------------------------- */
/* Sandbox                                                           */
/* ---------------------------------------------------------------- */
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
fixedMath.random = () => 0;          // the answer is always pool[0]

const sandbox = {
  console, setTimeout, clearTimeout, Promise, Math: fixedMath, Date, JSON,
  encodeURIComponent, isFinite, Error, Infinity, String, Number, Array, Object, RegExp,
  // No frames ever fire, so a started snippet stays "playing" - which is
  // exactly the state the second bug needs.
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  AudioContext: FakeAudioContext,
  React, ReactDOM: { createRoot: () => ({ render: () => {} }) },
};
sandbox.window = sandbox;
sandbox.document = {
  createElement: () => {
    const el = { _src: '', onerror: null, parentNode: { removeChild: () => {} } };
    Object.defineProperty(el, 'src', {
      get() { return el._src; },
      set(v) { el._src = v; setTimeout(() => el.onerror && el.onerror(), 1); },  // CSP refusal
    });
    return el;
  },
  head: { appendChild: () => {} },
  addEventListener: () => {}, removeEventListener: () => {},
  getElementById: () => ({}),
};

const ctx = vm.createContext(sandbox);
vm.runInContext('window.BOLLYWOOD_SONGS = ' + JSON.stringify(FIXTURE) + ';', ctx);
vm.runInContext(appSrc, ctx);

const App = sandbox.__T.App;
const CATALOG = sandbox.__T.CATALOG;

function render() {
  cursor = 0;
  pending = [];
  dirty = false;
  tree = App();
  pending.forEach(fn => fn());
}
function flush(times) {
  for (let i = 0; i < (times || 6); i++) { if (!dirty) break; render(); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- */
/* Tree queries                                                      */
/* ---------------------------------------------------------------- */
function walk(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out; }
  out.push(node);
  (node.kids || []).forEach(n => walk(n, out));
  return out;
}
const nodes = () => walk(tree, []);
const find = pred => nodes().find(pred);
function textOf(node) {
  return walk(node, []).flatMap(n => (n.kids || []).filter(k => typeof k === 'string')).join('');
}
const byText = t => find(n => n.type === 'button' && textOf(n).includes(t));
const byClass = c => find(n => typeof n.props.className === 'string' &&
                              n.props.className.split(' ').includes(c));
const byLabel = l => find(n => n.props['aria-label'] === l);
function click(node, name) {
  if (!node || !node.props.onClick) throw new Error('nothing to click: ' + name);
  node.props.onClick();
  flush();
}
// The transport swaps a <path> (play) for a <rect> (stop), so the icon itself
// is what gets asserted - not just the label next to it.
const iconOf = btn => (walk(btn, []).some(n => n.type === 'rect') ? 'stop' : 'play');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  PASS  ' + n))
                            : (fail++, console.log('  FAIL  ' + n + (x ? '  -> ' + x : ''))); };

(async function main() {
  render();
  ok('renders the loading screen', !!byClass('loading'));

  await wait(60);
  flush();
  ok('degrades to the start screen with no network', !!byText('Endless / Random'));
  ok('demo audio flagged', !!byClass('demochip'));

  console.log('\n--- identity: a guess is judged by song, not by title ---');
  click(byText('Endless / Random'), 'start');
  const answer = CATALOG[0];                       // Math.random pinned to 0
  ok('round started on the expected song', !!byClass('transport'));

  // Both fixture songs are called "Tere Bina". Typing it must NOT be
  // submittable on its own - the player has to say which film.
  const input = find(n => n.type === 'input');
  input.props.onChange({ target: { value: 'Tere Bina' } });
  flush();
  ok('ambiguous title alone cannot be submitted', byText('Submit guess').props.disabled === true);

  // Pick the wrong film's "Tere Bina" from the list.
  const options = nodes().filter(n => n.type === 'li' && n.props.role === 'option');
  ok('both films offered as separate rows', options.length === 2, options.length);
  const wrongRow = options.find(o => textOf(o).includes('Bombay'));
  wrongRow.props.onMouseDown({ preventDefault() {} });
  flush();
  ok('picking a row makes it submittable', byText('Submit guess').props.disabled === false);
  click(byText('Submit guess'), 'submit wrong');

  const rows = nodes().filter(n => typeof n.props.className === 'string' &&
                                   n.props.className.startsWith('row row-'));
  ok('same title, different film scores WRONG',
     !!rows.find(r => r.props.className.includes('row-wrong')),
     rows.map(r => r.props.className).join(' | '));
  ok('still in the round, not on the reveal', !!byClass('transport'));
  ok('the wrong guess row names the film that was guessed',
     rows.some(r => textOf(r).includes('Bombay')));

  // Now the right one.
  const input2 = find(n => n.type === 'input');
  input2.props.onChange({ target: { value: 'Tere Bina' } });
  flush();
  const rightRow = nodes().filter(n => n.type === 'li' && n.props.role === 'option')
                          .find(o => textOf(o).includes(answer.movie));
  rightRow.props.onMouseDown({ preventDefault() {} });
  flush();
  click(byText('Submit guess'), 'submit right');
  ok('the matching song scores CORRECT', !!byClass('verdict') &&
     textOf(byClass('verdict')).includes('Correct'));
  ok('reveal names the right film', textOf(byClass('card')).includes(answer.movie));

  console.log('\n--- transport: a new round never opens mid-"playing" ---');
  const miniPlay = byLabel('Play the full preview');
  ok('reveal offers the full preview', !!miniPlay && iconOf(miniPlay) === 'play');
  click(miniPlay, 'mini play');
  await wait(5);
  flush();
  const playingBtn = byClass('mini-play');
  ok('preview is playing (stop icon shown)', iconOf(playingBtn) === 'stop');
  ok('label switched to Stop', playingBtn.props['aria-label'] === 'Stop');

  // The bug: leave the reveal while that preview is still running.
  click(byText('Next song'), 'next song');
  const transportBtn = byClass('play');
  ok('new round shows the PLAY icon, not STOP', iconOf(transportBtn) === 'play',
     transportBtn.props['aria-label']);
  ok('new round label invites a play', /^Play /.test(transportBtn.props['aria-label']),
     transportBtn.props['aria-label']);
  ok('idle breathing animation restored',
     transportBtn.props.className.includes('is-idle'), transportBtn.props.className);
  ok('playhead reset', !byClass('wave-head'));

  // And it must actually play when clicked, rather than acting as a stop.
  click(transportBtn, 'play new round');
  await wait(5);
  flush();
  ok('clicking it starts playback', iconOf(byClass('play')) === 'stop');
  ok('clicking again stops it', (click(byClass('play'), 'stop'), iconOf(byClass('play')) === 'play'));

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================\n');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('  FAIL  threw: ' + (e && e.stack || e));
  process.exit(1);
});

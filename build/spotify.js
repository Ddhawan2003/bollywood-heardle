#!/usr/bin/env node
/*
    Reads a player's Spotify data and turns it into catalog answers, so songs
    they plainly know are never put to them as questions.

        node build/spotify.js Liked_Songs.csv                  an Exportify CSV
        node build/spotify.js Streaming_History_Audio_*.json   Spotify's own
                                                               extended history
        node build/spotify.js ... --dry                        report only

    Two outputs, both committed, both read by build/harvest.js:

      build/vetting.json    "known" for every catalog or queued song matched
      build/additions.json  film songs the player listens to that no harvest
                            path reaches, resolved to an Apple trackId

    Liked songs are all treated as known. Streaming history is counted: a play
    is 30 seconds or more, and it takes KNOWN_PLAYS of them to be known and
    ADD_PLAYS to be added - one play might be an autoplay the player never
    chose. Songs with fewer plays are written to build/.vet-priority.json,
    which the vetting page puts first, because they are LIKELY known.

    A Spotify track matches a song when the titles match and either the film
    or a performer does. Title alone is not enough - Tere Bina, Zaalima and
    Humsafar each exist in several films. And none of this can mark a song
    UNknown: not having played a song says nothing about whether you know it.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'src', 'template.html');
const CACHE = path.join(__dirname, '.harvest-cache');   // shared with harvest.js
const VETTING = path.join(__dirname, 'vetting.json');
const ADDITIONS = path.join(__dirname, 'additions.json');
const QUEUE = path.join(__dirname, '.vet-queue.json');
const PRIORITY = path.join(__dirname, '.vet-priority.json');

const KNOWN_PLAYS = 3;
const ADD_PLAYS = 5;
const MIN_PLAY_MS = 30000;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const inputs = argv.filter(a => !a.startsWith('--'));
if (!inputs.length) { console.log('usage: node build/spotify.js <Liked_Songs.csv | Streaming_History_*.json ...> [--dry]'); process.exit(1); }

/* ---- text ---- */

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Spotify decorates titles the way Apple does: Bolna (From "Kapoor & Sons"),
// Raabta (Title Track) [From "Raabta"], Khairiyat - Bonus Track.
// Delimited by the QUOTES, not the brackets: Bolna (From "Kapoor & Sons (Since
// 1921)") has brackets inside the film name, and a bracket match cut it short.
const FROM = /\s*[\(\[]\s*from\s+["“](.+?)["”]\s*[\)\]]/i;
const fromFilm = t => ((FROM.exec(t || '') || [])[1] || '');
const cleanTitle = t => (t || '')
  .replace(new RegExp(FROM.source, 'ig'), '')
  .replace(/\s*[\(\[][^\)\]]*\b(feat|ft|featuring|title track)\b[^\)\]]*[\)\]]/ig, '')
  .replace(/\s+-\s+.*$/, '')
  .trim();
const filmOfAlbum = a => (a || '')
  .replace(/\s*[\(\[][^\)\]]*(soundtrack|motion picture|music from)[^\)\]]*[\)\]]/ig, '')
  .replace(/\s+-\s+.*$/, '')
  .trim();
// (From "...") also tags music videos, which look exactly like films in the
// data. Named here as they turn up.
const NOT_FILMS = new Set(['jaani ve']);
const looksLikeFilm = (title, album) =>
  !NOT_FILMS.has(norm(fromFilm(title))) &&
  (!!fromFilm(title) || /motion picture|original soundtrack|music from/i.test(album || ''));

/* ---- reading Spotify ---- */

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// One entry per distinct track: { title, album, artists[], plays, liked }.
function readInputs(files) {
  const tracks = new Map();
  const bump = (key, t) => {
    const cur = tracks.get(key) || Object.assign({ plays: 0, liked: false }, t);
    tracks.set(key, cur);
    return cur;
  };
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
    if (/\.csv$/i.test(f)) {
      const rows = parseCsv(text);
      const hdr = rows.shift();
      const at = n => hdr.indexOf(n);
      for (const r of rows) {
        if (r.length < 4) continue;
        const t = { title: r[at('Track Name')], album: r[at('Album Name')],
                    artists: (r[at('Artist Name(s)')] || '').split(';') };
        bump(r[at('Track URI')] || t.title + '|' + t.album, t).liked = true;
      }
    } else {
      for (const e of JSON.parse(text)) {
        if (!e.master_metadata_track_name || (e.ms_played || 0) < MIN_PLAY_MS) continue;
        const t = { title: e.master_metadata_track_name, album: e.master_metadata_album_album_name,
                    artists: [e.master_metadata_album_artist_name] };
        bump(e.spotify_track_uri || t.title + '|' + t.album, t).plays++;
      }
    }
  }
  return [...tracks.values()].map(t => Object.assign(t, {
    nTitle: norm(cleanTitle(t.title)),
    nFilm: norm(fromFilm(t.title) || filmOfAlbum(t.album)),
    nArtists: t.artists.map(norm).filter(Boolean),
  }));
}

/* ---- the songs a Spotify track could be ---- */

function catalogSongs() {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const re = /\{ title: ("(?:[^"\\]|\\.)*"), artist: ("(?:[^"\\]|\\.)*"), movie: ("(?:[^"\\]|\\.)*"), trackId: (\d+) \}/g;
  const out = [];
  for (const m of html.matchAll(re)) {
    out.push({ title: JSON.parse(m[1]), artist: JSON.parse(m[2]), movie: JSON.parse(m[3]), trackId: +m[4] });
  }
  const queued = fs.existsSync(QUEUE) ? JSON.parse(fs.readFileSync(QUEUE, 'utf8')) : [];
  return out.concat(queued.filter(q => !out.some(s => s.trackId === q.trackId)));
}

function matches(t, s) {
  if (norm(s.title) !== t.nTitle) return false;
  const f = norm(s.movie);
  if (f && t.nFilm && (t.nFilm === f || t.nFilm.includes(f) || f.includes(t.nFilm))) return true;
  return (s.artist || '').split(',').map(norm).some(a => a && t.nArtists.includes(a));
}

/* ---- Apple, for songs to add ---- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
function api(url) {
  const file = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  return (requests++ ? sleep(3200) : Promise.resolve()).then(() => new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'filmi-spotify' } }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ results: [] });
        let data; try { data = JSON.parse(body); } catch (e) { data = { results: [] }; }
        if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data));
        resolve(data);
      });
    }).on('error', reject);
  }));
}

const VARIANT = /\b(remix|unplugged|version|cover|instrumental|lo-?fi|reprise|karaoke|mashup|live|slowed|reverb|acoustic|mix)\b/i;

// The Apple recording of a Spotify track: same title, same film, Bollywood, not
// a variant. Returns a catalog entry or null - never a guess.
async function resolveOnApple(t) {
  const film = fromFilm(t.title) || filmOfAlbum(t.album);
  const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(cleanTitle(t.title) + ' ' + film) +
              '&entity=song&country=IN&limit=25';
  const res = await api(url);
  const hits = (res.results || []).filter(r =>
    r.previewUrl && r.trackId && r.primaryGenreName === 'Bollywood' &&
    norm(cleanTitle(r.trackName)) === t.nTitle && !VARIANT.test(r.trackName) &&
    (norm(fromFilm(r.trackName) || filmOfAlbum(r.collectionName)).includes(norm(film)) ||
     norm(film).includes(norm(filmOfAlbum(r.collectionName)))));
  const best = hits.find(r => /motion picture|soundtrack/i.test(r.collectionName)) || hits[0];
  if (!best) return null;
  return {
    title: cleanTitle(t.title),
    artist: (best.artistName || '').split(/\s*(?:,|&)\s*/).slice(0, 3).join(', '),
    movie: film,
    trackId: best.trackId,
    source: 'spotify',
  };
}

/* ---- main ---- */

(async function main() {
  const tracks = readInputs(inputs);
  const songs = catalogSongs();
  const today = new Date().toISOString().slice(0, 10);

  const known = [], priority = [], toAdd = [];
  for (const t of tracks) {
    const strong = t.liked || t.plays >= KNOWN_PLAYS;
    const hit = songs.filter(s => matches(t, s));
    if (hit.length) {
      hit.forEach(s => (strong ? known : priority).push(s));
    } else if ((t.liked || t.plays >= ADD_PLAYS) && looksLikeFilm(t.title, t.album)) {
      toAdd.push(t);
    }
  }

  const vetting = fs.existsSync(VETTING) ? JSON.parse(fs.readFileSync(VETTING, 'utf8')) : [];
  const answered = new Set(vetting.map(a => norm(a.title) + '|' + norm(a.movie)));
  const newKnown = known.filter(s => !answered.has(norm(s.title) + '|' + norm(s.movie)));
  const fresh = [...new Map(newKnown.map(s => [norm(s.title) + '|' + norm(s.movie), s])).values()];

  const additions = fs.existsSync(ADDITIONS) ? JSON.parse(fs.readFileSync(ADDITIONS, 'utf8')) : [];
  const added = [], unresolved = [];
  for (const t of toAdd) {
    const a = await resolveOnApple(t);
    if (!a) { unresolved.push(t); continue; }
    if (additions.concat(added).some(x => x.trackId === a.trackId)) continue;
    added.push(a);
  }

  console.log(tracks.length + ' Spotify tracks read');
  console.log(fresh.length + ' catalog/queued songs newly marked known');
  fresh.forEach(s => console.log('   known  ' + s.title + ' — ' + s.movie));
  console.log(added.length + ' film songs to add');
  added.forEach(a => console.log('   add    ' + a.title + ' — ' + a.movie + '  (' + a.trackId + ')'));
  if (unresolved.length) {
    console.log(unresolved.length + ' film songs not found on Apple, skipped:');
    unresolved.forEach(t => console.log('   ?      ' + t.title + ' — ' + t.album));
  }
  if (priority.length) console.log(priority.length + ' played once or twice - first in the vetting queue');
  console.log(requests + ' Apple requests');

  if (DRY) { console.log('--dry, nothing written'); return; }
  const source = inputs.some(f => /\.csv$/i.test(f)) ? 'spotify-liked' : 'spotify-history';
  fs.writeFileSync(VETTING, JSON.stringify(vetting.concat(fresh.map(s => ({
    title: s.title, movie: s.movie, known: true, source, at: today,
  }))), null, 1) + '\n');
  fs.writeFileSync(ADDITIONS, JSON.stringify(additions.concat(added), null, 1) + '\n');
  fs.writeFileSync(PRIORITY, JSON.stringify(priority.map(s => s.trackId)));
})().catch(e => { console.error(e); process.exit(1); });

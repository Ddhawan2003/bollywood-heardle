#!/usr/bin/env node
/*
    The vetting page: one song at a time, its preview playing, one key to say
    whether you know it. Replaces answering numbered lists in chat.

        node build/vet.js          then answer in the browser tab it opens
        node build/harvest.js      afterwards, to fold the answers in
        pwsh build/build.ps1 -Verify

    Answers are appended to build/vetting.json the moment they are given, so
    closing the tab loses nothing and the next session resumes where this one
    stopped. build/harvest.js reads that file as ground truth: known songs are
    guaranteed a place, unknown ones are removed and not replaced.

    The queue is build/.vet-queue.json, which every harvest run rewrites. Order:
    songs Spotify says you have played (likely yes, so quick), then songs the
    game is dealing right now that nobody has asked you about - those are the
    ones making rounds miss today - then songs waiting to be added.

    Local only: it binds to 127.0.0.1 and writes one file in this folder.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 5178;
const PAGE = path.join(__dirname, 'vet.html');
const VETTING = path.join(__dirname, 'vetting.json');
const QUEUE = path.join(__dirname, '.vet-queue.json');
const EXTRA = path.join(__dirname, '.vet-extra.json');       // optional, one-off lists
const PRIORITY = path.join(__dirname, '.vet-priority.json');  // from build/spotify.js

const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = s => norm(s.title) + '|' + norm(s.movie);
const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);

function answers() { return readJson(VETTING, []); }
function saveAnswers(list) { fs.writeFileSync(VETTING, JSON.stringify(list, null, 1) + '\n'); }

function queue() {
  if (!fs.existsSync(QUEUE)) throw new Error('No queue yet - run: node build/harvest.js');
  const done = new Set(answers().map(keyOf));
  const priority = new Set(readJson(PRIORITY, []));
  const rank = q => (priority.has(q.trackId) ? 0 : q.kind === 'shipped' ? 1 : q.kind === 'extra' ? 2 : 3);
  const seen = new Set();
  return readJson(QUEUE, []).concat(readJson(EXTRA, []).map(s => Object.assign({ kind: 'extra' }, s)))
    .filter(q => { const k = keyOf(q); if (done.has(k) || seen.has(k)) return false; seen.add(k); return true; })
    // Shuffled within each group by a hash of the trackId: arbitrary, but the
    // same on every run, so a resumed session does not reshuffle under you.
    .map(q => Object.assign(q, { order: rank(q) * 2 ** 32 + (Math.imul(q.trackId, 2654435761) >>> 0) }))
    .sort((a, b) => a.order - b.order);
}

function body(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', d => (s += d));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });
}

const send = (res, code, type, data) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
};
const json = (res, data) => send(res, 200, 'application/json', JSON.stringify(data));

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PAGE));
    if (req.method === 'GET' && req.url === '/queue') {
      const list = answers().filter(a => a.source === 'vet');
      return json(res, { queue: queue(), known: list.filter(a => a.known).length, unknown: list.filter(a => !a.known).length });
    }
    if (req.method === 'POST' && req.url === '/answer') {
      const a = await body(req);
      if (!a.title || typeof a.known !== 'boolean') return send(res, 400, 'text/plain', 'bad answer');
      const list = answers();
      list.push({ title: a.title, movie: a.movie || '', known: a.known, source: 'vet',
                  at: new Date().toISOString().slice(0, 10) });
      saveAnswers(list);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/undo') {
      const list = answers();
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].source === 'vet') { const [gone] = list.splice(i, 1); saveAnswers(list); return json(res, { undone: gone }); }
      }
      return json(res, { undone: null });
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain', String(e.message || e));
  }
}).listen(PORT, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + PORT + '/';
  console.log('Vetting page: ' + url + '  (Ctrl+C to stop; answers are saved as you go)');
  const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (!process.argv.includes('--no-open')) exec(opener + ' "' + url + '"');
});

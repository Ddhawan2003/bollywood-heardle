#!/usr/bin/env node
/*
    Builds the song catalog at the top of src/template.html from the iTunes
    Search API. Run by hand, never as part of a build - it takes half an hour
    and hits Apple a few hundred times.

        node build/harvest.js                 harvest, then rewrite the catalog
        node build/harvest.js --dry           harvest and report, write nothing
        node build/harvest.js --target 300    how many songs to keep
        node build/harvest.js --composers 4   stop after N composers (a smoke run)

    Bollywood ships in soundtrack albums, so the catalog scales by harvesting
    FILMS, not songs:

      1. each seed composer -> artistId          (1 request per composer)
      2. artistId           -> up to 200 albums  (1 request per composer)
      3. expand the album-shaped ones            (1 request per album)

    An album's own tracks say what kind of album it is. Compilation tracks are
    titled Tere Bina (From "Guru"); a soundtrack's are just titled Tere Bina.
    So each expanded album is classified after the fact: mostly-marked means a
    compilation, and its songs become POPULARITY SIGNAL rather than candidates.

    Popularity matters because 300 uniformly obscure songs is a vocabulary test
    rather than a game. What ranks them is POSITION - where a song sits on its
    soundtrack, and where that soundtrack sits in Apple's ordering of the
    composer's albums. Both come free with requests already being made, both
    fall away smoothly instead of firing on an arbitrary subset, and neither is
    an artifact of the release era. An appearance on the composer's own best-of
    is a smaller bonus on top.

    Two better-sounding theories were measured here and both failed:

      - counting appearances across Various Artists "Bollywood Hits"
        compilations, on the theory that hits get repackaged and deep cuts do
        not. What Apple's India store returns for those searches is
        party/workout sets and small-label re-recordings; of 310 candidates
        exactly 3 matched, none of them Tum Hi Ho, Kabira or Channa Mereya.
      - ranking by a dedicated single release, Kesariya (From "Brahmastra") -
        Single, on the theory that labels only cut singles for songs they are
        pushing. Anti-correlated with fame in practice - see the note on
        scoring further down.

    Both cost only cached requests to disprove, which is the point of the cache.

    Every response is cached under build/.harvest-cache, so a re-run to change
    only the selection rules is free and an interrupted run resumes.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'src', 'template.html');
const CACHE = path.join(__dirname, '.harvest-cache');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

// Spread across eras on purpose: a catalog of nothing but 2015-2023 Arijit
// Singh is a narrower game than it looks.
const COMPOSERS = [
  'A.R. Rahman', 'Pritam', 'Shankar-Ehsaan-Loy', 'Vishal-Shekhar', 'Amit Trivedi',
  'Sachin-Jigar', 'Tanishk Bagchi', 'Himesh Reshammiya',
  'Salim-Sulaiman', 'Ismail Darbar', 'Ankit Tiwari', 'Sajid-Wajid',
  'Sachet-Parampara', 'Vishal Mishra', 'Amaal Mallik',
  // Small modern soundtrack credits that were never seeded, so their film work
  // could only arrive by accident, as a featured credit on someone else's album.
  'Abhijit Vaghani', 'Anurag Vashisht', 'Aman Pant', 'Akhil Sachdeva', 'B Praak',
];

// Deliberately NOT harvested. These twelve shipped 390 of the previous 1,237
// film songs and were cut by hand, not by score: mostly pre-2000 catalogue that
// a player in their twenties has no reason to recognise. Listed rather than
// deleted so the next person can see the choice was made and put one back:
//
// Nadeem-Shravan joined them later, and on evidence rather than taste: in a
// blind 30-song sample drawn the way the app deals them, the player recognised
// 15 - and went 0 for 4 on Nadeem-Shravan, the worst score of any composer in
// the draw. They were the last pre-2010 name still seeded, worth 68 songs.
//
//   Anu Malik 76, Mithoon 74, Nadeem-Shravan 68, Jeet Gannguli 39, Rajesh Roshan 37,
//   Laxmikant-Pyarelal 35, Bappi Lahiri 33, R. D. Burman 24, Jatin-Lalit 20,
//   Shankar Jaikishan 15, Kalyanji-Anandji 14, Sanjay Leela Bhansali 13,
//   Anirudh Ravichander 10
//
// Anirudh is the one with a real cost attached: he is Jawan, so the 2020s lose
// their single biggest soundtrack. The rest of that era is carried by Pritam,
// Tanishk Bagchi, Sachin-Jigar, Vishal Mishra, Amaal Mallik and Sachet-Parampara.

// Hindi and Punjabi music that is NOT from a film: indie, hip-hop, pop singles.
// These are harvested a completely different way - see harvestArtists - because
// there is no film to hang them off. Seeded from a Spotify liked-songs export,
// so the list is what one player actually listens to rather than a guess at a
// canon; edit it freely.
const ARTISTS = [
  'Anuv Jain', 'Prateek Kuhad', 'AUR', 'King', 'Seedhe Maut',
  'MC STAN', 'KR$NA', 'DIVINE', 'Raftaar', 'Karan Aujla',
  // Dino James and Osho Jain sat here and were dropped by hand.
  'Yashraj', 'Abdul Hannan', 'Ritviz', 'When Chai Met Toast',
  'Raghav Chaitanya', 'Aditya A', 'Mitraz', 'Zaeden',
  // Punjabi-pop and the singles side of playback singers who release outside
  // film. NON_HINDI_LOOSE deliberately lets Punjabi through, which is most of
  // the point of Guru Randhawa, Imran Khan and Ikky.
  'Guru Randhawa', 'Badshah', 'Darshan Raval', 'B Praak', 'Tony Kakkar',
  'Imran Khan', 'Atif Aslam', 'Neha Kakkar', 'Tulsi Kumar', 'Akhil Sachdeva',
  'Ikky', 'Dominique Cerejo',
];

// Playback singers, harvested by harvestSingers - a THIRD path, and the only one
// seeded by who SANG a song rather than who wrote it.
//
// The film path reaches a singer only by accident: it walks composers, so a
// singer arrives in the catalog exactly as often as the seeded composers happen
// to have hired them. That works for the ubiquitous - Arijit landed 115 songs
// without ever being named - and fails badly for anyone whose canon sits with
// composers we do not seed. Atif Aslam had 6.
//
// Several of these names are on ARTISTS as well. That is deliberate, not a
// duplicate: the two paths split the same artist's catalogue down the middle,
// harvestArtists keeping the singles and this keeping the film songs.
const SINGERS = [
  'Arijit Singh', 'Shreya Ghoshal', 'Sonu Nigam', 'KK', 'Mohit Chauhan',
  'Shaan', 'Armaan Malik', 'Neeti Mohan', 'Nikhita Gandhi', 'Benny Dayal',
  'Vishal Dadlani', 'Mika Singh', 'Sachet Tandon', 'Rahat Fateh Ali Khan',
  'Neeraj Shridhar', 'Atif Aslam', 'Darshan Raval', 'Tulsi Kumar',
  'Neha Kakkar', 'Dominique Cerejo', 'Amitabh Bhattacharya', 'Akhil Sachdeva',
  'B Praak', 'Guru Randhawa', 'Badshah',
];

// Songs a player was dealt, blind, and could not name. Ground truth rather than
// a prediction, which is why they are listed one by one instead of being
// characterised by a rule: the scoring model was measured against this same
// sample and it does not separate them - songs the player knew averaged 92.5,
// songs they did not averaged 88.3, on a range that runs 65 to 112. Nothing in
// album position or release packaging distinguishes these from the rest, so the
// only honest way to drop them is by name.
//
// Add to this freely. It is checked on title AND film, so a shared title like
// Tere Bina only loses the one that was actually rejected.
const REJECTED = [
  ['Dil Jahan Pe Le Chala (Amit Trivedi)', 'Jubilee'],
  ['Khamoshiyan', 'Khamoshiyan'],
  ['Zindagi Tere Naam', 'Yodha'],
  ['Main Hoon Na', 'Main Hoon Na'],
  ['Chaiyaan Mein Saiyaan Ki', 'Khuda Haafiz - Chapter 2 Agni Pariksha'],
  ['Kaboom', 'One By Two'],
  ['Sapna Jahan', 'Brothers'],
  ['Kitni Baatein', 'Lakshya'],
  ['Hauli Hauli', 'De De Pyaar De'],
  ['Mere Nishaan', 'Oh My God'],
  ['Meer-E-Kaarwan', 'Lucknow Central'],
  ['Sofia', '99 Songs'],
  ['Andekhe Rang', 'Nazar Andaaz'],
  ['Dua', 'Kurbaan'],
  ['Chhatriwali - Title Track', 'Chhatriwali'],
  ['Billi Billi', 'Kisi Ka Bhai Kisi Ki Jaan'],
  // Non-film, so the second field is empty.
  ['Bbm', ''],
  ['Naash', ''],
  ["We Doin' It Big", ''],

  // Rejected in the same pass but already outside the catalog at the time -
  // mostly pre-2000, which had just gone to zero. Listed anyway, and the reason
  // is worth keeping: the first version of this list held only songs that were
  // still IN the catalog, and dropping the others freed enough quota that Aafat
  // was promoted straight back in from just below the cutoff. A rejection is a
  // fact about the player, not about this build's selection.
  ['Aafat', 'Liger'],
  ['Aankhon Ki Gustakhiyan', 'Hum Dil De Chuke Sanam'],
  ['Ishq Bina', 'Taal'],
  ['Yeh Haseen Vadiyan Yeh Khula Aasman', 'Roja'],
  ['Ek Ho Gaye Hum Aur Tum', 'Bombay'],
  ['Dil Haara', 'Tashan'],
  ['Kuchh Khaas', 'Fashion'],
  ['Main Teri Hi Rahoon', 'Chhatriwali'],
  ['Tu Meri Zindagi-Adayein', 'T-Series Mixtape Rewind Season 3'],
  ['Unstoppable', ''],
];

const CONFIG = {
  // Apple's ordering puts a composer's big films first, so this is a relevance
  // cutoff as much as a budget. It was 20, which stopped dead at 2019 for the
  // prolific moderns - Pritam's Brahmastra is his album #25, Animal #28, Bhool
  // Bhulaiyaa 2 #29, Dunki #36. Every one of those is past a cutoff of 20, so
  // no amount of rescoring could reach them; they were never fetched.
  //
  // Raised again to 150 when the composer list was cut from 28 to 16. Half the
  // seeds went away, so the catalog has to come from MORE FILMS PER COMPOSER
  // rather than more songs per film - see songsPerFilm below.
  albumsPerComposer: 150,
  // 12 down to 8, for the same reason the era quotas came down: Apple returns an
  // artist most-prominent-first, so songs 9 through 12 are the tail of a named
  // artist's catalogue and the least likely to be recognised.
  songsPerArtist: 8,
  songsPerSinger: 25,      // film songs reached via the singer rather than the composer

  // Lowered from 4 to widen the catalog across soundtracks rather than dig into
  // them: at 4, two thirds of the film side was track 2, 3 or 4, and 185 films
  // contributed the full four. It bought 100 more distinct films, which is worth
  // having on its own.
  //
  // It was argued at the time as the fix for recognisability, on the theory that
  // a soundtrack opens with the song the film is selling. That theory has since
  // been tested against 60 hand-marked songs and it does not hold: pooled, the
  // player knew 54% of track 1, 53% of track 2 and 47% of track 3+. Position is
  // close to flat. Two 30-song samples read in opposite directions on it, which
  // is what a sample that size does. Keep the number for the breadth, not for a
  // recognisability claim it cannot support.
  songsPerFilm: 3,

  // Effectively off. It existed to stop one composer owning an era back when
  // there were 28 of them; with 16 hand-picked names, a composer taking a large
  // share of an era is the intended outcome, not a failure.
  songsPerComposer: 999,
  delayMs: 3200,           // ~19 requests/minute, under Apple's soft limit
};

// The catalog is filled era by era rather than as one global ranking, because a
// global one is always won by whichever era has the most releases on Apple: the
// 2010s took 160 of 300 while the 2020s got 10. Position ranks songs honestly
// WITHIN an era; it says nothing about how many slots an era deserves, so the
// quotas are set here rather than hoped for.
//
// The spans are deliberately unequal and it shows in the result. "pre-2000"
// skims the best of six decades; the 2020s quota is drawn from about six years,
// so it reaches much further down its own ranking. Expect the recent bucket to
// be the obscure one, and expect it to be the one that falls short.
// Reweighted when the composer list was cut to 16. pre-2000 fell from 110 to 40
// because with the old guard gone that quota was being filled almost entirely by
// deep Nadeem-Shravan album cuts - Salaami, Tadipaar, Hameshaa - which is the
// exact 1990s obscurity the cut was meant to remove, re-entering by the back
// door. 'undated' went to 0: it has never once filled.
// Cut again, hard, to land the whole catalog near 1,200. The blind sample is
// what set the size: of 15 misses, 7 came from Nadeem-Shravan and non-Hindi
// contamination and are dealt with above, but the other 8 were ordinary Hindi
// album tracks - real, modern, simply not hits. Nothing about scoring fixes
// those, because the quota is what forces the reach: 650 slots for the 2010s has
// to be filled by SOMETHING, and past the famous few hundred it is buying album
// tracks. The only honest fix for the tail is to stop asking for it.
//
// The 2020s is cut proportionally hardest because its tail was the worst - at a
// quota of 450 its weakest entries scored 16, against 74 for the 2000s at 260.
//
// Then cut much harder still, and this one reverses the assumption the whole
// file was built on: that a player in their twenties wants recent music, so the
// recent quota should be the largest. Measured over 60 songs drawn the way the
// app deals them and marked by hand, it is not what happens -
//
//   2010s 63%   2020s 48%   2000s 40%   pre-2000 33%
//
// - and the 2020s came second WORST, below the 2000s, while being the largest
// slice of the catalog. The misses were not obscure album tracks either; they
// were lead songs from mid-tier recent films (Shiddat, Uunchai, Radhe Shyam,
// An Action Hero). Far more films release now than any one person tracks, so a
// large 2020s quota reaches straight into films nobody saw. The 2010s is drawn
// from a decade already filtered by what stuck, which is why it wins.
// Then measured again, properly, on a hundred songs drawn the way the app deals
// them and marked by hand. 71 of 100 known, and the split is unambiguous:
//
//   2010s 81%   2020s 64%   2000s 64%   pre-2000 0 of 4
//
// pre-2000 goes to zero. It has now been sampled three times and returned 1 of
// 7 across all of them - a bucket the player recognises roughly one song in
// seven from is not a hard era, it is a dead round with a soundtrack. Everything
// it gives up goes to the 2010s, which is not merely the best-known decade here
// but the best-known by seventeen points.
const ERAS = [
  { name: '2020s',    from: 2020, to: 9999, quota: 170 },
  { name: '2010s',    from: 2010, to: 2019, quota: 620 },
  { name: '2000s',    from: 2000, to: 2009, quota: 130 },
  { name: 'pre-2000', from: 1,    to: 1999, quota: 0   },
  { name: 'undated',  from: 0,    to: 0,    quota: 0   },
];

CONFIG.target = ERAS.reduce((n, e) => n + e.quota, 0);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : Number(argv[i + 1]);
};
const DRY = argv.includes('--dry');
CONFIG.target = flag('target', CONFIG.target);
// Lets a dry run stay inside the cache: the previous crawl fetched 60 albums per
// composer, so --albums 60 --dry reports in seconds and makes no requests.
CONFIG.albumsPerComposer = flag('albums', CONFIG.albumsPerComposer);
const COMPOSER_LIMIT = flag('composers', COMPOSERS.length);
const SINGER_LIMIT = flag('singers', SINGERS.length);
const ARTIST_LIMIT = flag('artists', ARTISTS.length);
const FILM_ONLY = argv.includes('--film-only');   // skip the non-film harvest
// Writes every chosen song with the score that chose it, so the ranking can be
// checked against what a player actually recognises instead of assumed to work.
const DUMP = (function () { const i = argv.indexOf('--dump'); return i === -1 ? null : argv[i + 1]; })();

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;

function raw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'filmi-harvester' } }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

// Apple answers a burst happily and then starts refusing, so back off hard on
// a 403 rather than hammering through the rest of the run.
async function api(url) {
  const key = crypto.createHash('sha1').update(url).digest('hex');
  const file = path.join(CACHE, key + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  for (let attempt = 0; attempt < 4; attempt++) {
    if (requests++) await sleep(CONFIG.delayMs);
    const res = await raw(url);
    if (res.status === 200) {
      let data;
      try { data = JSON.parse(res.body); }
      catch (e) { data = { results: [] }; }      // Apple occasionally sends junk
      fs.writeFileSync(file, JSON.stringify(data));
      return data;
    }
    if (res.status === 403 || res.status === 429) {
      process.stdout.write('  (rate limited, waiting 60s) ');
      await sleep(60000);
      continue;
    }
    return { results: [] };
  }
  return { results: [] };
}

const search = (term, entity, limit) =>
  api('https://itunes.apple.com/search?term=' + encodeURIComponent(term) +
      '&entity=' + entity + '&country=IN&limit=' + (limit || 50));

const lookup = (id, entity, limit) =>
  api('https://itunes.apple.com/lookup?id=' + id +
      (entity ? '&entity=' + entity : '') + '&country=IN&limit=' + (limit || 200));

/* ------------------------------------------------------------------ */
/* Cleaning                                                            */
/* ------------------------------------------------------------------ */

const norm = s => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Word-boundary matched, unlike the app's substring check - a harvester sees
// thousands of titles, and "live" inside "Deliverance" would quietly bin a
// perfectly good song.
const BAD_TITLE = new RegExp('\\b(' + [
  'remix', 'unplugged', 'version', 'cover', 'instrumental', 'lofi', 'lo-fi',
  'reprise', 'karaoke', 'encore', 'mashup', 'medley', 'recreated', 'dialogues',
  'dialogue', 'live', 'slowed', 'theme', 'interlude', 'score', 'promo',
  'jhankar', 'remastered',
  // Streaming-era repackaging of a song that already exists under its own name.
  // All either multi-word or rare enough as single tokens to be safe against a
  // real Hindi title.
  'refix', 'rework', 'sped up', 'nightcore', 'bass boosted', 'radio edit',
  'revisited',
  // Bare "mix" as well as the named variants. 'remix' alone missed a whole
  // remix album: Dilwale - Celebration Party Mixes shipped Gerua, Tukur Tukur
  // and Manma Emotion Jaage as "(Desi Hip Hop Mix) [DJ Shilpi Mix]". Measured
  // against the shipped catalog this drops six songs and every one is a remix.
  'mix', 'mixes',
  // Session and showcase series re-record songs that already exist under their
  // own name. Rare on soundtracks, constant in indie: Anuv Jain ships an
  // acoustic cut of nearly everything.
  'acoustic', 'coke studio', 'dewarists', 'sessions', 'session',
].join('|') + ')\\b', 'i');

const NON_HINDI = /\b(telugu|tamil|kannada|malayalam|punjabi|bhojpuri|marathi|bengali|gujarati)\b/i;

// NON_HINDI can only read the title and the film NAME, which is not where the
// problem announces itself. A seeded composer scores far more than Hindi cinema:
// Rahman's Tamil catalogue, Tanishk Bagchi's Hindi dubs of Kannada films, B
// Praak's Punjabi cinema, web-series soundtracks, and Rahman's score for Pelé, a
// Brazilian football documentary. Not one of those says "Tamil" or "Kannada" in
// its film name - "KGF Chapter 1" and "Pelé" sail straight through - and they
// measured at 4% of the shipped catalog.
//
// Apple's own genre tag is the field that actually knows. On the film side it is
// overwhelmingly decisive: 1,308 of 1,407 film songs came back Bollywood, and
// essentially all the contamination sat in the remaining 99. Anything tagged
// otherwise also sweeps up instrumental score cues, which arrive as Soundtrack -
// Dunki (Original Score) shipped "Escape from Hospital" as a guessable song.
const FILM_GENRE = /^bollywood$/i;

// The non-film half needs the opposite treatment: Punjabi pop is half the point
// of seeding Karan Aujla and Guru Randhawa, and the hip-hop artists are tagged
// every which way, so it names what to REJECT rather than what to keep.
const NON_FILM_BAD_GENRE =
  /^(tamil|telugu|kannada|malayalam|marathi|bengali|gujarati|bhojpuri|regional indian|devotional|christian|new age|classical|tv soundtrack)/i;

// The non-film path uses this instead. Punjabi is deliberately absent: a Hindi
// film soundtrack labelled "Punjabi" is a regional dub and unwanted, but half
// the point of seeding Karan Aujla is the Punjabi tracks.
const NON_HINDI_LOOSE = /\b(telugu|tamil|kannada|malayalam|bhojpuri|marathi|bengali)\b/i;

function filmFromAlbum(name) {
  return (name || '')
    .replace(/[\(\[]\s*(original\s+)?(motion\s+picture\s+)?sound\s*track[^\)\]]*[\)\]]/ig, '')
    .replace(/[\(\[]\s*music\s+from[^\)\]]*[\)\]]/ig, '')
    .replace(/[\(\[]\s*(deluxe|expanded|special)[^\)\]]*[\)\]]/ig, '')
    .replace(/\s*-\s*(single|ep)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Kesariya (From "Brahmastra") - Single, or a compilation track titled the same
// way: the film travels in the name rather than the album. Both the single and
// the best-of signals are read straight out of this.
//
// The quotes are required. Jannat 2's soundtrack carries an alternate cut
// called Tera Deedar Hua (From the Heart), and without them that parses as a
// film named "the Heart". Every genuine marker Apple returns is quoted.
function unpackFrom(name) {
  const bare = (name || '').replace(/\s*-\s*(single|ep)\s*$/i, '');
  const m = /^(.*?)\s*[\(\[]\s*from\s+["“](.+?)["”]\s*[\)\]]\s*$/i.exec(bare);
  return m ? { title: m[1].trim(), film: m[2].trim() } : null;
}

// The game asks players to TYPE these, so a title has to be the name of the
// song and nothing else. Apple hangs two kinds of decoration off the end:
//
//   Darkhaast (feat. Arijit Singh, Sunidhi Chauhan)   a performer credit
//   Sholay (Title Music) / Muskurane (Romantic)       a version label
//
// Both come off. What must survive is a parenthetical that is genuinely part
// of the name - Boom Boom (Lip Lock), Ala Barfi (Kaju Barfi) - so this matches
// a closed list of labels rather than stripping every trailing bracket.
const FEAT = /\s*[\(\[]\s*(?:feat|ft|featuring)\.?\s+([^\)\]]*)[\)\]]/ig;
const VERSION_LABEL =
  /\s*[\(\[]\s*(?:title\s+(?:track|music|song)|romantic|female|male|duet|solo|sad|happy)\s*[\)\]]\s*$/i;

const tidyTitle = t => (t || '')
  .replace(FEAT, '')
  .replace(VERSION_LABEL, '')
  .replace(/\s+/g, ' ')
  .trim();

// The performers named in a "(feat. ...)" credit, which is sometimes the only
// place a soundtrack names its singers at all.
function featuredIn(title) {
  const out = [];
  String(title || '').replace(FEAT, (_, names) => { out.push(names); return ''; });
  return out.join(', ');
}

const stripTrailingParen = t => (t || '').replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/, '').trim();

const signalKey = (title, film) => norm(title) + '|' + norm(film);

// Empty when the track credits nobody but the composer, who is on every track
// and so names no one. The caller falls back to the "(feat. ...)" credit.
function cleanArtists(artistName, composer) {
  const parts = (artistName || '').split(/\s*(?:,|&|feat\.|featuring)\s*/i)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(a => norm(a) !== norm(composer));
  return parts.slice(0, 3).join(', ');
}

const artistTokens = s => norm(s).split(' ').filter(w => w.length > 3);

/* ------------------------------------------------------------------ */
/* Harvest                                                             */
/* ------------------------------------------------------------------ */

async function artistIdFor(name) {
  const res = await search(name, 'musicArtist', 10);
  const hits = (res.results || []).filter(r => norm(r.artistName) === norm(name));
  // Several artists share a name; the Bollywood-tagged one is the composer.
  return (hits.find(r => r.primaryGenreName === 'Bollywood') || hits[0] || {}).artistId;
}

// Named like a collection rather than a film. Cheap pre-filter, so we do not
// spend a request finding out; the content check below is the real arbiter.
const COMPILATION_NAME =
  /\b(best of|greatest|hits|collection|classics|essentials|journey|definitive|anthology|musical bond|top \d+|vol\.? ?\d+)\b/i;

async function albumsFor(artistId) {
  const res = await lookup(artistId, 'album', 200);
  const all = (res.results || [])
    .filter(r => r.wrapperType === 'collection')
    .filter(r => ['Bollywood', 'Soundtrack'].includes(r.primaryGenreName))
    .filter(r => !NON_HINDI.test(r.collectionName));

  // Singles need no request at all - the film is right there in the album name.
  const singles = all
    .filter(r => r.trackCount <= 3)
    .map(r => unpackFrom(r.collectionName))
    .filter(Boolean);

  // Everything album-shaped gets expanded; what it turns out to be is decided
  // from its tracks afterwards.
  const films = all
    .filter(r => r.trackCount >= 4)
    .filter(r => !COMPILATION_NAME.test(r.collectionName));

  // albumTotal is the length BEFORE the cutoff, because rank is scored as a
  // percentile of the composer's whole catalog rather than an absolute
  // position. Pritam's 25th album of 77 is top-third; Ismail Darbar's 12th of
  // 13 is the bottom. An absolute rank calls them both "past 20" and is wrong
  // about at least one of them.
  return {
    singles,
    albums: films.slice(0, CONFIG.albumsPerComposer),
    albumTotal: films.length,
    bestOf: all.filter(r => r.trackCount >= 8 && COMPILATION_NAME.test(r.collectionName)),
  };
}

// A compilation labels every track with the film it came from; a soundtrack has
// no need to. That is the difference, and it is in the data rather than in the
// album's name.
function looksLikeCompilation(tracks) {
  const songs = tracks.filter(t => t.wrapperType === 'track' && t.trackName);
  if (songs.length < 4) return false;
  const marked = songs.filter(t => unpackFrom(t.trackName)).length;
  return marked / songs.length >= 0.5;
}

// A remix album is worth rejecting whole rather than track by track: its own
// name says what it is, and relying on each title to confess leaves behind any
// cut whose remixer did not bother to label it.
const REMIX_ALBUM = /\b(mixes|remixes|party mix|club mix|dj mix|remixed)\b/i;

// A title that still names the film it came from, anywhere in the string. Used
// only on the NON-film path, where its presence proves the song is not a single.
const SAYS_FROM = /\(\s*from\b|\bfrom\s+["“]/i;

// Albums the film path can read a plausible film name out of, which are not
// films: label mixtapes, web-series soundtracks, jukeboxes, best-ofs. "T-Series
// Mixtape Rewind Season 3" shipped a track as though Rewind Season 3 were a
// movie nobody had heard of - which, in fairness, is true.
const BAD_ALBUM = /\b(mixtape|jukebox|best of|greatest hits|season \d|top \d+|all songs)\b/i;

function candidatesFrom(tracks, composer, albumName, rank, albumTotal) {
  const out = [];
  if (REMIX_ALBUM.test(albumName || '') || BAD_ALBUM.test(albumName || '')) return out;

  // Soundtracks carry alternate cuts beside the original - Tera Deedar Hua and
  // Tera Deedar Hua (From the Heart) sit on the same album. A parenthesised
  // title whose stem is ALSO on this album is one of those, and only one of
  // them belongs in the catalog. Titles whose brackets are simply part of the
  // name, like Ala Barfi (Kaju Barfi), have no such stem and stay.
  const plain = new Set(tracks.filter(t => t.wrapperType === 'track')
                              .map(t => norm(tidyTitle(t.trackName))));

  for (const t of tracks) {
    if (t.wrapperType !== 'track' || t.kind !== 'song') continue;
    if (!t.previewUrl || !t.trackId) continue;
    if (!t.trackTimeMillis || t.trackTimeMillis < 60000) continue;   // interludes, dialogue

    const from = unpackFrom(t.trackName);
    const title = tidyTitle(from ? from.title : t.trackName);
    const movie = from ? from.film : filmFromAlbum(albumName);
    if (!title || !movie) continue;
    if (BAD_TITLE.test(title)) continue;
    if (NON_HINDI.test(title) || NON_HINDI.test(movie)) continue;
    if (!FILM_GENRE.test(t.primaryGenreName || '')) continue;

    const stem = norm(stripTrailingParen(title));
    if (stem && stem !== norm(title) && plain.has(stem)) continue;

    out.push({
      title: title.trim(),
      // Shivaay credits only Mithoon on the album and names its singers inside
      // the track titles, so the credit we just stripped is the fallback.
      artist: cleanArtists(t.artistName, composer) ||
              cleanArtists(featuredIn(t.trackName), composer) ||
              t.artistName,
      movie: movie,
      trackId: t.trackId,
      nTitle: norm(title),
      nMovie: norm(movie),
      trackNumber: t.trackNumber || 99,
      albumRank: rank,
      // 0 for the composer's most prominent film, 1 for their least.
      albumPct: albumTotal > 1 ? rank / (albumTotal - 1) : 0,
      // Apple's date is the release of THIS pressing, so a reissued 1975 song
      // can carry a 2015 date. Good enough to see the shape of the catalog,
      // not good enough to key anything off.
      year: Number((t.releaseDate || '').slice(0, 4)) || 0,
      composer,
    });
  }
  return out;
}

async function harvest() {
  const candidates = [];
  const singles = new Set();      // "title|film" with a dedicated single release
  const bestOf = new Map();       // "title|film" -> how many best-ofs carry it
  const names = COMPOSERS.slice(0, COMPOSER_LIMIT);

  const noteBestOf = tracks => {
    for (const t of tracks) {
      if (t.wrapperType !== 'track') continue;
      const from = unpackFrom(t.trackName);
      if (!from) continue;
      const k = signalKey(from.title, from.film);
      bestOf.set(k, (bestOf.get(k) || 0) + 1);
    }
  };

  for (const composer of names) {
    const id = await artistIdFor(composer);
    if (!id) { console.log('  ' + composer.padEnd(24) + ' no artistId, skipped'); continue; }

    const { singles: sing, albums, albumTotal, bestOf: comps } = await albumsFor(id);
    sing.forEach(s => singles.add(signalKey(s.title, s.film)));

    let films = 0, songs = 0, comped = 0;
    for (let i = 0; i < albums.length; i++) {
      const res = await lookup(albums[i].collectionId, 'song', 200);
      const tracks = res.results || [];
      if (looksLikeCompilation(tracks)) { noteBestOf(tracks); comped++; continue; }
      const found = candidatesFrom(tracks, composer, albums[i].collectionName, i, albumTotal);
      candidates.push(...found);
      films++; songs += found.length;
    }

    // The composer's own best-ofs, expanded purely for signal.
    for (const c of comps.slice(0, 3)) {
      const res = await lookup(c.collectionId, 'song', 200);
      noteBestOf(res.results || []);
    }

    console.log('  ' + composer.padEnd(24) +
                String(films).padStart(3) + ' films ' +
                String(songs).padStart(4) + ' songs ' +
                String(sing.length).padStart(4) + ' singles ' +
                String(comps.slice(0, 3).length + comped).padStart(2) + ' best-of');
  }

  // Singer-seeded film songs join the same candidate pool rather than being
  // appended afterwards, so they compete on score, and songsPerFilm and the era
  // quotas govern them exactly as they govern everything else.
  if (SINGER_LIMIT > 0) {
    console.log('\n--- singers (film songs) ---');
    const filmComposer = new Map();
    for (const c of candidates) if (!filmComposer.has(c.nMovie)) filmComposer.set(c.nMovie, c.composer);
    const extra = await harvestSingers(filmComposer);
    const known = new Set(candidates.map(c => c.nTitle + '|' + c.nMovie));
    const fresh = extra.filter(c => !known.has(c.nTitle + '|' + c.nMovie));
    console.log('  ' + extra.length + ' film songs via singers, ' +
                fresh.length + ' of them new to the pool');
    candidates.push(...fresh);
  }

  return { candidates, singles, bestOf };
}

/* ------------------------------------------------------------------ */
/* Singer harvest (film songs, reached by who sang them)               */
/* ------------------------------------------------------------------ */

// Two requests per singer, and the exact mirror of harvestArtists below: that
// one throws away every film song it sees, this one keeps nothing else.
//
// filmComposer maps a film already found by the composer path to its composer,
// so a song arriving here for a film we already know inherits that composer and
// therefore lands in the same datePerFilm group. Films nobody seeded - the whole
// point of this path - fall back to the singer, which groups that singer's songs
// from one film together and is all the year rule needs.
async function harvestSingers(filmComposer) {
  const out = [];
  for (const name of SINGERS.slice(0, SINGER_LIMIT)) {
    const id = await artistIdFor(name);
    if (!id) { console.log('  ' + name.padEnd(22) + ' no artistId, skipped'); continue; }

    const res = await lookup(id, 'song', 200);
    const rows = (res.results || [])
      .filter(t => t.wrapperType === 'track' && t.kind === 'song');
    const span = Math.max(rows.length - 1, 1);
    const seen = new Set();
    let kept = 0;

    for (let i = 0; i < rows.length && kept < CONFIG.songsPerSinger; i++) {
      const t = rows[i];
      if (!t.previewUrl || !t.trackId) continue;
      if (!t.trackTimeMillis || t.trackTimeMillis < 60000) continue;

      // A film song announces itself one of two ways: the title carries
      // (From "Film") because it was lifted onto a single or compilation, or it
      // sits on the soundtrack album itself and the album name holds the film.
      const from = unpackFrom(t.trackName);
      const onSoundtrack = /original motion picture|soundtrack|music from/i
        .test(t.collectionName || '');
      if (!from && !onSoundtrack) continue;

      const title = tidyTitle(from ? from.title : t.trackName);
      const movie = from ? from.film : filmFromAlbum(t.collectionName);
      if (!title || !movie) continue;
      if (REMIX_ALBUM.test(t.collectionName || '') || BAD_ALBUM.test(t.collectionName || '')) continue;
      if (BAD_TITLE.test(title)) continue;
      if (NON_HINDI.test(title) || NON_HINDI.test(movie)) continue;
      if (!FILM_GENRE.test(t.primaryGenreName || '')) continue;

      const nTitle = norm(title), nMovie = norm(movie);
      const key = nTitle + '|' + nMovie;
      if (seen.has(key)) continue;
      seen.add(key);
      kept++;

      out.push({
        title: title.trim(),
        artist: cleanArtists(t.artistName, '') || t.artistName,
        movie: movie,
        trackId: t.trackId,
        nTitle, nMovie,
        trackNumber: t.trackNumber || 99,
        // Loses every dedup tie in select() on purpose. Where the composer path
        // already has this recording its copy is strictly better - real album
        // position, real composer - so this path only ever contributes songs
        // that path never reached.
        albumRank: 9999,
        // Apple returns an artist's songs most-prominent-first, which is the
        // same signal albumPct carries on the composer path, so the two score on
        // one scale rather than the singer path arriving unranked.
        albumPct: i / span,
        year: Number((t.releaseDate || '').slice(0, 4)) || 0,
        composer: filmComposer.get(nMovie) || name,
        seededAs: name,
      });
    }
    console.log('  ' + name.padEnd(22) + String(kept).padStart(3) + ' film songs');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Non-film harvest                                                    */
/* ------------------------------------------------------------------ */

// Two requests per artist, against ~27 for the film path, because there is no
// album to expand: the film path only walks albums to read the FILM out of the
// album name, and a single has no film to read. entity=song on an artistId
// returns the tracks directly.
//
// No scoring either. Selection under scarcity is what the whole film pipeline
// exists for - which 300 of 7,576, and how to keep one era from taking them
// all. Here the artists are named deliberately and we want their catalogue, so
// there is nothing to select: take the first songsPerArtist that survive the
// quality filters, in Apple's own order, which puts an artist's prominent
// releases first.
async function harvestArtists() {
  const out = [];
  for (const name of ARTISTS.slice(0, ARTIST_LIMIT)) {
    const id = await artistIdFor(name);
    if (!id) { console.log('  ' + name.padEnd(22) + ' no artistId, skipped'); continue; }

    const res = await lookup(id, 'song', 200);
    const seen = new Set();
    const kept = [];

    for (const t of res.results || []) {
      if (kept.length >= CONFIG.songsPerArtist) break;
      if (t.wrapperType !== 'track' || t.kind !== 'song') continue;
      if (!t.previewUrl || !t.trackId) continue;
      if (!t.trackTimeMillis || t.trackTimeMillis < 60000) continue;

      // Indie artists put out acoustic cuts, lofi flips and remixes constantly,
      // so this filter does far more work here than on the film path.
      const title = tidyTitle(t.trackName);
      if (!title || BAD_TITLE.test(title)) continue;
      if (NON_HINDI_LOOSE.test(title) || NON_HINDI_LOOSE.test(t.collectionName || '')) continue;
      if (NON_FILM_BAD_GENRE.test(t.primaryGenreName || '')) continue;
      // unpackFrom below is anchored to the END of the name, and tidyTitle
      // strips trailing decoration only AFTER that test - so
      //   Garmi (From "Street Dancer 3D") [feat. Neha Kakkar]
      // failed the film check, then tidied down to something that looked like a
      // single and shipped with an empty movie. Two identities for one recording
      // is the bug this whole guard exists to prevent, so catch the phrase
      // wherever it sits rather than only at the end.
      if (SAYS_FROM.test(title)) continue;

      // These artists sing on soundtracks too - Raghav Chaitanya is on Animal,
      // and seeding him pulled Hua Main in here as though it had no film. A
      // film song reached through the artist path is still a film song: the
      // film path already has it, correctly labelled, so drop it rather than
      // shipping the same recording twice under two different identities.
      if (unpackFrom(t.trackName)) continue;
      if (/original motion picture|soundtrack|music from/i.test(t.collectionName || '')) continue;

      // The same recording is a single, an album track and a compilation track
      // under three different trackIds. Keyed by title+artist, not title+film:
      // there is no film.
      const artist = cleanArtists(t.artistName, '') || t.artistName;
      const key = norm(title) + '|' + norm(artist);
      if (seen.has(key)) continue;
      seen.add(key);

      kept.push({
        title: title.trim(),
        artist,
        movie: '',                 // no film - this IS the non-film marker
        trackId: t.trackId,
        nTitle: norm(title),
        nMovie: '',
        year: Number((t.releaseDate || '').slice(0, 4)) || 0,
        seededAs: name,
      });
    }

    out.push(...kept);
    console.log('  ' + name.padEnd(22) + String(kept.length).padStart(3) + ' songs');
  }
  return out;
}

// A playback singer's own catalogue includes the film songs they sang on, and
// Apple does not always label those as soundtracks - Hua Main came back through
// Raghav Chaitanya with no film attached, so it shipped twice: once correctly
// as ANIMAL and once as a non-film single. Two identities for one recording
// means guessing the right film scores WRONG, which is worse than missing the
// song entirely.
//
// Same title AND a shared performer means same song. Title alone is not enough
// and must not be used: AUR's Shayad and Love Aaj Kal's Shayad really are two
// different songs, and so are Zaeden's Tere Bina and Guru's.
function dropFilmDuplicates(indie, film) {
  const byTitle = new Map();
  for (const f of film) {
    if (!byTitle.has(f.nTitle)) byTitle.set(f.nTitle, new Set());
    f.artist.split(/,\s*/).forEach(a => byTitle.get(f.nTitle).add(norm(a)));
  }
  return indie.filter(s => {
    const performers = byTitle.get(s.nTitle);
    if (!performers) return true;
    return !s.artist.split(/,\s*/).some(a => performers.has(norm(a)));
  });
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

// Matched on title AND film, so two different films' Tere Bina never pool each
// other's evidence - which is the same rule the game itself plays by.
//
// The signal is BINARY. Counting best-of appearances ranked Daawat-e-Ishq and
// Kill Dil above the entire canon: a composer's best-of is a signal relative to
// that composer, so for one whose whole catalog is mid-tier it promotes mid-tier
// songs into a global ordering. Appearing on three of Sachin-Jigar's samplers
// does not make a song better known than Tum Hi Ho.
//
// The dedicated-single signal used to be the heaviest term here, and measuring
// it killed it - see the note on scoring below. It is still harvested because
// it costs nothing (the album list names singles outright), and it still marks
// a song as a lead release; it just cannot carry weight in a global ordering.
function popularity(song, signals) {
  const key = song.nTitle + '|' + song.nMovie;
  const single = signals.singles.has(key) ? 1 : 0;
  const bestOf = (signals.bestOf.get(key) || 0) > 0 ? 1 : 0;
  return { single, bestOf, known: single + bestOf > 0 };
}

// Ties are the norm, not the exception - most songs score the same handful of
// points. Breaking them by title sorted the tail alphabetically and truncated
// the catalog mid-alphabet: every song from K onward at the cut score was
// dropped. Break them by a hash of the trackId instead, which is arbitrary but
// unbiased and stable across runs.
function jitter(trackId) {
  let h = trackId >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Apple's date is the release of THIS pressing, so a 1975 song on a 2015
// reissue reads 2015. Across a whole crawl the same film usually turns up in
// several pressings, and the earliest of them is the closest thing to the
// film's own year that these responses contain. It is still only a floor - a
// film whose every pressing is a reissue stays late - but it is what stops
// reissued classics from being counted as new releases.
//
// Keyed on film AND composer, never the film name alone. Hindi cinema reuses
// titles relentlessly across generations, and a bare name merges the remakes:
// Dilwale is Nadeem-Shravan in 1993 and Pritam in 2015, Guru is Bappi Lahiri in
// 1988 and Rahman in 2006, Lootera is Laxmikant-Pyarelal in 1965 and Amit
// Trivedi in 2013. Merged, the modern film inherits the older one's year and its
// songs are backdated a whole era - Manma Emotion Jaage filed itself under
// pre-2000. Since the crawl walks one composer at a time, the composer is
// exactly the discriminator needed; the only case it still merges is a remake
// scored by the same person, which is rare enough to live with.
function datePerFilm(candidates) {
  const key = c => c.nMovie + '|' + c.composer;
  const earliest = new Map();
  for (const c of candidates) {
    if (!c.year) continue;
    const seen = earliest.get(key(c));
    if (!seen || c.year < seen) earliest.set(key(c), c.year);
  }
  for (const c of candidates) c.year = earliest.get(key(c)) || c.year;
}

const decadeOf = s => (s.year ? Math.floor(s.year / 10) * 10 : 0);

// Built on first use so it does not depend on where norm() sits in this file.
const rejectedKeys = new Set();
function isRejected(s) {
  if (!rejectedKeys.size) {
    REJECTED.forEach(pair => rejectedKeys.add(norm(pair[0]) + '|' + norm(pair[1])));
  }
  return rejectedKeys.has(s.nTitle + '|' + s.nMovie);
}

function select(candidates, signals) {
  // Dropped before scoring rather than after selection, so the era quota refills
  // with the next song down instead of the catalog simply shrinking.
  candidates = candidates.filter(c => !isRejected(c));
  datePerFilm(candidates);

  // One entry per song. Reissues and deluxe editions carry the same recording
  // under different trackIds; the earliest album wins, which is the original.
  const byIdentity = new Map();
  for (const c of candidates) {
    const key = c.nTitle + '|' + c.nMovie;
    const kept = byIdentity.get(key);
    if (!kept || c.albumRank < kept.albumRank) byIdentity.set(key, c);
  }

  const scored = [...byIdentity.values()].map(c => {
    const pop = popularity(c, signals);
    return Object.assign(c, {
      // POSITION is the load-bearing signal, not the release-shaped ones.
      //
      // The dedicated single used to be weighted 6, above everything else, on
      // the theory that labels only cut singles for songs they are pushing.
      // Measured against a canon list, that is not merely weak - it is
      // ANTI-correlated. Only 124 of 2703 candidates carry a single, and they
      // are the modern promotional drip where a label cuts one per track:
      // Sachin-Jigar 31% of songs, Tanishk Bagchi 14%, against 0% for
      // Jatin-Lalit, Laxmikant-Pyarelal and Shankar Jaikishan. Not one of Tum
      // Hi Ho, Kabira, Channa Mereya, Gerua, Badtameez Dil or Deewani Mastani
      // has one. Weighting it heaviest bought Chingam Chabake and Illegal
      // Weapon 2.0 at the cost of the entire canon: 27% recall.
      //
      // Position survives the same test. A soundtrack opens with the song the
      // film is selling, and Apple lists a composer's albums big-film-first, so
      // both fall away smoothly rather than firing on an arbitrary subset - and
      // neither is an artifact of the release era, which is what made the
      // single useless across a catalog spanning the 1950s to now. Ordering by
      // them lifts recall to 44%, which is about the ceiling: songsPerFilm caps
      // Yeh Jawaani Hai Deewani at 3 and it has four canon songs.
      //
      // Album position is scored as a PERCENTILE of the composer's catalog, not
      // an absolute index. An absolute one has a cliff at albumsPerComposer, and
      // everything past it scores identically - which meant that widening the
      // crawl to reach Brahmastra harvested it and then ranked it last.
      pop,
      score: Math.round(pop.bestOf * 8 +
                        (1 - c.albumPct) * 60 +
                        (12 - Math.min(c.trackNumber, 12)) * 4),
    });
  });

  scored.sort((a, b) => b.score - a.score || jitter(a.trackId) - jitter(b.trackId));

  // Each era draws from the same ranking but fills its own quota, so a prolific
  // era cannot spend another's slots. songsPerFilm is global - three Yeh Jawaani
  // Hai Deewani songs is three whatever era is asking - while songsPerComposer
  // is per era, so Pritam can appear across four of them without owning any one.
  const perFilm = new Map();
  const chosen = [];
  for (const era of ERAS) {
    const perComposer = new Map();
    let taken = 0;
    for (const s of scored) {
      if (taken >= era.quota) break;
      if (s.year < era.from || s.year > era.to) continue;
      const f = perFilm.get(s.nMovie) || 0;
      if (f >= CONFIG.songsPerFilm) continue;
      const c = perComposer.get(s.composer) || 0;
      if (c >= CONFIG.songsPerComposer) continue;
      perFilm.set(s.nMovie, f + 1);
      perComposer.set(s.composer, c + 1);
      s.era = era.name;
      chosen.push(s);
      taken++;
    }
    era.filled = taken;
  }
  return chosen;
}

/* ------------------------------------------------------------------ */
/* Emit                                                                */
/* ------------------------------------------------------------------ */

const MARKER = 'window.BOLLYWOOD_SONGS = [';

// Everything below this line is regenerated. Without it a second run would read
// its own last output back as hand-curated seed songs and the catalog would
// only ever grow - re-running with different rules has to REPLACE the harvest,
// not accumulate on top of it.
const FENCE = '  // ---- generated by build/harvest.js; edits below are overwritten ----';

// The hand-verified songs above the fence, which the harvester never discards.
function seedCatalog(html) {
  const start = html.indexOf(MARKER);
  const end = html.indexOf('\n];', start);
  let body = html.slice(start + MARKER.length, end);
  const fence = body.indexOf(FENCE.trim());
  if (fence !== -1) body = body.slice(0, fence);
  const out = [];
  const re = /\{\s*title:\s*("(?:[^"\\]|\\.)*")\s*,\s*artist:\s*("(?:[^"\\]|\\.)*")\s*,\s*movie:\s*("(?:[^"\\]|\\.)*")\s*(?:,\s*trackId:\s*(\d+))?/g;
  let m;
  while ((m = re.exec(body))) {
    out.push({
      title: JSON.parse(m[1]), artist: JSON.parse(m[2]), movie: JSON.parse(m[3]),
      trackId: m[4] ? Number(m[4]) : undefined,
      nTitle: norm(JSON.parse(m[1])), nMovie: norm(JSON.parse(m[3])),
    });
  }
  return out;
}

function render(songs) {
  return songs.map(s =>
    '  { title: ' + JSON.stringify(s.title) +
    ', artist: ' + JSON.stringify(s.artist) +
    ', movie: ' + JSON.stringify(s.movie) +
    ', trackId: ' + s.trackId + ' },'
  ).join('\n');
}

function write(seeds, harvested) {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const start = html.indexOf(MARKER);
  const end = html.indexOf('\n];', start);
  if (start === -1 || end === -1) throw new Error('could not find the catalog array in ' + TEMPLATE);
  const body = render(seeds) + '\n\n' + FENCE + '\n' + render(harvested);
  fs.writeFileSync(TEMPLATE, html.slice(0, start + MARKER.length) + '\n' + body + html.slice(end));
}

/* ------------------------------------------------------------------ */

(async function main() {
  if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

  console.log('\n--- films by composer ---');
  const { candidates, singles, bestOf } = await harvest();
  console.log('  ' + candidates.length + ' candidate songs, ' +
              singles.size + ' single releases, ' + bestOf.size + ' best-of appearances');

  console.log('\n--- selection ---');
  const chosen = select(candidates, { singles, bestOf });

  // The hand-verified seeds stay in, whatever the harvest thinks of them.
  const seeds = seedCatalog(fs.readFileSync(TEMPLATE, 'utf8')).filter(s => s.trackId);
  const seen = new Set(seeds.map(s => s.nTitle + '|' + s.nMovie));
  const seenIds = new Set(seeds.map(s => s.trackId));
  const kept = [];
  for (const s of chosen) {
    const key = s.nTitle + '|' + s.nMovie;
    if (seen.has(key) || seenIds.has(s.trackId)) continue;
    seen.add(key); seenIds.add(s.trackId);
    kept.push(s);
  }
  // The non-film half. Appended after the film songs rather than mixed in, so
  // the generated block reads film-then-not and a diff stays legible.
  let indie = [];
  if (!FILM_ONLY) {
    console.log('\n--- non-film artists ---');
    const raw = await harvestArtists();
    const deduped = dropFilmDuplicates(raw, seeds.concat(kept));
    indie = deduped.filter(s => {
      if (isRejected(s)) return false;
      const key = s.nTitle + '|' + s.nMovie;
      if (seen.has(key) || seenIds.has(s.trackId)) return false;
      seen.add(key); seenIds.add(s.trackId);
      return true;
    });
    console.log('  ' + indie.length + ' non-film songs from ' +
                new Set(indie.map(s => s.seededAs)).size + ' artists' +
                (raw.length - deduped.length
                  ? ' (' + (raw.length - deduped.length) + ' dropped as film songs in disguise)' : ''));
  }

  if (DUMP) {
    fs.writeFileSync(DUMP, JSON.stringify(chosen.map(s => ({
      title: s.title, movie: s.movie, trackId: s.trackId, score: s.score,
      year: s.year, composer: s.composer, trackNumber: s.trackNumber,
      albumPct: Math.round(s.albumPct * 100) / 100,
    })), null, 1));
    console.log('  dumped ' + chosen.length + ' scored songs to ' + DUMP);
  }

  const merged = seeds.concat(kept, indie);

  console.log('\n  ' + merged.length + ' songs (' + seeds.length + ' seeds + ' +
              kept.length + ' film + ' + indie.length + ' non-film)');
  console.log('  ' + chosen.filter(s => s.trackNumber <= 3).length + ' of ' + chosen.length +
              ' chosen open their soundtrack; ' +
              chosen.filter(s => s.pop.bestOf).length + ' are on a best-of');
  console.log('  ' + new Set(merged.map(s => s.nMovie)).size + ' distinct films');
  console.log('  ' + requests + ' requests this run');

  console.log('\n  era quotas (short means the pool ran out, not that it was capped):');
  ERAS.forEach(e => console.log('    ' + e.name.padEnd(10) +
    String(e.filled).padStart(4) + ' / ' + String(e.quota).padEnd(5) +
    (e.filled < e.quota ? ' SHORT by ' + (e.quota - e.filled) : '') ));

  ERAS.filter(e => e.filled).forEach(e => {
    const inEra = chosen.filter(s => s.era === e.name);
    console.log('\n  ' + e.name + ' — best 8 and worst 4 of ' + inEra.length + ':');
    inEra.slice(0, 8).forEach(s =>
      console.log('    ' + String(s.score).padStart(3) + '  ' + String(s.year) + '  ' +
                  s.title + ' — ' + s.movie));
    if (inEra.length > 12) inEra.slice(-4).forEach(s =>
      console.log('    ' + String(s.score).padStart(3) + '  ' + String(s.year) + '  ' +
                  s.title + ' — ' + s.movie));
  });

  const bucket = (list, keyOf) => {
    const m = new Map();
    list.forEach(s => m.set(keyOf(s), (m.get(keyOf(s)) || 0) + 1));
    return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };

  // Both halves, because what a player actually meets is the whole pool - and
  // the non-film half is almost entirely recent, which shifts the real balance
  // well past what the film quotas alone suggest.
  const shipped = chosen.concat(indie);
  console.log('\n  by decade, whole catalog (earliest pressing seen, so classics read late):');
  bucket(shipped, s => (s.year ? Math.floor(s.year / 10) * 10 + 's' : 'unknown'))
    .forEach(([d, n]) => console.log('    ' + String(d).padEnd(9) +
      String(n).padStart(4) + '  ' + '#'.repeat(Math.round(n / 8))));
  const recent = shipped.filter(s => s.year >= 2010).length;
  console.log('    post-2010: ' + recent + ' of ' + shipped.length +
              ' (' + Math.round(100 * recent / shipped.length) + '%)');

  console.log('\n  by composer:');
  bucket(chosen, s => s.composer).sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => console.log('    ' + c.padEnd(24) + String(n).padStart(3)));

  const dupes = {};
  const counts = {};
  merged.forEach(s => { counts[s.nTitle] = (counts[s.nTitle] || 0) + 1; });
  Object.keys(counts).filter(k => counts[k] > 1).forEach(k => (dupes[k] = counts[k]));
  const dupeKeys = Object.keys(dupes);
  console.log('\n  ' + dupeKeys.length + ' titles appear in more than one film' +
              (dupeKeys.length ? ': ' + dupeKeys.slice(0, 8).join(', ') : ''));

  if (DRY) { console.log('\n  --dry, nothing written\n'); return; }
  write(seeds, kept.concat(indie));
  console.log('\n  wrote ' + seeds.length + ' seeds + ' + kept.length + ' film + ' +
              indie.length + ' non-film to src/template.html\n');
})().catch(e => {
  console.error(e);
  process.exit(1);
});

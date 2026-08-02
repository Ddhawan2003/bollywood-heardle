# Filmi — guess the Bollywood song

A Heardle/Songless-style guessing game for Hindi film music. You hear half a
second of a song and name it; every wrong guess or skip unlocks more audio
(0.5s → 1s → 2s → 4s → 8s → 16s), six attempts total.

Audio comes from the free **iTunes Search API** — no key, no auth, no backend.

![six guess rows, a segmented waveform, and a central play button](docs/play.png)

## Play it

Open `bollywood-heardle.html` in any browser. That's the whole install — one
self-contained file, no build step, no server.

It needs an internet connection to reach Apple for previews. With no network it
falls back to synthesised stand-in audio so the interface is still explorable,
and says so plainly on every screen.

## Why one file with everything inlined

The game is also published as a claude.ai Artifact, which runs under a CSP that
blocks requests to **every** external host. A CDN `<script>` for React or a
linked Google Font would silently fail there. So React and the display face
(Anton) are inlined at build time, and the page makes zero subresource requests.
`build.ps1` fails the build if that ever stops being true.

The same CSP blocks Apple, which is why the hosted Artifact has no real songs —
that limitation is the sandbox, not the code. Run the local file for real audio.

## Adding songs

The catalog is a plain array at the very top of `src/template.html` (character
offset ~1700, deliberately above the vendor blobs so it stays easy to find):

```js
{ title: "Kesariya", artist: "Arijit Singh", movie: "Brahmastra", trackId: 1648663570 },
```

Order matters only in that a song's position is its `uid` for the session;
appending is always safe. `trackId` is optional but strongly recommended. **Filmi search is dirty** and a
plain term search regularly returns the wrong recording:

- *Tum Hi Ho* has a **remix** ranked directly behind the original.
- *Senorita* is spelled **Señorita** on Apple Music, so an ASCII search returns
  a completely different song (*Ik Junoon (Paint It Red)*).
- Soundtracks are full of `(Encore)`, `(Reprise)`, Bhojpuri versions and mashups.

The 18 seed songs were resolved and verified by hand. Songs added without a
`trackId` fall back to a scored search that penalises remix/unplugged/cover/
karaoke and rewards `Original Motion Picture Soundtrack` — usually right, not
guaranteed. Find an id with:

```
https://itunes.apple.com/search?term=YOUR+SONG&entity=song&country=IN
```

For adding songs by the hundred rather than one at a time, see below.

## Harvesting the catalog

`build/harvest.js` rewrites the catalog array from the iTunes API. It is run by
hand, never as part of a build — it takes half an hour and hits Apple a few
hundred times.

```
node build/harvest.js               harvest, then rewrite the catalog
node build/harvest.js --dry         harvest and report, write nothing
node build/harvest.js --target 300  how many songs to keep
node build/harvest.js --composers 4 stop after N composers (a smoke run)
```

Bollywood ships in soundtrack albums, so the catalog scales by harvesting
**films, not songs**. Seeded with two dozen music directors spanning the 60s to
now: composer → `artistId` → up to 200 albums → expand each. Roughly one
request per film, ~8–10 songs per film.

**An album's own tracks say what kind of album it is.** A compilation labels
every track with where it came from — `Tere Bina (From "Guru")` — and a
soundtrack has no need to. So albums are classified after expansion rather than
by name, and a compilation's songs become popularity *signal* instead of
catalog candidates.

Popularity matters because the harvest finds ~2,700 songs and the game ships
300, so *something* has to choose — and 300 uniformly obscure songs is a
vocabulary test, not a game. What ranks them is **position**: where a song sits
on its soundtrack, and where that soundtrack sits in Apple's ordering of the
composer's albums. A soundtrack opens with the song the film is selling, and
Apple lists a composer's big films first. An appearance on the composer's own
best-of is a smaller bonus on top.

Both caps that follow — 3 songs per film, 18 per composer — exist to stop two
prolific composers eating the catalog and skewing it modern.

### What didn't work

Two better-sounding theories were measured here and both lost.

**Counting *Various Artists* "Bollywood Hits" compilation appearances**, on the
theory that hits get repackaged endlessly and deep cuts never do. What Apple's
India store returns for those searches is party/workout sets and small-label
re-recordings (`Bollywood Hits (Versi Melayu)`, `Best Of Bollywood LO-FI`, and
one jazz album). Of 310 harvested candidates, exactly **3** matched — none of
them *Tum Hi Ho*, *Kabira* or *Channa Mereya*.

**Ranking by a dedicated single release** (`Kesariya (From "Brahmastra") -
Single`), on the theory that labels only cut singles for songs they are pushing.
This was the heaviest term in the score until it was measured against a canon
list, and it is not merely weak — it is *anti-correlated*. Only 124 of 2,703
candidates carry a single, and they are the modern promotional drip where a
label cuts one per track: 31% of Sachin-Jigar's songs and 14% of Tanishk
Bagchi's, against 0% for Jatin-Lalit, Laxmikant-Pyarelal and Shankar Jaikishan.
Not one of *Tum Hi Ho*, *Kabira*, *Channa Mereya*, *Gerua*, *Badtameez Dil* or
*Deewani Mastani* has one. It was measuring release era, not fame, which is
fatal for a catalog spanning the 1950s to now — weighting it heaviest bought
*Chingam Chabake* and *Illegal Weapon 2.0* at the cost of the canon (27% recall
against 44% for position). The signal is still harvested, because the album list
names singles for free, but it no longer scores.

The pattern in both: a signal has to be comparable *across* composers and eras
to order a catalog that spans them. Position is; release packaging isn't.

## Build and test

```powershell
pwsh build/build.ps1           # src/template.html -> bollywood-heardle.html
pwsh build/build.ps1 -Verify   # build, then run both suites
```

```
test/test.js           53 checks — rules, normalisation, song identity, variant
                       scoring, simulated games, and LIVE iTunes resolution over
                       JSONP: the whole catalog batched, and single songs by the
                       runtime path
test/test-offline.js   12 checks — simulates a CSP refusal; asserts both
                       resolution paths degrade in under 2s instead of hanging
test/test-ui.js        47 checks — drives the real App component through whole
                       rounds against a hand-rolled React. Blocked scenario: a
                       fixture catalog with a deliberate title collision.
                       Online scenario: lookups answer for real and one song is
                       deliberately preview-less, covering lazy resolution,
                       prefetch, and the dud-song reroll
```

`test.js` hits the real API, so it needs a network connection and will fail if
Apple is unreachable. Both suites run the actual shipped source: they extract the
app IIFE straight out of `src/template.html` and execute it against stubbed
DOM/React globals, so they cannot drift from what ships.

## How the audio works

`fetch()` to `itunes.apple.com` is blocked by CORS — Apple sends no
`Access-Control-Allow-Origin`. The API does support **JSONP**, so the app appends
`&callback=fn` and injects a `<script>`. Script tags aren't subject to the
same-origin policy, so this works from `file://` and from any host. Verified:
both `/search` and `/lookup` return `text/javascript` with the callback wrapper.

Previews resolve **one song at a time**, as rounds need them — a round needs one
`previewUrl`, so resolving the catalog to play a single song is work that scales
with the catalog for no gain. The page makes exactly one request on its own: a
prefetch of one song at load, which makes the first round instant and settles
whether we are in demo mode in time for the badge to be on the start screen.
After that each round resolves the *next* song in the background while you
guess, so the lookup is already done by the time you click "Next song".

Cost is flat: **one small request per round**, no matter how big the catalog
gets. A song that resolves but has no preview is marked dead and re-dealt; a
request that *fails* is a different thing entirely and puts the session into
demo mode.

Snippet length is enforced by driving `currentTime` against a
`requestAnimationFrame` loop and pausing at the limit.

Apple's terms require the track link wherever their previews are used, so
`trackViewUrl` is rendered as "Listen on Apple Music" on every reveal,
win or lose.

## Song identity

Nothing keys off a title. `buildCatalog()` stamps every entry with a `uid` (its
catalog index) and precomputed `nTitle` / `nMovie`, and the preview cache, the
played-set, the waveform seed and the win check all use `uid`.

This matters because Hindi titles collide across films — *Tere Bina*, *Zaalima*,
*Bekhayali* each exist in more than one. Keying by title would both collide in
the preview cache and mark you correct for naming a **different film's song of
the same name**. When a title is ambiguous the typeahead refuses a hand-typed
answer and makes you pick a row (every row shows its film), and the guess row
then reads `Tere Bina · Bombay` so a wrong answer cannot be mistaken for a win.

## Scaling notes

Measured limits, for anyone pushing this further:

- `lookup?id=<collectionId>&entity=song` returns a complete OST in **one**
  request (9 tracks for *Yeh Jawaani Hai Deewani*).
- `lookup?id=<artistId>&entity=album` returns up to **200** albums in one.
- `/lookup` accepts **200 ids per batch** — so verifying a 300-song catalog
  against the live API costs two requests, which is why `test.js` can afford to
  do it on every run.
- Apple's soft rate limit is ~20 requests/minute; past it you get a `403` and
  the harvester backs off for a minute.

Beyond a few thousand songs the remaining lever is difficulty: the popularity
score the harvester already computes is the natural dial for tiers, eras, or
music-director filters.

## Layout

```
bollywood-heardle.html   built, playable — this is the deliverable
src/template.html        source; song catalog at the top, app JS at the bottom
vendor/                  React 18.3.1 UMD + Anton woff2 (base64), inlined at build
build/build.ps1          assembly + self-containment checks
build/harvest.js         rebuilds the song catalog from the iTunes API
test/                    node test suites
```

## Attribution

Previews and artwork come from the Apple iTunes Search API. Not affiliated with
Apple. All songs belong to their respective rights holders.

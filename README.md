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

Every one of the 18 seed songs was resolved and verified by hand. Songs added
without a `trackId` fall back to a scored search that penalises
remix/unplugged/cover/karaoke and rewards `Original Motion Picture Soundtrack` —
usually right, not guaranteed. Find an id with:

```
https://itunes.apple.com/search?term=YOUR+SONG&entity=song&country=IN
```

## Build and test

```powershell
pwsh build/build.ps1           # src/template.html -> bollywood-heardle.html
pwsh build/build.ps1 -Verify   # build, then run both suites
```

```
test/test.js           45 checks — rules, normalisation, song identity, variant
                       scoring, simulated games, and a LIVE iTunes resolution
                       over JSONP
test/test-offline.js    9 checks — simulates a CSP refusal; asserts the app
                       degrades in under 2s instead of hanging
test/test-ui.js        21 checks — drives the real App component through a
                       round against a hand-rolled React, on a fixture catalog
                       with a deliberate title collision
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

All 18 pinned ids resolve in a **single** batched `/lookup` request. Snippet
length is enforced by driving `currentTime` against a `requestAnimationFrame`
loop and pausing at the limit.

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

## Known issues

**The whole catalog resolves at load.** Fine for 18 songs in one batched request;
wrong above a few hundred. Should become lazy — resolve the answer song plus a
small prefetch, since autocomplete needs only baked titles and no network.

## Scaling notes

Bollywood songs ship in film soundtrack albums, so the catalog scales by
**harvesting films, not songs**: `lookup?id=<collectionId>&entity=song` returns a
complete OST in one request (measured: 9 tracks for *Yeh Jawaani Hai Deewani*),
and `/lookup` accepts **200 ids per batch** (measured). That's ~2 requests per
film, ~8–10 songs per film — roughly 700 requests for 3,000 songs, a ~35 minute
one-off build script at Apple's ~20 req/min soft limit.

The hard part is curation, not collection: dedup on normalised title + primary
artist, filter variants and sub-60s tracks, and derive a popularity score by
counting how many distinct compilation albums a song appears on (hits get
re-packaged endlessly, deep cuts never do). Popularity then becomes the
difficulty dial — tiers, eras, or music-director filters — because 3,000
uniformly obscure songs is a vocabulary test, not a game.

## Layout

```
bollywood-heardle.html   built, playable — this is the deliverable
src/template.html        source; song catalog at the top, app JS at the bottom
vendor/                  React 18.3.1 UMD + Anton woff2 (base64), inlined at build
build/build.ps1          assembly + self-containment checks
test/                    node test suites
```

## Attribution

Previews and artwork come from the Apple iTunes Search API. Not affiliated with
Apple. All songs belong to their respective rights holders.

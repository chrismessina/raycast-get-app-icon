# Agent Guidelines for Get App Icon

> Instructions for AI coding assistants working on this codebase.

Get App Icon lists every application installed on the Mac and hands you its icon: exported
to disk at one size, a chosen size, or all eight, as PNG / JPEG / ICNS — or copied straight
to the clipboard. One `view` command, rendered as either a List or a Grid.

## Before Making Changes

There is no `docs/` directory and no `CONCEPTS.md` here. **The mechanism comments in
`src/icon-cache.ts` are the documentation**, and most of them exist because the obvious
alternative shipped and was wrong. A comment saying "kept distinct because collapsing any
two of them was a real bug" is a receipt, not a style note — read the block before changing
the code under it, and `git log -p` the file when a comment's reasoning is not obvious.

Fleet-wide conventions live in
`/Users/messina/Developer/GitHub/chrismessina/raycast-extension-workflows/plugins/raycast-extensions/reference/house-style.md`
and are not restated here.

## The trap: reintroducing a comparison into cache freshness

A large cluster of this repo's commits addresses cache freshness and its concurrency
consequences. Freshness of a cached grid icon
used to be *inferred* — stat the cache entry, stat six source paths, read a `.blind`
sidecar, compare them. A run of fix-to-fix commits each moved the failure somewhere else
rather than fixing it (`e3cf7d3` → `ba135ef` → `4bbeaf1` → `67305d9` → `70a917b` →
`9adf786`): an aborted extraction committing a marker, a concurrent refresh resurrecting
one, an export deleting the entry mid-check. `b36a20a` names the pattern: each of those
fixes only chose a different linearization point, and the failures migrated instead of
converging — the signature, in its words, of a wrong shape rather than a wrong line. Every
read is a separate syscall, so correctness depended on their order.

`b36a20a` deleted the whole mechanism. **An entry is now named for the source state it was
drawn from:**

```text
<sha256(appPath)>-<sha256(CACHE_ICON_SIZE, appPath, ordered stamp states)>.png
```

`cacheKey` (`src/icon-cache.ts:242`). "Is the cache fresh?" collapses to "does this exact
file exist?" — one `stat`, no comparison, no sidecar, nothing whose order can be wrong.
Changed sources hash to a name nobody has written; unchanged sources hash to the one already
there; a deleted entry is a miss by definition. Two windows observing the same state compute
the same name and write identical bytes, so the concurrency bugs are not fixed, they are
inexpressible.

**If you find yourself stat'ing a cache entry to compare it against something, stop.** That
is the shape that was removed. Four rules hold it in place, all of which have already been
violated once:

- **Hash the whole ordered vector, never a `max()`.** A maximum discards *which* path moved
  and runs backwards when the newest stamp disappears.
- **Three stamp states, not two** — `stampState` (`src/icon-cache.ts:220`) returns an mtime,
  `"absent"`, or `"unreadable"`. *Absent* is the ordinary shape of an Asset Catalog app with
  no `.icns`. *Unreadable* is **no information**, and needs its own token: folding it into
  `absent` lets an in-place update hide behind an unchanged bundle root (reproduced with the
  bundle at mode 000), and the previous attempt at a sentinel — `Infinity` — made every entry
  stale forever and relaunched the extractor on every grid visit. Both shipped.
- **Every path in `iconStampPaths` (`src/icon-cache.ts:146`) covers a change the others miss.**
  Dropping one silently stops detecting a real class of icon update: the bundle root misses
  in-place updates entirely, the directories miss byte-level overwrites, and the payload files
  cover exactly that. Sampling `CFBundleIconFile` was added late (`00e92f8`) after measuring
  that **150 of 327 installed apps declare a non-conventional name** — Code.icns, app.icns,
  icon.icns — so nearly half the machine could hold a stale icon indefinitely.
- **`declaredIconFile` (`src/icon-cache.ts:188`) must abstain, never guess.** Its answer hashes
  into the key, so a *wrong* name is strictly worse than no name: it stamps a file that does not
  exist and masks changes to the one that does. Returning `null` is always safe. It refuses a
  value carrying an unknown entity or a path separator, and strips XML comments before matching,
  because all four of those shapes returned plausible-but-wrong values when probed (`e22604c`).

## The second trap: pruning a file something is still rendering

State-addressed names mint a new entry every time an app's icon sources move, so
`pruneIconCache` (`src/icon-cache.ts:419`) has to collect superseded ones — and it broke three
times, each on a different holder of a name that is no longer "live":

1. **This grid's own tiles.** A rendered name stops being live the moment the app changes, so
   prune deleted the file under the tile. Fixed by passing rendered entries as `inUse` — and
   pinned at *publish* time (`src/get-app-icon.tsx:679`), not after extraction, because an
   abort in between left nothing pinned.
2. **An abandoned visit.** Prune sat on the success path behind three early returns, so leaving
   the grid skipped collection entirely. It now runs in `finally` (`src/get-app-icon.tsx:726`).
   Measured motivation: 33 of 327 apps changed within a day, so a churny session stranded tens
   of MB.
3. **Another Raycast window.** `inUse` only covers this process, and nothing here can see the
   other one's state. Deliberately answered with an **age gate**, not coordination:
   `SUPERSEDED_GRACE_MS` (15 minutes, `src/icon-cache.ts:34`) spares recently-written entries,
   because a superseded entry can only be on screen somewhere if a view resolved it before the
   app changed. A lock or an in-use registry would reintroduce exactly the cross-process mutable
   state this cache was rewritten to remove, and would have to survive a crash to be worth
   anything. Do not "improve" this into a lock.

`.tmp-*` siblings are never touched — they belong to an extraction possibly still running in
another window.

## Things that look redundant and are not

- **Two Swift extractors, on purpose.** `EXTRACTOR_SWIFT` (`src/icon-cache.ts:46`) is a batched
  one-shot extractor: one `xcrun swift` launch per refresh, awaited to exit (~1s of launch,
  versus ~20ms of actual work per icon), reads
  `appPath outPath` job pairs from stdin, both base64 so no path can forge a record separator,
  and prints **exactly one line per input line on every path** — the caller counts `done` lines
  to drive the progress toast, so a silent skip desyncs it. `extractAppIconToFile`
  (`src/get-app-icon.tsx:200`) is a one-shot for export and clipboard that interpolates paths
  into a Swift string literal via `escapeStringLiteral`. Merging them would either drop the
  stdin protocol or hand the batch path an injection surface it currently does not have.
- **Two `CFBundleIconFile` readers, on purpose.** `declaredIconFile` reads the plist text and
  abstains on ambiguity (its answer feeds the cache key). `findIcnsPath`
  (`src/get-app-icon.tsx:223`) shells out to `plutil` and falls back to `AppIcon`, because its
  answer feeds the ICNS export, where being wrong means "no `.icns`, try PNG" — a user-facing
  message, not a corrupted key. Different consequences, different strictness.
- **The cache is display-only, and grid-only.** `NSWorkspace.icon(forFile:)` returns an image
  whose *nominal* size is 32pt, which Raycast's `fileIcon` renders at — fine for a list row
  (`src/get-app-icon.tsx:781`), soft when a grid tile blows it up to ~128pt. That is the entire
  reason this cache exists. Exports and copies always read the live bundle; a successful export
  calls `invalidateCachedIcon` (`src/get-app-icon.tsx:394`), which sweeps *every* entry for the
  app by prefix, since an entry written under an earlier state would otherwise be re-adopted the
  moment the sources looked that way again. Uncached apps fall back to `{ fileIcon }` — soft but
  never blank.
- **The version in the export folder name is an overwrite guard.** `getAppFolderName`
  (`src/get-app-icon.tsx:166`) lets the app *name* absorb all truncation: shortening the assembled
  label instead would cut the version off the end and collapse two releases onto one folder,
  which is the silent overwrite the version exists to prevent. `CFBundleShortVersionString` only —
  `CFBundleVersion` changes on every internal build and would scatter folders across one release.
- **Export cleanup is licensed by `mkdir`'s return value.** `mkdir(recursive)` returns the first
  directory it created, or `undefined` when the path already existed (`src/get-app-icon.tsx:346`).
  Only a folder *this export brought into being* may be removed on total failure
  (`src/get-app-icon.tsx:369`) — a pre-existing folder is the user's, even when empty.
- **The clipboard gets pixels, not a file URL.** `copyIconToClipboard`
  (`src/get-app-icon.tsx:254`) writes `public.png` + `public.tiff` data. `Clipboard.copy({ file })`
  writes a `public.file-url`, which pastes as an image only while that file exists — and the temp
  file is deleted immediately after.

## Conventions specific to this extension

- `platforms` is `["macOS"]` only, so shortcuts here need no Windows counterpart. Everything
  shells out to `/usr/bin/sips`, `/usr/bin/plutil`, `/usr/bin/xcrun`, and `NSWorkspace`.
- Five `eslint-disable` lines in `src/get-app-icon.tsx` are deliberate, not debt (grep for them
  rather than trusting line numbers). ⌘E on **Export Icons** suppresses
  `prefer-common-shortcut` because the only matching constant is `Common.Edit` and exporting is
  not editing — an honest custom chord beats a wrong semantic match. Three `prefer-title-case`
  suppressions cover the `512 x 512` titles in both the export and copy size submenus, and
  `Export Icons As…`. One `no-control-regex` covers the control-character strip in
  `sanitizeFolderName`, where the characters are legal in an Info.plist string but unusable in
  a path.
- The grid's progress toast is created immediately before the Swift batch begins and hidden in
  `finally` (`src/get-app-icon.tsx:716`) — cache preflight (`mkdir`, key resolution, the
  stale-entry `stat`s) happens first, and a warm cache never shows a toast at all because
  `refreshIconCache` returns before the first progress callback. A silent multi-second pause on
  first run reads as a stall; a toast left on screen after the work stops is the UI lying about
  its state.
- Grid extraction soft-fails: the tiles stay on system icons and `showError` says so. It is not
  worth a hard failure, but it is not worth silence either.

## Commands and gates

```bash
npm run dev      # ray develop
npm run build    # ray build
npm run lint     # ray lint   (npm run fix-lint applies Prettier)
npx tsc --noEmit # separate gate — no script runs it, and ray build strips types
```

**There is no test suite.** Every invariant claimed in this file's commit history was verified
by hand-run scripts against the real machine — 327 installed apps, 312 readable plists, timed
key computation, forced extractor failures. If you change the cache, do the same: walk it in
`npm run dev` with a real app updated underneath the grid, because green gates cannot see a
blanked tile, a stale icon, a stuck progress toast, or an empty `ICNS/` folder left behind.

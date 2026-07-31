import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { environment } from "@raycast/api";

const execFileAsync = promisify(execFile);
const XCRUN_PATH = "/usr/bin/xcrun";

/**
 * Grid tiles render around 128pt, so 256px covers 2x displays without paying for
 * the 512px and 1024px representations we'd only downscale again.
 */
export const CACHE_ICON_SIZE = 256;

/** Extracting every app at once is one `xcrun swift` launch; chunking only adds launches. */
const CACHE_DIR = path.join(environment.supportPath, "icon-cache");

/**
 * Prefix for in-flight extraction temp files. Shared by the extractor below and
 * `pruneIconCache` so the two can't drift: prune must never delete a temp file another
 * window is still writing.
 */
const TEMP_PREFIX = ".tmp-";

/**
 * `NSWorkspace.icon(forFile:)` returns an image whose *nominal* size is 32pt even
 * though it carries representations up to 2048px. Raycast's `fileIcon` renders that
 * nominal size, so a grid tile upscales 32pt to ~128pt and looks soft. Drawing the
 * icon into an explicitly-sized bitmap forces the high-resolution representation.
 *
 * Reads `appPath<TAB>outPath` lines from stdin so a whole fleet costs one process
 * launch — the per-icon work is ~20ms, but each `xcrun swift` launch is ~1s, which
 * is why this is batched rather than called per app.
 */
const EXTRACTOR_SWIFT = `
import AppKit
let s = ${CACHE_ICON_SIZE}
while let line = readLine() {
  // Each field is base64 so a path containing a tab or newline can't forge an extra
  // record. Anything that doesn't decode is skipped rather than guessed at.
  // EXACTLY ONE line is printed per input line, on every path. The caller pairs the Nth
  // result with the Nth job, so a silent skip would shift every later result by one and
  // attribute an outcome to the wrong app. Verified: a job with an undecodable field used
  // to print nothing, and 3 jobs produced 2 lines.
  let fields = line.components(separatedBy: " ")
  guard fields.count >= 2,
        let inData = Data(base64Encoded: fields[0]),
        let outData = Data(base64Encoded: fields[1]),
        let appPath = String(data: inData, encoding: .utf8),
        let outPath = String(data: outData, encoding: .utf8)
  else {
    print("fail")
    fflush(stdout)
    continue
  }
  let icon = NSWorkspace.shared.icon(forFile: appPath)
  icon.size = NSSize(width: s, height: s)
  guard let bmp = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: s, pixelsHigh: s, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
  else {
    print("fail")
    fflush(stdout)
    continue
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bmp)
  icon.draw(in: NSRect(x: 0, y: 0, width: s, height: s), from: .zero, operation: .copy, fraction: 1.0)
  NSGraphicsContext.restoreGraphicsState()
  // Write to a sibling temp file, then put it in place, so a failed or partial write
  // never leaves a half-PNG for the grid to render.
  //
  // The two cases are spelled out separately on purpose. A cache MISS (no destination
  // yet) is the common path on first run — it's a plain move. Only a cache REPLACE has
  // an existing file to swap, which is what replaceItemAt is for.
  var wrote = false
  if let data = bmp.representation(using: .png, properties: [:]) {
    let fm = FileManager.default
    let finalURL = URL(fileURLWithPath: outPath)
    let tmpURL = finalURL.deletingLastPathComponent()
      .appendingPathComponent("${TEMP_PREFIX}" + UUID().uuidString)
    do {
      try data.write(to: tmpURL, options: .atomic)
      // No timestamp is applied. The destination filename encodes the source state this
      // bitmap was drawn from, so an entry's identity no longer depends on its mtime and
      // there is nothing for a wall-clock write to misrepresent.
      if fm.fileExists(atPath: finalURL.path) {
        _ = try fm.replaceItemAt(finalURL, withItemAt: tmpURL)
      } else {
        try fm.moveItem(at: tmpURL, to: finalURL)
      }
      wrote = true
    } catch {
      try? fm.removeItem(at: tmpURL)
    }
  }
  // One line per icon, flushed immediately, so the caller can count progress as it
  // happens. "fail" is reported honestly rather than counted as a success.
  print(wrote ? "done" : "fail")
  fflush(stdout)
}
`;

/**
 * Stable per-app prefix, from a hash of the full bundle path.
 *
 * Hashing rather than sanitizing: replacing every non-alphanumeric character with
 * `_` collapses `A-B.app` and `A_B.app` onto one filename, so the two apps would
 * share a cache entry and one grid tile would show the other's icon. It also keeps
 * the name short, which sanitizing a deep path does not.
 *
 * The prefix is what makes an entry attributable to an app without opening it, which
 * `invalidateCachedIcon` and `pruneIconCache` both need — the rest of the filename
 * encodes source state and is not derivable from the path alone.
 */
function appPrefix(appPath: string): string {
  return createHash("sha256").update(appPath).digest("hex").slice(0, 32);
}

/**
 * The paths whose mtimes decide whether a cached icon is still current.
 *
 * The bundle root alone is not enough. An updater that rewrites files *inside* the
 * bundle leaves the root's mtime untouched, so an app that changed its icon in place
 * kept showing the old tile forever. Measured on a real in-place update: the root
 * stayed at 12:25:41 while `Contents/Info.plist` moved to 12:25:42.
 *
 * `Info.plist` is included because it names the icon file, and `Resources` because its
 * directory mtime moves when an icon is added, replaced, or removed. Missing entries
 * are ignored, so an Asset Catalog app with no `.icns` is handled by the same check.
 *
 * The icon payloads themselves are sampled too, because a directory's mtime moves only
 * when an *entry* changes — rewriting an existing file's bytes leaves it untouched.
 * Verified: overwriting `AppIcon.icns` in place moved only that file's mtime, and none of
 * the four directory/plist stamps, so the change was invisible without this.
 *
 * `AppIcon.icns` and `Assets.car` are the conventional names and cover the overwhelming
 * majority; a bundle using a different `CFBundleIconFile` still gets caught by the
 * `Resources` directory stamp on any add/replace/remove. Reading the plist to resolve the
 * real name would cost a `plutil` spawn per app per grid visit, which is a bad trade for
 * a case the directory stamp already handles.
 */
function iconStampPaths(appPath: string): string[] {
  const resources = path.join(appPath, "Contents", "Resources");
  return [
    appPath,
    path.join(appPath, "Contents"),
    path.join(appPath, "Contents", "Info.plist"),
    resources,
    path.join(resources, "AppIcon.icns"),
    path.join(resources, "Assets.car"),
  ];
}

/**
 * The observed state of one stamp path, rendered for hashing.
 *
 * Three cases, kept distinct because collapsing any two of them was a real bug:
 *
 * - **Readable** contributes its mtime.
 * - **Absent** (`ENOENT`/`ENOTDIR`) is the ordinary shape of an Asset Catalog app with no
 *   `.icns`, so it must be a stable, benign value rather than evidence of change.
 * - **Unreadable** (`EACCES`, I/O error) is *no information*. It gets its own token so a
 *   blind observation can never produce the same key as a readable one — which is what
 *   forces exactly one redraw on entering the blind state and another on recovery.
 */
async function stampState(target: string): Promise<string> {
  try {
    return String((await stat(target)).mtimeMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

/**
 * The cache filename for an app *in its currently observed source state*.
 *
 * This is the whole freshness mechanism. The filename encodes what was observed, so
 * "is the cache fresh?" collapses to "does this exact file exist?" — one `stat`, no
 * timestamp comparison, no sidecar, and nothing whose order can be got wrong.
 *
 * Why this shape, after four fixes to the previous one: with a single fixed filename per
 * app, freshness had to be *inferred* by reading several things (the entry's mtime, the
 * source stamps, a `.blind` marker) and comparing them. Every one of those reads is a
 * separate syscall, so every fix amounted to choosing a different linearization point, and
 * each choice left a different window — an aborted extraction committing a marker, a
 * concurrent refresh resurrecting one, an export deleting the entry mid-check. Encoding
 * the evidence *in the name* removes the comparison entirely: a stale entry is not a file
 * that fails a test, it is a file nobody asks for.
 *
 * The full ordered vector is hashed, not a `max()`. A maximum discards which path moved,
 * and an entry whose newest stamp vanishes can make the maximum go *backwards*.
 *
 * Two entries for the same app differ only after the `-`, so `appPrefix` still attributes
 * any entry to its app without opening it.
 */
async function cacheKey(appPath: string): Promise<string> {
  const states = await Promise.all(iconStampPaths(appPath).map(stampState));
  // The app path is already in the prefix; including it here too binds the state digest to
  // this app, so two apps with coincidentally identical state vectors can't share a name.
  const digest = createHash("sha256")
    .update(`${CACHE_ICON_SIZE}\u0000${appPath}\u0000${states.join("\u0000")}`)
    .digest("hex")
    .slice(0, 32);
  return `${appPrefix(appPath)}-${digest}.png`;
}

/** Where an app's icon lives *right now*, given what its sources currently look like. */
async function currentEntryPath(appPath: string): Promise<string> {
  return path.join(CACHE_DIR, await cacheKey(appPath));
}

/**
 * The apps whose icon must be (re)drawn, each paired with the file to write.
 *
 * A cache entry is named for the source state it was drawn from, so this is a single
 * existence check per app — no timestamp comparison, no sidecar, no ordering. The three
 * cases it has to get right all fall out of that:
 *
 * - **Changed sources** hash to a name nothing has written yet: a miss, so it is redrawn.
 * - **Unchanged sources** hash to the name already on disk: a hit, so nothing happens.
 * - **A deleted entry** (an export invalidating it) is a miss by definition, even if it
 *   vanishes while this runs — there is no earlier observation left to contradict.
 *
 * The blind case is no longer special. An unreadable stamp hashes to its own token, so
 * entering that state yields a name that has never been written (one redraw) and staying
 * in it keeps yielding the same name (no further work). Recovery changes the token back,
 * forcing exactly one redraw from the readable state — which the previous design could
 * not guarantee, because a blind entry stamped at wall-clock time could outlive the
 * outage looking fresh.
 *
 * The returned path is the SAME one the caller renders, so a resolved key is never
 * recomputed against sources that may have moved in between.
 */
async function findStaleApps(appPaths: readonly string[]): Promise<{ appPath: string; entryPath: string }[]> {
  const results = await Promise.all(
    appPaths.map(async (appPath) => {
      const entryPath = await currentEntryPath(appPath);
      const present = await stat(entryPath).then(
        () => true,
        () => false,
      );
      return present ? null : { appPath, entryPath };
    }),
  );
  return results.filter((entry): entry is { appPath: string; entryPath: string } => entry !== null);
}

/**
 * Bring the cache up to date, extracting only what's missing or outdated.
 * Resolves to the number of icons extracted (0 when the cache was already warm).
 *
 * Errors are the caller's to report: a failed extraction leaves the grid on its
 * `fileIcon` fallback, which is soft but never blank.
 */
export async function refreshIconCache(
  appPaths: readonly string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number> {
  await mkdir(CACHE_DIR, { recursive: true });

  const stale = await findStaleApps(appPaths);
  if (stale.length === 0) return 0;

  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  // No mtime stamp accompanies a job any more. The previous design had to write each entry
  // with the source time observed before drawing, so a bitmap drawn pre-update could not
  // later masquerade as fresh — an entire mechanism (plus a Swift-side verification of it)
  // that existed only because one filename had to serve every version of an app's icon.
  // A state-addressed name carries that distinction itself: pixels drawn from an older
  // state are written under the older name, which nothing subsequently asks for.
  const jobs = stale.map(({ appPath, entryPath }) => `${encode(appPath)} ${encode(entryPath)}`).join("\n");

  onProgress?.(0, stale.length);

  // The script comes in via `-e` so stdin stays free for the job list, and each field
  // is base64 so no path can forge a record separator.
  const child = execFileAsync(XCRUN_PATH, ["swift", "-e", EXTRACTOR_SWIFT], { maxBuffer: 1024 * 1024 });
  // Abandoning the grid shouldn't leave a Swift process extracting icons nobody is
  // waiting for.
  const abort = () => child.child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  child.child.stdin?.end(jobs);

  // The extractor prints one line per icon. Counting them as they arrive is what makes
  // the toast a live counter rather than a spinner that lies about state. Only "done"
  // counts — a failed write must not inflate progress.
  //
  // Nothing is keyed off WHICH job a line belongs to any more. The previous design paired
  // the Nth line with the Nth job to decide whose marker to write, which made a silently
  // skipped line an attribution bug; that pairing is gone with the markers. The extractor
  // still prints exactly one line per job, and the count is still honest, but a miscount
  // could now at worst misreport progress rather than mislabel a cache entry.
  let done = 0;
  let pending = "";
  child.child.stdout?.on("data", (chunk: Buffer) => {
    // Chunks can split mid-line, so hold the remainder until its newline arrives.
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    done += lines.filter((line) => line === "done").length;
    onProgress?.(Math.min(done, stale.length), stale.length);
  });

  try {
    await child;
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  // Report what actually succeeded. Claiming `stale.length` here would paper over a
  // batch where some writes failed.
  onProgress?.(done, stale.length);
  return done;
}

/**
 * The cache entry to render for each app that has one, keyed by app path.
 *
 * A Map rather than a Set because the filename is no longer derivable from the app path —
 * it encodes observed source state, so only a resolver that has *looked* can name it. The
 * grid renders exactly what this returns, which is also what keeps the rendered path and
 * the freshness decision from being computed at two different moments against sources that
 * may have moved in between.
 */
export async function listCachedApps(appPaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const resolved = await Promise.all(
    appPaths.map(async (appPath) => {
      const entryPath = await currentEntryPath(appPath);
      const present = await stat(entryPath).then(
        () => true,
        () => false,
      );
      return present ? ([appPath, entryPath] as const) : null;
    }),
  );
  return new Map(resolved.filter((entry): entry is readonly [string, string] => entry !== null));
}

/**
 * Drop every cached entry for one app so the next grid visit re-extracts it.
 *
 * Called after an export, which is the one moment we know the user has deliberately
 * touched this app — and exports read the live bundle, never the cache.
 *
 * Every entry for the app is removed, not just the one matching the current source state.
 * The point of invalidating is to discard what we believe about this icon, and an entry
 * written under some earlier state would otherwise be waiting to be re-adopted the moment
 * the sources looked that way again. The `appPrefix` is what makes that sweep possible
 * without opening anything.
 */
export async function invalidateCachedIcon(appPath: string): Promise<void> {
  const prefix = `${appPrefix(appPath)}-`;
  try {
    const entries = await readdir(CACHE_DIR);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => unlink(path.join(CACHE_DIR, entry)).catch(() => {})),
    );
  } catch {
    // No cache directory yet — nothing to invalidate.
  }
}

/**
 * Drop cache entries nothing will ask for again: uninstalled apps, and superseded states
 * of installed ones.
 *
 * State-addressed names mint a new entry whenever an app's icon sources change, so without
 * this the directory would grow by one file per app update. Keeping only the CURRENTLY
 * resolved key per app collects both cases in a single pass — an uninstalled app has no
 * current key at all, and a superseded entry simply isn't the current one.
 *
 * This is also why the previous `.blind` sidecar needed a special case here and this does
 * not: there is one kind of file in the cache again.
 */
export async function pruneIconCache(appPaths: readonly string[]): Promise<void> {
  const live = new Set(await Promise.all(appPaths.map((appPath) => cacheKey(appPath))));
  try {
    const entries = await readdir(CACHE_DIR);
    await Promise.all(
      entries
        // Never touch a `.tmp-*` sibling: it belongs to an extraction that may still be
        // running in another window, and deleting it mid-write fails that icon.
        .filter((entry) => !entry.startsWith(TEMP_PREFIX) && !live.has(entry))
        .map((entry) => unlink(path.join(CACHE_DIR, entry)).catch(() => {})),
    );
  } catch {
    // No cache directory yet — nothing to prune.
  }
}

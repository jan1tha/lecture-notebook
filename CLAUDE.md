# Lecture Notebook — context

A notebook you type in while the lecture records. Notes, sketches, screenshots
and slide annotations are all time-stamped against the transcript, then exported
as one bundle for the `mba-lecture-notes` skill. Lectures are filed under
modules, and each module carries its own standing notes. Runs locally as the
user. `README.md` is the user-facing doc; this is the agent-facing one.

Stack: Node ≥18, **zero npm dependencies**, **no build step**, vanilla frontend.
Default port **4210** (`PORT`). Binds `127.0.0.1`.

## The one idea that shapes everything

**Capture and transcription are separate.** While a lecture is being recorded
this app does exactly one thing: move audio onto disk without a gap. It runs no
whisper, competes for no CPU, and stopping a recording cannot hang or fail.
Transcription is a background job that happens afterwards, one at a time, at
low priority, with a queue that survives the app being closed.

That split is why the accuracy knob points the other way from a live
transcriber: nothing has to keep up with the lecturer, so the default model is
`large-v3-turbo` rather than something small and fast. A rough live preview is
still available (`settings.liveTranscribe`) but it is off, and its output is
provisional — the background job overwrites it wholesale.

## Layout

```
server.js              routing, SSE, lifecycle, boot recovery (node:http only)
lib/config.js          paths, model catalogue, shared-model resolution, settings
lib/store.js           sessions, block documents, assets, archiving, crash reconciliation
lib/modules.js         modules: meta, module notes, module assets
lib/session.js         RecordingSession — capture only; forked from audio-scribe
lib/jobs.js            the background transcription queue (persisted to data/jobs.json)
lib/rescan.js          transcribe a recording that already exists on disk
lib/audio.js           ffmpeg pipelines, WAV slicing, metering, decode-back-to-PCM
lib/whisper.js         whisper-cli wrapper (incl. low-priority background mode)
lib/devices.js         avfoundation input list                    (verbatim fork)
lib/http.js            json/sse/static/range helpers              (verbatim fork)
lib/setup.js           env checks incl. poppler + soffice, installs, downloads
lib/slides.js          soffice PPTX->PDF, pdftoppm PDF->PNG, pdftotext per page
lib/materials.js       handouts/readings: store untouched, PDF rendition, text extraction
lib/exporter.js        the export bundle — all markdown generation lives here
public/index.html      three columns: library | workspace | transcript+slides+materials
public/app.js          shell: library tree, transport, SSE, queue, decks, materials, export
public/editor.js       the block editor (lecture notes *and* module notes)
public/sketch.js       SketchPad — note sketches AND slide ink
data/sessions/<id>/    meta.json, notebook.json, recordings/, assets/, slides/, materials/, export/
data/modules/<id>/     module.json, notes.json, assets/
data/jobs.json         the transcription queue, so it survives a restart
```

## Relationship to audio-scribe

The recording engine started as a **fork, not an import**, and has since
diverged: `session.js` no longer transcribes on stop at all. `devices.js` and
`http.js` are still verbatim copies; `audio.js` differs by a streamed
`writeWavSlice` and a `decodeToPcm`. audio-scribe's CLAUDE.md documents the
invariants that still hold in both (`-nostdin`, ffmpeg `nobuffer/probesize`,
bytesWritten-in-write-callback, the windowing algorithm).

**Three fixes here are worth porting back** — they were real failure modes, not
theory: the stall watchdog, the capture restart, and the streamed WAV slice.

**Models are shared.** `lib/config.js` resolves the models dir as
`$MODELS_DIR` → `../audio-scribe/models` → `./models`, first existing wins.
`setup.js` flags a model as `shared` when it resolves outside *this* app's own
`models/`, and the UI warns that removing it hits both apps.

## Reliability: what goes wrong in a two-hour lecture, and what catches it

Every item here is a failure that existed and is now handled. Do not remove one
without understanding what it was for.

- **Capture dies silently.** ffmpeg exits, or avfoundation drops the device
  when headphones are plugged in, and nothing notices: the session stays
  `recording` for ever while the browser's wall clock counts merrily on.
  `RecordingSession._onTick` (every 2 s) watches `lastPcmAt`; after
  `settings.stallSeconds` with no audio it calls `_recoverCapture`, which
  respawns ffmpeg **against the same PCM write stream** so the recording
  continues into the same file. Each restart is recorded in `this.gaps` and the
  exporter tells the note-writing skill where the holes are.
- **A restarted transcoder cannot join a webm stream mid-flight.** It needs the
  container header. So in browser mode a restart sets `_awaitingHeader`, `feed()`
  bins everything until a chunk arrives with `?fresh=1`, and the client is told
  to recycle its MediaRecorder (`reopenInput` over SSE, `needsFresh` on the
  upload response as a fallback, `POST .../reopen` when the client notices
  first). Both halves must move together or ffmpeg gets a header it cannot
  parse and the rest of the lecture is lost.
- **The browser's timecode lied.** It was `Date.now() - startedAtWall`, which
  looks identical whether capture is healthy or dead. The server now ticks
  `durationMs` / `backlogMs` / `stalled` / `gaps`, the transport renders *that*,
  and drift between the two raises a visible chip. `nowAnchor()` stamps notes
  with media time for the same reason.
- **A dropped upload chunk is not "a gap".** webm is continuous; losing a
  cluster can poison the decoder for everything after it. `uploadChunk` retries
  four times with backoff and a 20 s timeout, then re-syncs with a fresh
  stream. A 409 means the server lost the recording (it restarted) — the client
  stops rather than pushing into a hole.
- **Backpressure.** `feed()` is async and awaits `drain`; the HTTP response is
  the browser's signal to slow down. Without it a stalled transcoder grows an
  unbounded stdin buffer for the rest of the lecture.
- **Stop used to be where lectures died.** It force-flushed everything
  outstanding as one window — one multi-hour WAV, a `Buffer.alloc` of the whole
  thing, one unbounded whisper call — and then ran a final pass over the same
  audio again. Now stop closes the file, encodes the m4a and queues a job.
- **Nothing survived a crash.** `transcript.json` was only written on
  done/error, and meta stayed `recording` for ever. Now the transcript is
  written every window, and `store.reconcileInterrupted()` at boot marks
  anything unfinished `interrupted` and hands it to `jobs.restoreQueue()`,
  which re-queues every recording that still owes a transcript. Verified by
  SIGKILL mid-recording.
- **The PCM is kept until a transcript exists.** `jobs.reclaimPcm` deletes it
  only after the job succeeds and a sane m4a exists. `rescan.resolvePcm` falls
  back to decoding the m4a, so a re-transcribe works either way.
- **A reconnected event stream replays every segment.** Segments carry an
  `index` and the client writes by index, so a reconnect is idempotent instead
  of duplicating the transcript.

## Whisper loops on quiet audio — do not undo these two lines

The single worst bug this app has had. On far-field or quiet lecture audio
(a real recording here averaged **−27 dB**), whisper starts repeating its own
recent output; that repetition becomes the context for the next window, and the
rest of the lecture locks into one sentence repeated hundreds of times. A real
45-minute lecture came out as 574 segments of which **86% were four repeated
phrases** — and switching from `base.en` to `large-v3-turbo` did not help at
all, because the model was never the problem.

Two changes fixed it, measured on 15 minutes of that same lecture:
**63% repeated segments → 7%**.

1. **`-mc 0`** (`maxContext` in `whisper.js`). whisper.cpp defaults to carrying
   unlimited text context between windows; that carry-over is the loop.
2. **No rolling prompt.** `rescan.js` and `session.js` used to feed the last few
   segments back in as `--prompt`. That is the same feedback path by another
   route. The audio run-up (`contextSeconds`) is what keeps the seams clean;
   text context is not needed and is actively harmful.

If someone "restores" either for better cross-sentence coherence, re-run the
measurement first: transcribe 15 minutes of a genuinely quiet lecture and count
repeated segments. A clean 3-minute excerpt will not reproduce it — the loop
needs a long file and a stretch of near-silence to get started.

The root cause the fix only mitigates is the **input level**. `session.js` now
measures RMS per two-second window and, judged on the loudest window in the
last half minute (so pauses do not count), warns when the recording is audible
but under about **-24 dBFS**. It starts judging after ten seconds, because the
whole value of the warning is hearing it while the microphone can still be
moved. `wasQuiet()`/`loudestDb()` answer for the recording as a whole rather
than the current moment — a recording does not stop having been too quiet
because it ended in silence — and both land on the recording's meta.
Calibration: a real lecture here reads -27 dB and warns; a normally-recorded
clip reads -16 dB and does not.

Still open: whisper.cpp v1.7.4+ has `--vad` with a Silero model, which would
skip silence outright rather than transcribing it. That is the obvious next
improvement for audio this quiet, and it would be faster too.

## The device path dropped 13% of every lecture — do not remove `aresample`

Found by comparing `endedAt - startedAt` against `durationMs` on real
recordings: every device recording had captured only **86-87%** of the time it
ran for. A 93-minute lecture held 5609 seconds of audio over a 6526-second
span. No gaps were recorded, no restarts, nothing had failed — the audio was
simply, quietly short.

Cause: ffmpeg's avfoundation input hands over buffers with gaps in their
timestamps. Without a resampler honouring those timestamps, the output is just
the samples that arrived concatenated together, so the file is short and every
timestamp past the first minute drifts further from reality. Measured on this
machine, 45-second runs through the app's own code:

| | captured |
|---|---|
| flags as shipped | **77.9%** |
| `-af aresample=async=1:first_pts=0` | **98.9%** |

It is not the microphone: BlackHole, a purely virtual device, loses the same
13%. It is not the resampler either — native-rate capture with no `-ar` loses
it too. The browser path was never affected because it has always had
`aresample=async=1`.

`captureRatio` on a recording's meta is this number, so it can never go
unnoticed again: the ⓘ panel shows it in red under 97% and the chip tooltip
says parts of the lecture are missing.

## Media time zero is not when the button was pressed

`startedAt` is what the exporter maps every note and transcript timestamp onto
the wall clock with (`startedAt + t`), so it has to be the instant media time
zero was captured — and that is **not** when the user pressed record.

- **Device:** opening a CoreAudio input takes ~0.5 s. The first sample to
  arrive *is* media time zero, so `_onPcm` corrects `startedAt` on the first
  chunk ever (guarded, so a mid-lecture capture restart does not move it).
- **Browser:** the first chunk carries up to a second of audio recorded
  *before* it was uploaded. Taking its arrival time would push every timestamp
  a second late — the opposite error. The client stamps its first upload with
  `?start=` from when `MediaRecorder.start()` returned, and `noteMediaStart()`
  takes it once, after a sanity check.

`requestedAt` keeps the button press, and `startupLagMs` the difference, both
shown in the ⓘ panel.

Also on that path: the record route used to call `environmentStatus()` and
`listAudioDevices({maxAgeMs: 0})` before spawning capture — together the best
part of a second during which the lecturer is already talking and the
microphone is not yet open. Both are now cached (30 s / 15 s); anything that
changes the environment still asks for a fresh answer. Press-to-first-sample
went from ~1.8 s to **0.59 s**, of which 0.54 s is CoreAudio opening the device
and is not ours to remove.

## Non-obvious things

- **`anchor.t` is authoritative, not `anchor.wall`.** A block's anchor is
  `{wall, recId, t}`; `t` is ms into that recording. The exporter's
  combined-timeline sorts on `t` for any block with a `recId` — sorting on
  `wall` collapsed notes onto one instant whenever the two disagreed.
- **Text blocks store raw markdown, the caret never sees the prefix.**
  `editor.js` `parseMd`/`toMd` round-trip indentation, `#`/`##`/`###`, `- `,
  `1. `, `- [ ]`/`- [x]`, `> ` and `!! ` between stored `md` and displayed
  text, with `data-level`/`data-list`/`data-indent`/`data-quote`/`data-hint`/
  `data-done` on the row driving the styling. Any new markdown affordance has
  to be added to **both** functions, to `SHORTCUTS`, to `COMMANDS`, and to the
  Enter/Backspace handlers.
- **`!! ` is this app's own convention, not markdown.** It is the exam-hint
  flag, chosen because it round-trips through the block editor cleanly.
  `exporter.mdForExport` turns it into `> **⚠️ EXAM HINT** — …` on the way out,
  and MANIFEST.md tells the skill what it means. Nothing outside this repo
  should ever see a bare `!!`.
- **The editor never re-renders while you type.** `_onInput` mutates the model
  and the row's data attributes and stops. Structural edits touch only the rows
  that changed (`_insertAfter`, `_refresh`, `_rowOf(id).remove()`); a full
  `render()` happens once, on `load()`. The old version rebuilt every block on
  Enter, which on an hour of notes made the caret visibly lurch. If you find
  yourself calling `render()` from an edit path, you have reintroduced the bug.
- **Inline markers stay in the text.** `paintInline` wraps `**bold**`, `*em*`,
  `` `code` `` and `==mark==` in spans **without removing the markers**, so
  `node.textContent` still equals the stored text and caret offsets never lie.
  `setCaret` walks text nodes for the same reason. Hiding the markers would
  mean every focus had to re-map offsets.
- **One editor class, two documents.** Module notes use the same
  `NotebookEditor` with `stamps: false` — there is no clock to anchor to. Both
  save through `makeSaver`, which keeps a localStorage draft on failure, retries
  with backoff, and is guarded by an `alive()` check because its retry outlives
  the view.
- **Notes are saved three ways** (debounced PUT, localStorage draft,
  `sendBeacon` on pagehide) because a laptop closing mid-sentence in a lecture
  theatre is the normal case, not the edge case. The notebook route accepts
  POST as well as PUT purely because sendBeacon is POST-only.
- **The notebook doc is guarded by `rev`,** not merged. A stale PUT gets a 409.
- **Deleting a module never deletes lectures** — it unfiles them. `meta.module`
  mirrors the module's *name* so the exporter only ever reads one field, and
  renaming a module rewrites that mirror across its lectures.
- **The app can show you where its own files are.** `audioFootprint` returns
  the absolute path, format and size of each recording, and the ⓘ on a
  recording chip opens a panel with the path, a player (the audio route already
  serves byte ranges) and a Finder button. `POST /api/sessions/:id/reveal`
  derives the path from ids the router has already validated — the client never
  names a path, so it cannot be pointed outside the app's own data.
- **Archiving is filing, not deleting.** `archivedAt` on a session or a module
  is the whole mechanism: nothing moves on disk, the export still builds, the
  transcript still reads, and a search still finds it. The library just stops
  showing it next to this week's work. Pressing record on an archived lecture
  un-archives it (`server.js`, before the recording is created) — filing is not
  a lock. Archiving a module takes `cascade` to reach its lectures, because
  "this term is over" and "these lectures are done" are different claims and
  the caller has to make both.
- **`releaseAudio` is the one irreversible thing in the app.** It deletes the
  m4a/pcm of recordings that *already have a transcript* and skips every other
  recording completely — otherwise "archiving" would quietly throw a lecture
  away. It is never automatic, never part of archiving, and the confirm says
  in plain words that the lecture can never be re-transcribed afterwards.
  `audioFootprint` is what the UI uses to decide whether the offer is even
  worth making (`WORTH_FREEING`, about 30 s of audio).
- **Slide ink is authored in page pixels** (`deck.pageW`×`pageH` from the PNG's
  IHDR chunk) but displayed at whatever width the panel allows. The CSS
  `width: 100% !important` in the `.deck__stage .sketch` rule is what makes that
  scale without skewing strokes. Removing it breaks overlay registration.
- **Only the browser can composite the annotated page.** Node has no canvas, so
  `toFlatBlob()` renders page+ink client-side and PUTs the PNG. Clearing all ink
  deletes the stale composite so exports stay honest.
- **`soffice` needs `-env:UserInstallation`** pointing at a throwaway profile,
  or it fights a running LibreOffice GUI. Deck ingest is sequential by design.
- **`[hidden] { display: none !important; }` in styles.css is load-bearing** —
  the same trap as audio-scribe. Most toggled components set `display`.
- **Live recording state is in memory,** keyed `"<sessionId>/<recordingId>"`.
  The queue is not: it is on disk and resumes. SIGINT/SIGTERM finalises capture
  within 30 s, and anything it misses is recovered on the next start.

## The export contract

`lib/exporter.js` is written against `~/.claude/skills/mba-lecture-notes/SKILL.md`.
That skill asks for three material types — *Transcript*, *Lecture slide deck*,
*Reference documents* — and `MANIFEST.md` maps this app's output onto exactly
that vocabulary, pre-answering its Step 1 questions so it doesn't stall asking.

- The skill reads the **original PDF** with `Read pages`, so `slides/<name>.pdf`
  must stay a real PDF — page PNGs are not a substitute.
- **Two things fill the Reference documents slot.** Module notes are the
  student's standing notes on the subject, exported to
  `reference/module-notes.md` with their images in `reference/images/`.
  Lecture materials (`meta.materials`, from `lib/materials.js`) are the
  handouts and readings: each original is copied under `reference/materials/`
  with its upload folder structure intact, an office document also gets its
  PDF rendition next to it (the skill reads PDFs, not `.docx`), and any
  extracted text goes under `reference/materials-text/` with the same relative
  path. The manifest lists every file with pages, words and the student's
  one-line note on it. When neither exists the manifest says so explicitly and
  tells the skill not to wait for files that will never arrive.
- **A material that cannot be read is still a material.** `ingestMaterial`
  never fails on conversion: the original is kept, `problem` says why in plain
  words, the UI shows it and the manifest puts it in Data caveats. Losing a
  file because LibreOffice choked on it would be the wrong trade. Two uploads
  with the same name both survive the export (`handout-2.docx`).
- Assessments fall back from the lecture to its module, which is where the
  student actually maintains them.
- The output path is filed per module: `<notesDir>/<Module-Name>/<Lecture>.md`.
- The manifest explains the two note conventions the skill should act on:
  `⚠️ EXAM HINT` lines and unticked `- [ ]` boxes.
- A bundle built while transcription is still queued says so, in
  `transcript.md`, in the warnings and in the export sheet.

## State as of Sep 2026 — what is proven and what is not

**Verified end to end, headless, this session:**
- module → lecture → record over the browser upload path → stop → background
  queue → transcript → notes → export bundle with `reference/module-notes.md`;
- **crash recovery**: SIGKILL mid-recording, restart, recording auto-detected as
  interrupted, re-queued and transcribed from the orphaned PCM;
- **stall watchdog**: 16 s of silence mid-lecture → warning, capture restarted,
  gap recorded at 00:09, client re-synced with a fresh stream, audio resumed,
  gap reported in the export;
- **optional live preview**: rough segments stream while recording and are then
  replaced wholesale by the background pass;
- the editor driven with real keystrokes in headless Chrome: `⌘1` heading, `- `
  bullet, Tab indent, `[] ` to-do, `!! ` exam hint, `/` command menu, `⌥↑` block
  move, inline `**bold**`, and the exact markdown that lands in `notebook.json`;
- **archiving**: shelf collapsed by default and reopened by a search, row hover
  toggle, module archive with and without cascade, the banner and its disabled
  transport, freeing audio (transcript and notes intact afterwards, the
  re-transcribe button correctly gone), and restore putting all of it back;
- **materials** (Oct 2026): PDF, `.docx` (converted and read), `.md` and PNG
  uploaded with nested folder paths, a note PATCHed on, a duplicate name,
  deletion, and the export laying all of it out under `reference/` with the
  manifest listing each file. The Materials tab itself was driven headlessly:
  load, tab switch, rows rendered, no console errors.

**Never yet run against a real lecture.** Untested with a human in the loop:
typing for a sustained period, the sketch pad with a trackpad/Pencil, pasting
screenshots mid-lecture, drawing on slides while audio records, and a
multi-hour recording (the longest tested is 35 s).

**Open items, in priority order:**
1. **Re-transcribe the existing lectures.** `large-v3-turbo` is installed now,
   but every transcript on disk was produced *before* the loop fix and is
   mostly repeated phrases. The ⟳ on each recording chip re-queues it.
2. **Input level.** The real recordings average −27 dB, dipping to −33 dB. That
   is the root cause the loop fix only mitigates: a louder input would help
   every engine more than any model change. Nothing in the app warns about a
   quiet input even though the meter is right there — worth adding, and worth
   considering capture-side gain.
3. Recording an in-person lecture means the **microphone**, via the device path.
   The Teams/Zoom desktop apps still need BlackHole, whose driver is installed
   but **not loaded** on this Mac (see audio-scribe's CLAUDE.md — needs approval
   in System Settings → Privacy & Security). A lecture in a browser tab works
   today with no setup.
4. **Run the `mba-lecture-notes` skill against a real bundle** before changing
   anything in the export. If it under-uses `combined-timeline.md` or the new
   `reference/module-notes.md`, the fix is a paragraph in that skill's SKILL.md,
   not in this repo, and needs the user's say-so since it is outside this
   project.
5. Materials are **per lecture only.** A textbook chapter that spans three
   lectures has to be uploaded to each. A module-level materials folder that
   every lecture's bundle carries along (the way module notes already do) is
   the obvious extension; `lib/materials.js` is written against a directory,
   so it would be a second call site, not a second implementation.
6. `settings.notesDir` defaults to `~/Documents/Personal/MBA/Notes` in the
   generated prompt but has no UI; it is only settable through `POST /api/settings`.
7. Ported-back fixes: the stall watchdog, capture restart, streamed WAV slice
   **and especially the `-mc 0` loop fix** should go into audio-scribe too.
8. **Apple's `SpeechAnalyzer` (macOS 26) is a viable second engine** — measured
   on this machine at ~60x real time against whisper turbo's 13x, with no model
   download (the OS owns the asset) and no hallucination on silence. It loses
   on completeness: it silently drops audio it is unsure of, which is worse for
   study notes than ugly text. A working Swift prototype is in `tmp/apple/`.
   Adopting it would mean a compiled helper, i.e. giving up "no build step".

**Nothing is committed.** Both this repo and audio-scribe are `git init`-ed with
everything untracked; MyAppManager has uncommitted edits to `apps.json`,
`README.md` and `CLAUDE.md` from onboarding both apps.

## Testing without a browser

```bash
say -f lecture.txt -o l.aiff && ffmpeg -i l.aiff -c:a libopus -f webm l.webm
# POST l.webm to /api/sessions/<id>/recordings/<rid>/audio in ~1s slices
```
`tmp/` is gitignored and is where scratch harnesses go. Drive the *frontend*
headlessly over the DevTools protocol rather than `--dump-dom`: the app holds an
SSE stream open, so the page never reaches "load complete" and `--dump-dom`
returns nothing.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --user-data-dir=/tmp/prof --remote-debugging-port=9333 about:blank &
# then drive it with Runtime.evaluate / Input.dispatchKeyEvent over the ws url
# from http://127.0.0.1:9333/json/list
```

Worth re-running after any change to capture, the queue or the exporter:
create → record → stop → queue drains → notes → export. And after any change to
the editor: real keystrokes, then read back `notebook.json` and check the
markdown is what the exporter expects.

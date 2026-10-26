# plex-tidy

A Windows command-line tool that cleans and renames video files and their subtitle sidecars so Plex displays them correctly, and writes matching titles into the files' embedded metadata.

## What it does

plex-tidy has three modes that share one pipeline. `videos` cleans filenames for personal videos that have no database record and keeps only the title. `movies` and `tv` match files against The Movie Database (TMDB) and rename them into the Plex naming scheme. Every run is a dry run unless you pass `--yes`, every change is journaled, and every run can be undone. Renaming and tagging are separate commands.

## Stack

TypeScript in strict mode on Node.js, run with `tsx`. Zod validates configuration, environment variables, API responses, model output, and state files. A hosted language model parses messy filenames, and deterministic code validates what it returns. TMDB provides movie and TV metadata. FFmpeg, MKVToolNix, and ExifTool handle probing and embedded tags. State is plain JSON on local disk.

## Development

Requirements: Windows, Node.js current LTS release (20.6 or later), and `winget` for the external tools.

```
npm install
copy .env.example .env
copy config.example.json config.json
npm run start -- doctor
```

Fill in `.env` with your keys and `config.json` with your settings, then run `doctor` again until it reports no problems. Run the tool from a normal, non-elevated terminal so mapped drive letters are visible.

## How to use

### The short version

```
npm run start -- videos run --root U:\Videos
```

This one command does the whole job. It asks before each of three steps and stops if you answer No. Nothing changes on disk until you answer Yes to the last question. Work on a copy of your files the first time.

### Command shape

```
npm run start -- <mode> <command> --root <path> [options]
```

- `npm run start --` runs the tool. The `--` passes everything after it to plex-tidy instead of to npm.
- `<mode>` is `videos` today. `movies` and `tv` arrive in later phases.
- `<command>` is one of the commands below.

### Options

| Option | Used by | What it does |
| --- | --- | --- |
| `--root <path>` | every mode command | The library folder to work on. Required. Nothing outside it is renamed. Give a copy of your files the first time. |
| `--state-dir <path>` | every mode command | Where plans, journals, and caches go. The default is `stateDir` in `config.json`, which is `./state`. Use another folder to keep a separate set of state. |
| `--yes` | `apply`, `tag`, `undo` | Make the changes. Without it, the command reports what it would do and changes nothing. |
| `--only <kind>` | `undo` | `rename` undoes only renames. `tag` undoes only tags. Without it, `undo` reverses both, tags first. |
| `--verbose` | any command | Prints debug lines. This is how a dry run shows the full list of old and new names, and how a refused `apply` lists the problems it found. Put it anywhere on the line. |
| `-h`, `--help` | any command | Shows the options for that command, for example `npm run start -- videos apply --help`. |

The `doctor` command takes no options.

### Commands

| Command | What it does | Changes files? | Calls the model? |
| --- | --- | --- | --- |
| `run` | The guided command: prepare, review, and rename, asking before each step. | Only after your final Yes | Yes, in step 1 |
| `scan` | Lists the video and subtitle files under the root and counts the ones with no title in the name. | No | No |
| `parse` | Asks the model for a title for each file. Answers are cached, so a second run costs nothing. | No | Yes |
| `resolve` | Chooses the final title for each file, using the file name first and then a folder name. | No | No |
| `plan` | Writes the list of renames and marks collisions. Decisions you made in review carry over. | No | No |
| `review` | Shows the proposed names and lets you accept, edit, or skip each one. | No | No |
| `apply` | Renames the approved files and their subtitles. A dry run unless you add `--yes`. | With `--yes` | No |
| `tag` | Writes each renamed file's title into the file itself. Separate from `apply`, so you can check the renames in Plex first. A dry run unless you add `--yes`. | With `--yes` | No |
| `undo` | Puts the original names and tags back, newest first. A dry run unless you add `--yes`. Use `--only rename` or `--only tag` to undo one kind. | With `--yes` | No |
| `status` | Shows which stages are done, the plan counts, and any unfinished journal lines. | No | No |
| `doctor` | Checks the Node version, `config.json`, the external tools, and whether the keys are set. It never prints a key. | No | No |

The stage commands run in this order: `scan`, `parse`, `resolve`, `plan`, `review`, `apply`, and then `tag`. `run` does everything up to `apply`; tagging is always its own command. Use the single commands to resume after a stop, to redo one stage, or to look at one stage.

### The guided command

`run` asks three questions. Press Enter to take the default.

1. **Prepare** (default Yes). Runs `scan`, `parse`, `resolve`, and `plan` as one step. The model sees file names only, never paths. If you answer No and an earlier plan exists, the run continues from that plan.
2. **Review** (default Yes). Asked only when entries wait for a decision. See the next section.
3. **Rename** (default No). Asked only when something is approved. It shows how many renames and entries are involved. If you did not review in this run, it lists every rename first. A Yes here is your permission to change files.

Press Ctrl+C at any question to stop. Every decision is saved as you make it.

### Progress

Steps that can take a while show their progress: scanning, the model requests in `parse`, the name check in `plan`, the checks and renames in `apply`, reading and writing in `tag`, and `undo`. In a terminal this is one line that updates in place, for example `tagging: 12 of 70 (17%)  elapsed 2m10s  about 10m left`. The elapsed time keeps counting while a single large file is being written, so a long copy never looks frozen. When the output goes to a file or a pipe, the line becomes a short note every five quiet seconds plus a summary at the end. Progress shows counts and times only, never file names.

### Review

The first thing review shows is the entries whose title came from the file name, passed the word check, and collide with nothing. It lists each old and new name and asks to approve them all at once. Then it walks through the rest one at a time:

- **Accept**: use the proposed name.
- **Edit**: type a title, without the extension. plex-tidy refuses a title that is empty, illegal on Windows, too long, already used by another entry, or already on disk.
- **Skip**: leave the file as it is. The decision is saved, and review does not ask about that file again.
- **Quit**: stop and keep every decision so far.

A file with no title found can only be edited or skipped. A line such as `low confidence: the model gave no usable result` means the model returned nothing, so the name comes from the rules-only cleaner. Check those names.

### What videos mode does to names

- The new name is the title only: `Title.mkv`. No year, resolution, release tag, or group name.
- Files stay in their folders. Folders are never renamed.
- Subtitle files (`.srt`, `.ass`, `.ssa`, `.sub`, `.vtt`) that start with the video's name travel with it and keep their language suffix: `Title.en.srt`.
- Video types are `.mkv`, `.mp4`, `.avi`, `.mov`, `.m4v`, and `.wmv`. Every other file is left alone.
- A file with no title in its name, such as a camera name or a string of digits, takes its title from the nearest folder name.
- If two files in one folder get the same title, both are numbered in the order of their original names: `Title 01.mkv`, `Title 02.mkv`. Numbered entries are never part of the bulk approval.
- Casing is kept when the name has mixed case. A name that is all lowercase or all uppercase gets Title Case, with small English and Spanish words such as "of", "the", and "de" kept lowercase inside the title.
- A standalone year from 1900 to 2099 is removed. A file named only `2012.mkv` therefore has no title, and review asks you to type one.
- Characters Windows does not allow are removed or replaced, trailing dots and spaces are trimmed, and reserved names such as `CON` get an underscore.

Every title from the model must pass a check: each word of the title has to appear in the original name, in the same order, in one single source. A title that fails is rejected, and the rules-only cleaner runs on the same text instead, with low confidence.

### Tagging

`tag` writes the title into each renamed file, so players that read embedded metadata show the clean name too. Plex ignores these tags when it matches a file, which is why tagging is a separate step after `apply`: check the renames in Plex first, then tag. It only touches files that `apply` renamed.

How each container is handled, from a test on a real sample file of every type:

| Container | Written by | Result |
| --- | --- | --- |
| `.mkv` | `mkvpropedit`, in place | Title written. Other fields go into the file's global tags, merged with the tags already there. |
| `.mp4`, `.m4v`, `.mov` | `exiftool`, through a temporary copy | Title written, read back, then the copy replaces the original. |
| `.avi`, `.wmv` | none | Rename-only. ExifTool cannot write AVI or WMV files. `tag` records the reason and carries on. |

What `tag` does for each file:

1. Reads the file's current tags. If the title is already right, it writes nothing, so a second run changes no file.
2. Writes an `intent` line to the journal that holds the previous values, then writes the tags.
3. Reads the tags back and compares. For an MP4-family file this check runs twice, on the new copy and again on the uploaded copy, before the original is replaced. For a Matroska file the edit is in place, so on a mismatch the previous values are put back.
4. Writes the `done` line. A file that fails the read-back is marked `tag-failed` and the command exits with code 1. The next run tries it again.

Videos mode writes the title only. The writers also handle the fuller records that movies and TV will use: original title, release date, synopsis, genre, director, actors, a TMDB reference, show, season, episode, and air date. Fields an MP4 file has no place for are skipped, and the skipped fields are recorded.

`undo` puts the previous tag values back, newest first, so tags unwind before the renames they followed. An MP4-family file is rewritten again to do that.

**Large files.** An MP4, M4V, or MOV rewrite makes a whole new copy of the file, in three steps. The original is downloaded to your computer's temporary folder in large blocks. ExifTool writes the tags into that local copy. The finished copy is uploaded next to the original in large blocks, checked again, and only then replaces the original. ExifTool never touches the network drive, because it reads and writes in tiny blocks, and each block waits for the network. On the owner's network that meant about 5 MB/s for writing, and the same for reading whenever the network was busy, while a plain large-block copy ran at 40 to 90 MB/s at those moments. On a quiet network the three steps take about 20 seconds for a 628 MB file, so a library of about 64 GB takes roughly half an hour.

This needs free space on this computer's temporary folder for two copies of the largest file plus 64 MB, and the same for one copy on the drive that holds the video. The command refuses a file when either is short and says so in the plan. Matroska files are edited in place and are fast.

If a run is stopped partway, it can leave a hidden `.plex-tidy-tag.tmp` file next to a video, or a `plex-tidy-copy-…` folder in the temporary folder. The next `tag --yes` removes both, and a dry run only reports how many there are. Files already tagged are skipped, so running `tag` again continues where it stopped.

`tag` needs `ffprobe` for every file, `mkvpropedit` and `mkvextract` for Matroska files, and `exiftool` for the MP4 family. `doctor` shows which are installed.

### Safety

- **Dry run first.** `apply` and `undo` change nothing without `--yes`.
- **Checked before the first rename.** `apply` checks every approved rename and refuses the whole plan if one has a problem: a path outside the root, another drive, a path over 259 characters, an illegal name, a missing source, a target that already exists, or two renames with the same target.
- **Never overwrites, never deletes.** A name that already exists is a collision and goes to review.
- **Journaled.** Every rename and every tag write puts an `intent` line in `journal.jsonl` before and a `done` line after. A tag line carries the previous values.
- **One exception to "never overwrite".** The only time a file is replaced is an MP4-family tag write, and only after the copy passed the read-back check.
- **Interrupted runs.** When `apply` or `undo` starts, it compares unfinished journal lines with the real files and reports what it finds. A rename that finished gets its `done` line, so undo can reverse it.
- **Undo.** `undo --yes` reverses the finished renames, newest first. It refuses to overwrite a file that now has the original name, and reports it. Undone entries return to approved, so the plan can run again.
- **Privacy.** For a file with a title, only its base file name goes to the model: no folder, no path, no extension. For a file with no title, the folder names go. Full paths never leave the machine.

### Running again

Every stage saves its result, so you can stop and continue later.

- Running `scan` again starts a new scan. Run `parse`, `resolve`, and `plan` after it. The commands tell you when a result is from an older scan.
- `parse` costs tokens only for names it has not seen. Cached names are free.
- `plan` keeps your accept and skip decisions for entries whose proposed name did not change.
- A folder that is already organized produces a plan where every entry is skipped as `unchanged`.

### Settings

**`.env`** holds the keys. Commands read only the key they need.

| Key | Needed by |
| --- | --- |
| `ANTHROPIC_API_KEY` | `parse` and `run` |
| `TMDB_READ_ACCESS_TOKEN` | `movies` and `tv`, in later phases. Use the long Read Access Token, not the short API Key. |

**`config.json`** holds the settings. `config.example.json` shows every key.

| Setting | Default | What it does |
| --- | --- | --- |
| `stateDir` | `./state` | Where state files go. `--state-dir` overrides it. |
| `models.parse` | none | The model that proposes titles. |
| `models.judge` | none | The model for picking among TMDB matches, used by `movies` and `tv` later. |
| `parseBatchSize` | 50 | File names per model request. Allowed range is 50 to 100. |
| `autoApplyThreshold` | 0.9 | The match score at which `movies` and `tv` approve an entry on their own. Not used by `videos`. |
| `tmdbConcurrency` | 4 | Parallel TMDB requests. Not used by `videos`. |
| `tools.ffprobe`, `tools.mkvpropedit`, `tools.mkvextract`, `tools.exiftool` | found on `PATH`, then in the usual install folder | Full path to a tool that is in neither place. Used by `tag`, `undo`, and `doctor`. |

**State** lives under `stateDir`, on the machine that runs the tool, never on the media share:

```
state/videos/<root id>/scan.json       files, subtitles, and folder names
state/videos/<root id>/resolve.json    model answers and chosen titles
state/videos/<root id>/plan.json       one entry per file, with its status
state/videos/<root id>/journal.jsonl   the record of every rename and undo
state/cache/parse-cache.json          model answers, shared by all roots
```

The root id is a short hash of the root path, so each folder keeps its own state. Plan statuses are `pending`, `approved`, `rejected`, `skipped`, `applied`, and `failed`. You can open any of these files, and `plan.json` is the one to read.

### Exit codes and problems

A command exits with 0 on success and 1 on an error or a failed rename. Ctrl+C at a prompt exits with 130.

| Message | What to do |
| --- | --- |
| `npm` or `node` is not recognized | Close and reopen the terminal. Node is installed in `C:\Program Files\nodejs`. |
| Running scripts is disabled | Type `npm.cmd` instead of `npm`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once. |
| `ANTHROPIC_API_KEY is not set` | Add it to `.env`, then run `doctor`. |
| `config.json was not found` | Copy `config.example.json` to `config.json`. |
| `Run scan first.` and similar | A stage ran before the one it needs. Run the stage named in the message. |
| A message with `older scan` | You scanned again after `parse`. Run `parse`, `resolve`, and `plan` again. |
| `PREFLIGHT_FAILED` | Nothing was renamed. Run `apply --verbose` to see each problem. |
| `requests: N refused` | The model declined some names. Those files use the rules-only cleaner at low confidence. Check them in review. |

## Scripts

- `npm run start -- <mode> <command> [options]`: run the CLI.
- `npm run check`: typecheck, lint, and tests. This is the gate for every phase.
- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:watch`.

## Repo layout

```
src/        CLI, pipeline stages, providers, tagging
tests/      unit tests and synthetic fixtures
state/      runtime state (gitignored)
specs/      private design and phase specs (gitignored)
AGENTS.md   conventions, invariants, and build instructions
```

## Phases

The build is staged across private phase specs: foundations, videos mode, tagging, movies, and TV. Phase 0 (foundations) and Phase 1 (videos mode) are complete. Conventions and invariants live in `AGENTS.md`.

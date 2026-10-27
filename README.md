# plex-tidy

A Windows command-line tool that cleans and renames video files and their subtitle sidecars so Plex displays them correctly, and writes matching titles into the files' embedded metadata.

## What it does

plex-tidy has three modes that share one pipeline. `videos` cleans filenames for personal videos that have no database record and keeps only the title. `movies` and `tv` match files against The Movie Database (TMDB) and rename them into the Plex naming scheme. Every run is a dry run unless you pass `--yes`, every change is journaled, and every run can be undone. Renaming and tagging are separate commands, and the guided `run` command offers the tagging as its last step.

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

This one command does the whole job. It asks before each of four steps (prepare, review, rename, tag) and stops if you answer No. Nothing changes on disk until you answer Yes to the rename question. Work on a copy of your files the first time.

### Command shape

```
npm run start -- <mode> <command> --root <path> [options]
```

- `npm run start --` runs the tool. The `--` passes everything after it to plex-tidy instead of to npm.
- `<mode>` is `videos`, `movies`, or `tv`.
- `<command>` is one of the commands below.

### Options

| Option | Used by | What it does |
| --- | --- | --- |
| `--root <path>` | every mode command | The library folder to work on. Required. Nothing outside it is renamed. Give a copy of your files the first time. |
| `--state-dir <path>` | every mode command | Where plans, journals, and caches go. The default is `stateDir` in `config.json`, which is `./state`. Use another folder to keep a separate set of state. |
| `--folder <path>` | `scan`, `run` | Work on one folder under the root, for example `--root T:\ --folder Rome`. The root stays the boundary, so that folder itself can be renamed. The path is relative to the root, or absolute and inside it. |
| `--yes` | `apply`, `tag`, `undo` | Make the changes. Without it, the command reports what it would do and changes nothing. |
| `--only <kind>` | `undo` | `rename` undoes only renames. `tag` undoes only tags. Without it, `undo` reverses both, tags first. |
| `--verbose` | any command | Prints debug lines. This is how a dry run shows the full list of old and new names, and how a refused `apply` lists the problems it found. Put it anywhere on the line. |
| `-h`, `--help` | any command | Shows the options for that command, for example `npm run start -- videos apply --help`. |

The `doctor` command takes no options.

### Commands

| Command | What it does | Changes files? | Calls the model? |
| --- | --- | --- | --- |
| `run` | The guided command: prepare, review, and rename, asking before each step. | Only after your Yes to the rename and tag questions | Yes, in step 1 |
| `scan` | Lists the video and subtitle files under the root and counts the ones with no title in the name. | No | No |
| `parse` | Asks the model for a title for each file. Answers are cached, so a second run costs nothing. | No | Yes |
| `resolve` | Chooses the final title for each file, using the file name first and then a folder name. | No | No |
| `plan` | Writes the list of renames and marks collisions. Decisions you made in review carry over. | No | No |
| `review` | Shows the proposed names and lets you accept, edit, or skip each one. | No | No |
| `apply` | Renames the approved files and their subtitles. A dry run unless you add `--yes`. | With `--yes` | No |
| `tag` | Writes each renamed file's title and details into the file itself. It is also step 4 of `run`. Use the command on its own to tag later, for example after checking the renames in Plex. A dry run unless you add `--yes`. | With `--yes` | No |
| `undo` | Puts the original names and tags back, newest first. A dry run unless you add `--yes`. Use `--only rename` or `--only tag` to undo one kind. | With `--yes` | No |
| `status` | Shows which stages are done, the plan counts, and any unfinished journal lines. | No | No |
| `doctor` | Checks the Node version, `config.json`, the external tools, and whether the keys are set. It never prints a key. | No | No |

The stage commands run in this order: `scan`, `parse`, `resolve`, `plan`, `review`, `apply`, and then `tag`. `run` does all of them in order, asking before each of the four steps. The single commands are also there for tagging later. Use the single commands to resume after a stop, to redo one stage, or to look at one stage.

### The guided command

`run` asks up to four questions. Press Enter to take the default.

1. **Prepare** (default Yes). Runs `scan`, `parse`, `resolve`, and `plan` as one step. The model sees file names only, never paths. If you answer No and an earlier plan exists, the run continues from that plan.
2. **Review** (default Yes). Asked only when entries wait for a decision. See the next section.
3. **Rename** (default No). Asked only when something is approved. It shows how many renames and entries are involved. If you did not review in this run, it lists every rename first. A Yes here is your permission to change files.
4. **Tag** (default Yes). Asked after the rename, when renamed files wait for tags. It says how many files are involved and how MKV and MP4 files are written. A Yes here is your permission to change the files' tags, and `undo --yes` puts the old tags back. Answer No to tag later with the `tag` command. If you run `run` again with nothing left to rename, it asks this question again for files that are renamed but not yet tagged.

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

### Movies mode

```
npm run start -- movies run --root U:\Movies
```

Movies mode matches each file to a movie on TMDB and renames it into the Plex scheme. The commands are the same as in videos mode: `run`, `scan`, `parse`, `resolve`, `plan`, `review`, `apply`, `tag`, `undo`, and `status`. `scan`, `apply`, `tag`, and `undo` work exactly as before. The rest differ:

- **`parse`** reads the title, year, edition, language, and part from each file name. A clean name such as `Title (2010)` is read by a rule and costs nothing. A name that already ends in `{tmdb-123}` carries its TMDB id. Every other name goes to the model in batches. The model only reports what is written in the name, and each answer is checked: the title's words must appear in the name in order, and a year, edition, or part that is not in the name is dropped.
- **`resolve`** reads the length and container title of each video with `ffprobe`, searches TMDB in English with the title and year, and scores each candidate from 0 to 1: 0.6 for the title, 0.25 for the year, 0.15 for the length. A year one off still counts, and a length within two minutes counts in full. A part with no data on one side counts as half. If the best score is below the threshold, `resolve` searches again without the year, and again in Spanish when the model said the title is Spanish or nothing was found. When the file name has no year, a year in a folder name such as `Title (2006)` is used. When nothing is found, `resolve` tries the title with trailing words dropped (down to two words), then the title read from the nearest folder name. Folder names are read on this machine only; they are never sent to the model. The score and the reasons are saved in `resolve.json`.
- **The judge.** A file whose best score is below `autoApplyThreshold`, or whose best two candidates are within 0.05 of each other, goes to the judge model. It sees the base file name, the container title, the length, and the top five candidates, and returns one candidate or nothing. An answer that is not one of the candidates, a refusal, or an invalid response is treated as nothing. A pick still waits for your review. The judge never approves anything.
- **`plan`** names each movie `Title (Year) {tmdb-id}`, using the TMDB original title made legal for Windows. The video becomes `Title (Year) {tmdb-id}.mkv`, with ` {edition-Name}` added when the file name had an edition. Subtitle files travel with the video. If the video is the only video under its folder, the folder is renamed to `Title (Year) {tmdb-id}` too. A folder with two videos, or with videos in a subfolder, keeps its name, and so does the root. Every other file in the folder is left alone.
- **Approval.** An entry at or above the threshold with no collision is approved on its own, with a reason that starts with `auto`. A file with no match on TMDB is `skipped` with the reason `unmatched` and stays where it is. A name that already exists, a name two entries want, a name with a part marker, and a path over the limit are collisions and wait for review.
- **`review`** shows each open entry with its TMDB candidates and their scores. You pick a candidate, search TMDB by a typed title, enter a TMDB id, or skip. Choosing a movie approves it, after the same checks as before. An entry with a collision cannot be accepted.
- **`apply`** renames the files inside the old folder first, then the folder. `undo` reverses the folder first, then the files.
- **`tag`** writes the title, original title, release date, synopsis, genres, director, actors, and a TMDB reference such as `movie/603` (see the table in Tagging for what each container can hold).

What leaves the machine: the model sees base file names, never paths. TMDB sees titles and years. The judge sees one file name and its candidates.

Run it on a copy of your files first. A second run on a library that is already organized produces a plan where every entry is `unchanged`.

### TV mode

```
npm run start -- tv run --root T:\Shows
```

TV mode matches each show and episode to TMDB and moves the episodes into the Plex layout: `Show (Year) {tmdb-id}\Season 01\Show (Year) {tmdb-id} - s01e01 - Episode Title.mkv`. The commands are the same as in movies mode, and `scan`, `apply`, `tag`, and `undo` are shared. The rest differ:

- **`parse`** reads the season and episode from each file name with a short list of rules: `s01e10`, `2x06`, `Season 2 Episode 6`, several episodes in one file (`s01e01e02`, `s01e01-e02`, `s01e01-02`), and names that carry only an episode number (`11 - Title`, `11.-.Title`, `Show - 11 - Title`, `episode 11`). A name no rule can read goes to the model in batches. The model only reports what is written in the name, and a season or episode number that is not written in the name is dropped.
- **Shows.** Episodes that share a show folder are one show, and each show is searched on TMDB once. The folder name supplies the title, a year in brackets, and a `{tmdb-id}` tag when there is one. The show is scored on its name (0.8) and its first air year (0.2). A missing year counts as no contradiction, so two shows with the same name and no year are told apart by the judge or by you. The judge sees up to five base file names of the show and the candidates, never a folder name.
- **Episodes.** The season and episode numbers are matched against the TMDB season listing in aired order, and the title from the listing names the file. A file with several episodes is named `s01e01-e02` and gets both titles joined with ` + `.
- **Seasons.** The season comes from the file name, or from the `Season N` folder when the name has none. When both exist and differ, the entry is flagged and waits for review. An episode number with no season anywhere is taken as season 1, flagged, and never approved on its own. An episode that TMDB does not list waits for review.
- **Approval.** An episode in a show that matched with a score at or above the threshold, with a season from the name or the folder, is approved on its own, with a reason that starts with `auto`. A show that matched only through the judge, an assumed season, a conflict, a collision, and a missing episode all wait. A show with no match on TMDB is `skipped` with the reason `unmatched`.
- **`review`** first asks one question for each show that is not sure: pick a candidate, search TMDB by title, enter a TMDB id, or skip the whole show. That one decision applies to all of the show's episodes. Then it walks the episodes that still wait: accept, set the season and episode (type `s02e05`), or skip.
- **`plan`** renames the show folder in place when every file in it is approved and the new name is free. The files move inside the old folder first (into a new `Season 01` folder that the tool creates), and the folder is renamed last, so a poster or a note in the folder goes along. When only some files are approved, or the new show folder already exists, the approved files move one by one into the new folders instead and the rest stay where they were. Subtitles travel with their video. Other files are never touched.
- **`apply`** creates the folders it needs, writes each creation to the journal, and never overwrites a file. **`undo`** moves the files back, renames the show folder back, and removes only the folders the tool created, and only when they are empty. A folder that still holds files is kept and reported.
- **`tag`** writes the episode title, the show, the season, the episode, the air date, the plot, the genres, and a TMDB reference such as `tv/1044`.

The show folder uses the English TMDB name of the show. Season 0 is written `Season 00`, which Plex reads as the specials. Specials and other layouts that differ from the TMDB listing end up in review.

What leaves the machine: the model sees base file names, never paths or folder names. TMDB sees show titles and years. Run it on a copy of your files first.

### Tagging

`tag` writes the title into each renamed file, so players that read embedded metadata show the clean name too. Plex ignores these tags when it matches a file. The guided `run` command asks about tagging as its last step, right after the rename (the default answer is Yes). You can also answer No there and run `tag` later, for example after checking the renames in Plex. It only touches files that `apply` renamed.

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

Videos mode writes the title only. Movies mode writes the fuller record: original title, release date, synopsis, genre, director, actors, and a TMDB reference. TV mode writes the episode title, show, season, episode, air date, plot, genres, and a TMDB reference. Fields an MP4 file has no place for, such as the original title, are skipped, and the skipped fields are recorded.

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
- **Folders.** `apply` creates a folder only when it does not exist, and journals each one. `undo` removes a folder only when the tool created it and it is empty. It deletes nothing else.
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
| `ANTHROPIC_API_KEY` | `parse` and `run`, in `videos` and `movies`. In `movies`, `resolve` also needs it for the judge; without it the judge is skipped and those files go to review. |
| `TMDB_READ_ACCESS_TOKEN` | `movies` and `tv`: `resolve`, `review`, and `run`. Use the long Read Access Token, not the short API Key. |

**`config.json`** holds the settings. `config.example.json` shows every key.

| Setting | Default | What it does |
| --- | --- | --- |
| `stateDir` | `./state` | Where state files go. `--state-dir` overrides it. |
| `models.parse` | none | The model that proposes titles. |
| `models.judge` | none | The model for picking among TMDB matches, used by `movies` and `tv`. |
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
state/cache/tmdb-cache.json           TMDB answers, shared by all roots (searches 7 days, movies 30 days)
```

Movies mode keeps the same files under `state/movies/<root id>/`. Its `resolve.json` holds the parsed name, the probe, the scored candidates, and the choice for each file. TV mode uses `state/tv/<root id>/`. Its `resolve.json` holds the shows (with their candidates and choice) and, for each file, the parsed name and the matched season and episode. The journal also records each folder the tool creates (`mkdir`), so `undo` can remove it.

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

The build is staged across private phase specs: foundations, videos mode, tagging, movies, and TV. Phase 0 (foundations), Phase 1 (videos mode), and Phase 2 (tagging) are complete. Phase 3 (movies) is complete. Phase 4 (TV) is complete. Conventions and invariants live in `AGENTS.md`.

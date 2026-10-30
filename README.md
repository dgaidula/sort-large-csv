# sort-large-csv

An **external merge sort** for CSV files too large to fit in memory. Splits
the input into sorted chunks on disk, then k-way merges them back into a
single sorted file (or one file per distinct value of the sort column) —
with an optional **global** exact-row dedup pass along the way.

```sh
npx sort-large-csv --input big.csv --column email --dedupe
npx sort-large-csv -i big.csv -c state --split -D by-state/
npx sort-large-csv --help
```

Or install it: `npm i -g sort-large-csv`, then run `sort-large-csv ...`.

## What it’s good for

Sorting or splitting CSVs that are too big to load into memory or to sort
with a spreadsheet app — export dumps, list-merges, dedup passes on files
with hundreds of thousands to millions of rows. Uses a bounded amount of
memory regardless of input size: rows are buffered in fixed-size chunks,
sorted, and spilled to temporary files, then merged with one open read
stream per chunk.

## How it works

1. **Chunking** — reads the input in blocks of 50,000 rows, sorts each block
   in memory, and writes it to a temp file. (`SORT_LARGE_CSV_CHUNK_SIZE`
   overrides the block size; the tests use it.)
2. **Merging** — opens all temp chunk files at once and streams a k-way merge
   (repeatedly picks the lowest row across all open chunks), writing rows out
   in fully sorted order. Temp files are cleaned up when the run finishes (or
   fails).

Sort comparison is type-aware. Two values of the same recognized kind compare
by value; anything else falls back to a string locale compare:

- **Numbers**: the whole value is a plain decimal number, optionally signed,
  with an optional exponent (`10`, `-3.5`, `.5`, `1e2`). `1,000`, `$5` and
  `12%` are text.
- **ISO dates and date-times**: `YYYY-MM-DD`, optionally followed by `T` or a
  space and `HH:MM`, `HH:MM:SS` or `HH:MM:SS.fff`, and an optional `Z` or
  `±HH:MM` offset. A value with no offset is read as UTC, and a date alone is
  midnight.
- **Clock times**: `H:MM` or `HH:MM:SS` (optional `.fff`), with an optional
  `AM`/`PM` (`9:05` sorts before `10:30`; `12:00 AM` is midnight).

Other date formats (`03/01/2024`, `1 March 2024`) sort as text. Column headers are matched case-insensitively (trimmed and
lowercased), so `--column Email` matches an `Email`, `EMAIL`, or ` email `
header.

## Options

```
-i, --input <path>       Input CSV file (required)
-c, --column <name>      Column to sort/split/dedupe by (required)
-s, --split              Split output into one file per distinct value of
                          --column, instead of a single sorted file
-d, --dedupe             Remove duplicate rows (see Dedup behavior below)
-o, --output <filename>  Output filename, single-file mode only
                          (default: sorted_output.csv)
-D, --output-dir <dir>   Directory to write output file(s) into
                          (default: current directory; created if missing)
```

## Dedup behavior

`--dedupe` removes **exact-duplicate rows** — every column value must match.
It’s a *global* dedup: every row is checked against every row seen so far in
the entire file, not just the row immediately before it, so duplicates are
caught regardless of where they land after sorting (e.g. two identical rows
that sort into different, non-adjacent chunks). Distinct rows are never
merged or altered — only byte-for-byte duplicates are dropped.

Removed rows are written to `duplicates_log.csv` in the output directory, so
nothing is silently discarded.

## Example

```sh
npx sort-large-csv -i contacts.csv -c email -d -o contacts_sorted.csv
```

Sorts `contacts.csv` by the `email` column, removes exact duplicate rows
(logging them to `duplicates_log.csv`), and writes the result to
`contacts_sorted.csv`.

```sh
npx sort-large-csv -i orders.csv -c region --split -D by-region/
```

Splits `orders.csv` into one file per distinct `region` value, written into
`by-region/` as `output_<region>.csv`.

## Notes

- Temporary chunk files are written to a unique, per-run directory under the
  OS temp root (via `os.tmpdir()`) and removed automatically when the run
  finishes (or errors out, or the process is interrupted). Safe to run
  multiple instances concurrently — each gets its own temp directory.
- In split mode, output filenames are derived from the column value,
  lowercased, with letters (in any script) and digits kept and everything
  else replaced by `_` (`New York` → `output_new_york.csv`, `東京` →
  `output_東京.csv`). Values that map to the same name get numbered names in
  the order they’re first written (`NEW YORK` → `output_new_york_2.csv`), so
  no rows are lost. An empty value goes to `output_empty.csv`.
- A header-only input writes a header-only output (replacing any earlier
  output) and says it had 0 data rows. A 0-byte input is a usage error.
- A row with more fields than the header keeps only the header’s columns;
  the run warns on stderr with how many rows were affected and the first one.

## Limitations

- **`--dedupe` memory use is unbounded.** It keeps a `Set` of one signature
  string per *unique* row seen so far, held in memory for the whole merge
  phase — chunking and sorting stay disk-bounded, but dedup does not. On a
  file with a huge number of distinct rows, this can use a lot of memory even
  though the rest of the tool is designed to run in bounded memory.
- **Comma-delimited CSV only.** No support for tab-, semicolon-, or
  pipe-delimited files.
- **A header row is required.** The first line is always treated as column
  names; there’s no way to sort a headerless file.
- **Single-column sort key only.** `--column` takes exactly one column;
  there’s no multi-column or composite sort key.

## Known limits

- **Extra fields on a ragged row are dropped** (with a warning and a count,
  not silently); fix the input or add header names for them.
- **The output header is lowercased** (`Name,Amt` → `name,amt`), CRLF line ends
  become LF, and the output has no trailing newline.
- **An absolute `-o` path is placed under `--output-dir`** (`path.join`); pass
  the directory with `-D` and a bare file name with `-o`.
- **The merge re-sorts the open chunk heads for every row** and keeps every
  chunk file open at once: tens of millions of rows (hundreds of chunks) get
  slow, and more chunks than the open-file limit (about 12.8M rows at the
  macOS default of 256) may fail.
- **A hard crash or SIGKILL leaves the temp directory** (`sort-large-csv-*`
  under the OS temp root), for example when `--dedupe` runs out of heap.
  Ordinary failures and SIGINT/SIGTERM remove it.
- **String order depends on the locale** (`localeCompare`): `Ärla` sorts
  after `Zebra` under a Swedish locale and before it under English.
- **An interrupt during the merge leaves a partial output** under the final
  name.
- **`--split` keeps one file name per distinct value in memory** for the whole
  merge, and a very long value can exceed the file-system name limit (exit 3).
- **`-o ''`** exits 3 (`EISDIR`) rather than 2, and `--help` gives no usage line.
- **`require('sort-large-csv')`** parses the host’s argv and can exit the host;
  it is a CLI only.

## Exit codes

| Code | Meaning |
|--:|---|
| `0` | Ran to completion. |
| `1` | Partial: ran to completion but some items failed. Reserved — this tool has no per-item failure condition (a removed duplicate is a normal outcome), so it never exits `1`. |
| `2` | Usage: a required option (`--input`, `--column`) is missing, an option is unknown, has no value or is given more than once, the input path doesn’t exist or isn’t a file, the input has no header row (a 0-byte file), two header names are the same apart from case, or the `--column` isn’t in the header (the error lists the header’s columns). |
| `3` | Could not complete: an environment or internal failure, such as an unusable temp location, an output directory that can’t be created or written to, a disk-full or other I/O error, or an interrupt (SIGINT/SIGTERM). |

`--help` exits `0`. Errors print a one-line `error: …` on stderr (usage errors
also print the option list first). Temporary files are removed on every exit
path except a hard crash (see Known limits).

## Upgrading from 1.0.0

See [CHANGELOG.md](./CHANGELOG.md) for the full list. What can break a script:

- **Exit codes.** 1.0.0 exited `1` with `FATAL ERROR: <message>` on every error.
  2.0.0 exits `2` for usage errors (after the option list) and `3` when it
  could not complete, with one `error: …` line.
- **Stricter options.** Unknown options, which 1.0.0 ignored, and a repeated
  option are exit `2`. A `--column` that isn’t in the header is exit `2`
  (1.0.0 wrote unsorted output, or everything to `output_empty.csv` with
  `--split`). So are duplicate header names and a 0-byte input.
- **Sort order.** Dates, date-times and clock times sort chronologically, and
  only whole plain numbers sort numerically: 1.0.0 read `2024-03-01` as
  `2024` and `10 apples` as `10`.
- **Split file names.** Letters outside A–Z are kept (`output_zürich.csv`,
  where 1.0.0 wrote `output_z_rich.csv`), and values that collide get
  numbered names. 1.0.0 overwrote the earlier file and lost its rows.
- **Correct row counts at chunk boundaries.** An input that was an exact
  multiple of 50,000 rows usually had its last 50,000 rows written twice in
  1.0.0 (and logged as duplicates with `--dedupe`).
- **Header-only inputs** write a header-only output; 1.0.0 wrote nothing and
  left any earlier output in place.

On other input, stdout and the output files are the same as in 1.0.0.

## Requirements

Node 18+.

## License

MIT © Danniel T. Gaidula. See [LICENSE](./LICENSE).

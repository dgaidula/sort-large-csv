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
   in memory, and writes it to a temp file.
2. **Merging** — opens all temp chunk files at once and streams a k-way merge
   (repeatedly picks the lowest row across all open chunks), writing rows out
   in fully sorted order. Temp files are cleaned up when the run finishes (or
   fails).

Sort comparison is numeric-aware: if both values in the sort column parse as
numbers, they’re compared numerically; otherwise it falls back to a string
locale compare. Column headers are matched case-insensitively (trimmed and
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
- In split mode, output filenames are derived from the column value with
  non-alphanumeric characters replaced by `_` (e.g. `New York` →
  `output_new_york.csv`).

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

## Exit codes

| Code | Meaning |
|--:|---|
| `0` | Ran to completion. |
| `1` | Partial: ran to completion but some items failed. Reserved — this tool has no per-item failure condition (a removed duplicate is a normal outcome), so it never exits `1`. |
| `2` | Usage: a required option (`--input`, `--column`) is missing, an option is unknown, has no value or is given more than once, the input path doesn’t exist or isn’t a file, or the `--column` isn’t in the header (the error lists the header’s columns). |
| `3` | Could not complete: an environment or internal failure, such as an unusable temp location, an output directory that can’t be created or written to, a disk-full or other I/O error, or an interrupt (SIGINT/SIGTERM). |

`--help` exits `0`. Errors print a one-line `error: …` on stderr (usage errors
also print the option list first). Temporary files are removed on every exit
path. Stdout on a successful run is unchanged from 1.x.

## Requirements

Node 18+.

## License

[MIT](./LICENSE)

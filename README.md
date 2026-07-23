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

## What it's good for

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
numbers, they're compared numerically; otherwise it falls back to a string
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
It's a *global* dedup: every row is checked against every row seen so far in
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

- Temporary chunk files are written to a `temp_chunks/` directory alongside
  the script and removed automatically when the run finishes (or errors
  out). Don't run two instances against the same install concurrently.
- In split mode, output filenames are derived from the column value with
  non-alphanumeric characters replaced by `_` (e.g. `New York` →
  `output_new_york.csv`).

## Requirements

Node 18+.

## License

[MIT](./LICENSE)

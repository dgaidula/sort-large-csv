# Changelog

## 2.0.0 (unreleased)

Breaking changes from 1.0.0:

- Exit codes: every error was exit `1` with `FATAL ERROR: <message>`. Usage
  errors now exit `2` and print the option list, then one `error: …` line;
  anything that stops a run exits `3` with one `error: …` line. Exit `1` is
  reserved.
- Unknown options (ignored by 1.0.0) and a repeated option are usage errors.
- A `--column` that isn’t in the header is a usage error that lists the
  header’s columns. 1.0.0 wrote unsorted output, or put every row in
  `output_empty.csv` with `--split`.
- Duplicate header names, including names that differ only in case, are a
  usage error. 1.0.0 kept the last such column and dropped the others.
- A 0-byte input is a usage error (“input has no header row”).
- Sorting: a value compares numerically only when the whole value is a plain
  number; ISO dates and date-times, and clock times, compare chronologically.
  1.0.0 used `parseFloat`, so every date in a year tied and `10:30` sorted
  before `10:05`. In a column that mixes kinds, they sort empty, numbers,
  dates, times, then text; a ZIP+4 sorts with the numbers, after its 5-digit
  ZIP. A date or time that doesn’t exist (`2024-02-30`, `10:75`) is text.
- A row with more fields than the header exits `1` (the extra fields are
  still left out of the output, with a warning and a count); `--dedupe`
  compares the whole row, extra fields included. 1.0.0 dropped them silently
  and could merge two rows that differed only there.
- Empty header cells are named by position (`column_3`); 1.0.0 merged them
  into one column and kept only the last one’s values.
- `--split` file names keep letters in any script (`output_東京.csv`,
  `output_zürich.csv`), and values that map to the same name get numbered
  names (`output_new_york_2.csv`). 1.0.0 truncated the earlier file and lost
  its rows. A value that comes back after a tie appends to its file.

Fixes:

- An input that was an exact multiple of the 50,000-row chunk usually had its
  last chunk written twice (50,000 duplicated rows, or 50,000 false duplicates
  with `--dedupe`). The final chunk write is now awaited before the merge.
- A header-only input writes a header-only output (and an empty
  `duplicates_log.csv` with `--dedupe`), replacing any earlier output, and says
  it had 0 data rows. 1.0.0 wrote nothing and left the old files in place.
- `--dedupe` says “Removed 1 duplicate.” for one row (1.0.0: “1 duplicates”).
- Output write failures (an unwritable directory, a full disk) exit `3`
  instead of surfacing after “Done!”.

## 1.0.0

First release.

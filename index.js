#!/usr/bin/env node

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const csv = require('csv-parser');
const fastCsv = require('fast-csv');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const cliProgress = require('cli-progress');
const { pipeline } = require('stream');
const { promisify } = require('util');

const streamPipeline = promisify(pipeline);

// --- CONFIGURATION ---
// Rows per sorted chunk. SORT_LARGE_CSV_CHUNK_SIZE overrides it (the tests use
// small chunks to cross many chunk boundaries quickly).
const CHUNK_SIZE = parseInt(process.env.SORT_LARGE_CSV_CHUNK_SIZE, 10) > 0
    ? parseInt(process.env.SORT_LARGE_CSV_CHUNK_SIZE, 10)
    : 50000;
// Unique per-run temp dir under the OS temp root, not the package install dir:
// under npx / a global install, __dirname can be read-only, and a shared path
// would collide across concurrent runs. Created lazily in main().
let TEMP_DIR = null;
// Progress bar currently running, so a failure can stop it (a live bar keeps
// the event loop alive and leaves the cursor hidden).
let activeBar = null;

// --- EXIT CODES ---
// 0 ok, 1 partial (ran to completion, some items failed: a row's fields beyond
// the header were dropped), 2 usage, 3 could not complete.
const EXIT = { OK: 0, PARTIAL: 1, USAGE: 2, FAILED: 3 };

class UsageError extends Error {}

const oneLine = (msg) => String(msg).replace(/\s*\n\s*/g, ' ').trim();

function usageExit(msg) {
    cli.showHelp();
    console.error(`error: ${oneLine(msg)}`);
    process.exit(EXIT.USAGE);
}

// Safety net for anything not caught in main(): an unhandled stream 'error'
// event or a rejection from an async stream handler. Sync cleanup, then exit.
function fatalExit(err) {
    console.error(`error: ${oneLine(err && err.message ? err.message : err)}`);
    if (TEMP_DIR) {
        try { fs.removeSync(TEMP_DIR); } catch (e) { /* best effort */ }
    }
    process.exit(EXIT.FAILED);
}
process.on('uncaughtException', fatalExit);

// --- ARGUMENTS ---
const cli = yargs(hideBin(process.argv))
    .strict()
    .option('input', { alias: 'i', type: 'string', demandOption: true, requiresArg: true })
    .option('column', { alias: 'c', type: 'string', demandOption: true, requiresArg: true })
    .option('split', { alias: 's', type: 'boolean', default: false })
    .option('dedupe', { alias: 'd', type: 'boolean', description: 'Remove duplicate rows', default: false })
    .option('output', { alias: 'o', type: 'string', default: 'sorted_output.csv', requiresArg: true, description: 'Output filename (for single file mode)' })
    .option('output-dir', { alias: 'D', type: 'string', default: '.', requiresArg: true, description: 'Directory to save output files' })
    .fail((msg, err, y) => {
        // yargs reports some usage errors (an option with no value) as a YError.
        if (err && err.name !== 'YError') fatalExit(err);
        usageExit(msg || err.message);
    });
const argv = cli.argv;

// A repeated option parses to an array; the tool has always crashed on that.
for (const key of ['input', 'column', 'output', 'outputDir']) {
    if (typeof argv[key] !== 'string') usageExit(`option --${key === 'outputDir' ? 'output-dir' : key} must be given exactly once`);
}

const sortCol = argv.column.trim().toLowerCase();

// --- HELPERS ---

const compareRows = (a, b) => {
    // Ensure we are working with strings and trim any accidental spaces
    const valA = (a[sortCol] !== undefined && a[sortCol] !== null) ? String(a[sortCol]).trim() : '';
    const valB = (b[sortCol] !== undefined && b[sortCol] !== null) ? String(b[sortCol]).trim() : '';

    const keyA = sortKey(valA);
    const keyB = sortKey(valB);

    // Kinds sort in a fixed order, so a column that mixes them still has one
    // total order (every chunk and the merge must agree, or the output
    // depends on where the chunk boundaries fall).
    if (keyA.kind !== keyB.kind) return KIND_RANK[keyA.kind] - KIND_RANK[keyB.kind];
    if (keyA.kind === 'text') return valA.localeCompare(valB);
    return keyA.n - keyB.n;
};

// Empty first, then numbers, dates, clock times, and text last. A number is a
// whole plain number (not "2024-03-01", which parseFloat reads as 2024); a
// ZIP+4 (10001-1234) sorts with the numbers, just after its 5-digit ZIP. A
// date or time that doesn't exist (2024-02-30, 10:75) is text.
const KIND_RANK = { empty: 0, number: 1, date: 2, time: 3, text: 4 };
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const ZIP4_RE = /^(\d{5})-(\d{4})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*([AP]M)?$/i;
const TEXT = { kind: 'text' };
function sortKey(val) {
    if (val === '') return { kind: 'empty', n: 0 };
    if (NUMBER_RE.test(val)) return { kind: 'number', n: parseFloat(val) };
    let m = val.match(ZIP4_RE);
    if (m) return { kind: 'number', n: +m[1] + +m[2] / 10000 };
    m = val.match(ISO_DATE_RE);
    if (m) {
        const daysInMonth = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
        if (+m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > daysInMonth || +(m[4] || 0) > 23 || +(m[5] || 0) > 59 || +(m[6] || 0) > 59) return TEXT;
        let n = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) + (m[7] ? parseFloat(m[7]) * 1000 : 0);
        if (m[8] && m[8].toUpperCase() !== 'Z') {
            const off = m[8].replace(':', '');
            n -= (off[0] === '-' ? -1 : 1) * (+off.slice(1, 3) * 60 + +off.slice(3, 5)) * 60000;
        }
        return { kind: 'date', n };
    }
    m = val.match(TIME_RE);
    if (m) {
        if (+m[1] > (m[5] ? 12 : 23) || +m[2] > 59 || +(m[3] || 0) > 59) return TEXT;
        let h = +m[1];
        if (m[5]) h = (h % 12) + (m[5].toUpperCase() === 'PM' ? 12 : 0);
        return { kind: 'time', n: h * 3600 + +m[2] * 60 + +(m[3] || 0) + (m[4] ? parseFloat(m[4]) : 0) };
    }
    return TEXT;
}

// Split file name for a value: letters (any script) and digits kept,
// everything else '_', lowercased, NFC so macOS sees one name; `n` numbers
// the second and later values that map to the same name.
const getSafeFilename = (val, n) => {
    const safe = (val || 'empty').toString().normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '_').toLowerCase();
    return `output_${safe}${n ? `_${n}` : ''}.csv`;
};

const areRowsEqual = (rowA, rowB) => {
    if (!rowA || !rowB) return false;
    const keysA = Object.keys(rowA);
    const keysB = Object.keys(rowB);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (rowA[key] !== rowB[key]) return false;
    }
    return true;
};

// --- MAIN LOGIC ---

async function cleanupTempDir() {
    if (TEMP_DIR) {
        await fs.remove(TEMP_DIR);
    }
}

// Best-effort cleanup on Ctrl-C / kill so a killed run doesn't leave a temp
// dir behind. process.exit() here is safe since fs.remove has already run.
let cleaningUp = false;
async function cleanupAndExit(signal) {
    if (cleaningUp) return;
    cleaningUp = true;
    console.error(`\nReceived ${signal}, cleaning up temp files...`);
    await cleanupTempDir();
    process.exit(EXIT.FAILED);
}
process.on('SIGINT', () => cleanupAndExit('SIGINT'));
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

async function main() {
    try {
        checkInput(argv.input);
        console.log('--- CSV External Sort Tool (Pro) ---');
        TEMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'sort-large-csv-'));

        // Ensure output directory exists
        if (argv.outputDir !== '.') {
            await fs.ensureDir(argv.outputDir);
            console.log(`Output directory prepared: ${argv.outputDir}`);
        }

        // 1. PHASE ONE: CHUNKING
        const { chunkFiles, headers, extrasCol, raggedRows } = await createSortedChunks(argv.input);
        if (!headers) throw new UsageError(`input has no header row: ${argv.input}`);

        // 2. PHASE TWO: MERGING
        await mergeChunks(chunkFiles, headers, extrasCol);
        // Fields beyond the header were dropped from the output: a lossy run.
        if (raggedRows) process.exitCode = EXIT.PARTIAL;

        await cleanupTempDir();
        console.log('\nDone! Temporary files cleaned up.');

    } catch (err) {
        if (activeBar) activeBar.stop();
        if (err instanceof UsageError) cli.showHelp();
        console.error(`error: ${oneLine(err.message)}`);
        process.exitCode = err instanceof UsageError ? EXIT.USAGE : EXIT.FAILED;
        await cleanupTempDir();
    }
}

// Input path must exist and be a regular file; anything else is a usage error.
function checkInput(inputFile) {
    let st;
    try {
        st = fs.statSync(inputFile);
    } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
            throw new UsageError(`input file not found: ${inputFile}`);
        }
        throw err;
    }
    if (!st.isFile()) throw new UsageError(`input is not a file: ${inputFile}`);
}

async function createSortedChunks(inputFile) {
    console.log(`\nPhase 1: Reading and creating sorted chunks...`);
    const fileSize = fs.statSync(inputFile).size;
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(fileSize, 0);
    activeBar = bar;

    let rows = [];
    let chunkCount = 0;
    let chunkFiles = [];
    let headers = null;
    // Chunk-file column holding a ragged row's fields beyond the header (as
    // JSON), so --dedupe compares the whole row; never written to the output.
    let extrasCol = null;
    let chunkHeaders = null;

    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(inputFile);
        stream.on('data', (chunk) => bar.increment(chunk.length));
        stream.on('error', reject);

        // Pause/resume must be called on the parser (the stream the 'data'
        // listener is actually attached to), not on the raw file stream two
        // hops upstream. Pausing the wrong stream doesn't throttle the
        // parser's output, so rows keep arriving past CHUNK_SIZE with
        // nowhere bounded to stop — on any input with more than one chunk,
        // that raced the array to unbounded growth and OOM'd.
        const parser = stream.pipe(csv({
    		mapHeaders: ({ header, index }) => header.trim().toLowerCase() || `column_${index + 1}`
}));

        // The chunk write in flight, if any. 'end' can fire while the last
        // full chunk is still being written (the parser has nothing left to
        // pause), so the buffer is swapped out before the write and 'end'
        // waits for it -- otherwise those rows were written a second time.
        let inFlight = null;
        let raggedRows = 0;
        let firstRagged = 0;
        let rowNumber = 0;

        parser
            .on('headers', (h) => {
                headers = h;
                const fail = (msg) => {
                    parser.destroy();
                    stream.destroy();
                    reject(new UsageError(msg));
                };
                // Header names are matched case-insensitively, so two that
                // differ only in case would collapse into one column.
                const dupes = [...new Set(h.filter((name, i) => h.indexOf(name) !== i))];
                if (dupes.length) {
                    fail(`duplicate column name${dupes.length > 1 ? 's' : ''} (matched case-insensitively): ${dupes.map((d) => `"${d}"`).join(', ')}`);
                    return;
                }
                // A column not in the header would silently sort nothing and,
                // with --split, put every row in output_empty.csv.
                if (!h.includes(sortCol)) {
                    fail(`column not found: ${argv.column} (columns: ${h.join(', ')})`);
                }
                extrasCol = 'extra fields';
                while (h.includes(extrasCol)) extrasCol += '_';
                chunkHeaders = [...h, extrasCol];
            })
            .on('data', async (data) => {
                try {
                    rowNumber++;
                    const keys = Object.keys(data);
                    if (keys.length > headers.length) {
                        if (!raggedRows) firstRagged = rowNumber;
                        raggedRows++;
                        data[extrasCol] = JSON.stringify(keys.slice(headers.length).map((k) => data[k]));
                    }
                    rows.push(data);
                    if (rows.length >= CHUNK_SIZE) {
                        // pause() is the backpressure: no row may arrive
                        // while a chunk is being written. A second full
                        // chunk during a write means it isn't working and
                        // memory is growing without bound.
                        if (inFlight) throw new Error('internal: a chunk filled while the previous one was still being written');
                        parser.pause();
                        const full = rows;
                        rows = [];
                        inFlight = writeChunk(full, chunkCount++, chunkHeaders).then((chunkPath) => { chunkFiles.push(chunkPath); });
                        await inFlight;
                        inFlight = null;
                        parser.resume();
                    }
                } catch (err) {
                    reject(err);
                }
            })
            .on('end', async () => {
                try {
                    if (inFlight) await inFlight;
                    if (rows.length > 0) {
                        const chunkPath = await writeChunk(rows, chunkCount++, chunkHeaders);
                        chunkFiles.push(chunkPath);
                    }
                    bar.stop();
                    if (raggedRows) {
                        console.error(`warning: ${raggedRows} row${raggedRows === 1 ? '' : 's'} had more fields than the header (first: data row ${firstRagged}); the extra fields were dropped.`);
                    }
                    resolve({ chunkFiles, headers, extrasCol, raggedRows });
                } catch (err) {
                    reject(err);
                }
            })
            .on('error', reject);
    });
}

async function writeChunk(rows, index, headers) {
    rows.sort(compareRows);
    const filePath = path.join(TEMP_DIR, `chunk_${index}.csv`);
    const ws = fs.createWriteStream(filePath);
    return new Promise((resolve, reject) => {
        fastCsv.write(rows, { headers })
            .pipe(ws)
            .on('finish', () => resolve(filePath))
            .on('error', reject);
    });
}

// Pull one row from a paused-mode readable stream, waiting for 'readable' if
// none is buffered yet. Deliberately NOT the flowing-mode once('data') /
// once('end') pattern this replaced: 'end' fires exactly once for the whole
// life of a stream, so re-registering a fresh once('end') listener every
// call can miss it if it already fired (the readableEnded check below
// catches that), and pause()/resume() ping-ponging in flowing mode can leave
// a listener waiting on a 'data' that flow() already delivered to a
// resolved-and-discarded earlier promise. That combination silently
// stalled the merge mid-run — reproduced with two chunks and a run of
// tied sort-column values at a chunk's tail (e.g. many exact amount
// duplicates before a chunk boundary) dropping the tail rows with no error.
function readNextRow(stream) {
    return new Promise((resolve, reject) => {
        const data = stream.read();
        if (data !== null) {
            resolve(data);
            return;
        }
        if (stream.readableEnded) {
            resolve(null);
            return;
        }
        const onReadable = () => { cleanup(); resolve(readNextRow(stream)); };
        const onEnd = () => { cleanup(); resolve(null); };
        const onError = (err) => { cleanup(); reject(err); };
        function cleanup() {
            stream.removeListener('readable', onReadable);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onError);
        }
        stream.once('readable', onReadable);
        stream.once('end', onEnd);
        stream.once('error', onError);
    });
}

async function mergeChunks(chunkFiles, headers, extrasCol) {
    console.log(`\nPhase 2: Merging ${chunkFiles.length} chunks...`);
    if (chunkFiles.length === 0) {
        // A header with no data rows: still write (and so replace) the
        // output, header only, so a later step never reads a stale file.
        console.log('The input has a header and 0 data rows.');
        const outputs = [];
        if (!argv.split) outputs.push({ file: argv.output, writer: fastCsv.format({ headers, alwaysWriteHeaders: true }) });
        if (argv.dedupe) outputs.push({ file: 'duplicates_log.csv', writer: fastCsv.format({ headers: true }) });
        for (const { file, writer } of outputs) {
            const done = streamPipeline(writer, fs.createWriteStream(path.join(argv.outputDir, file)));
            writer.end();
            await done;
        }
        return;
    }

    const streams = chunkFiles.map(file => fs.createReadStream(file).pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() })));

    const streamHeads = await Promise.all(streams.map(async (stream) => {
        const data = await readNextRow(stream);
        return data === null ? null : { data, stream };
    }));

    let activeHeads = streamHeads.filter(h => h !== null);
    // A row as written to the output: without the chunk files' extras column.
    const visible = (row) => { const { [extrasCol]: extras, ...rest } = row; return rest; };

    let currentWriter = null;
    let currentSplitVal = null;
    const splitFiles = new Map(); // split value -> its file name
    const splitNames = new Map(); // file name -> settles when its last writer closes
    let mainOutputStream = null;
    let dupeWriter = null;

    // Track every output stream so a write failure (unwritable directory, disk
    // full) fails the run instead of surfacing after "Done!" or not at all.
    let outputError = null;
    const outputDone = [];
    const trackOutput = (ws) => {
        outputDone.push(new Promise((resolve) => {
            ws.on('finish', resolve);
            ws.on('error', (err) => { outputError = outputError || err; resolve(); });
        }));
        return ws;
    };

    // Resolve Output Path Helper
    const getOutputPath = (filename) => path.join(argv.outputDir, filename);

    // Setup Main Output (if not splitting)
    if (!argv.split) {
        const outPath = getOutputPath(argv.output);
        mainOutputStream = trackOutput(fs.createWriteStream(outPath));
        currentWriter = fastCsv.format({ headers: true });
        currentWriter.pipe(mainOutputStream);
    }

    // Setup Dedupe Log (Always goes to output dir)
    if (argv.dedupe) {
        const dupePath = getOutputPath('duplicates_log.csv');
        const dupeStream = trackOutput(fs.createWriteStream(dupePath));
        dupeWriter = fastCsv.format({ headers: true });
        dupeWriter.pipe(dupeStream);
    }

    const mergeBar = new cliProgress.SingleBar({
        format: 'Merging | {bar} | {value} Rows | {dupes} Dupes Found'
    }, cliProgress.Presets.shades_classic);
    mergeBar.start(100, 0, { dupes: 0 });
    activeBar = mergeBar;

    let rowsProcessed = 0;
    let dupeCount = 0;
    const seenRowKeys = new Set(); // global exact-row dedupe (see note below)

    while (activeHeads.length > 0) {
        if (outputError) throw outputError;
        activeHeads.sort((a, b) => compareRows(a.data, b.data));
        const winner = activeHeads[0];
        const currentRow = winner.data;

        let isDuplicate = false;

        if (argv.dedupe) {
            // GLOBAL exact-row dedupe. (Previously this only compared each row to the
            // immediately-preceding written row, so it caught duplicates ONLY when they
            // were adjacent after the Year sort — non-adjacent exact duplicates within a
            // year slipped through. A Set of row signatures catches every exact duplicate
            // regardless of position. Exact-match only, so distinct records are never lost.)
            const rowKey = JSON.stringify(Object.keys(currentRow).sort().map(k => currentRow[k]));
            if (seenRowKeys.has(rowKey)) {
                isDuplicate = true;
                dupeCount++;
                dupeWriter.write(visible(currentRow));
            } else {
                seenRowKeys.add(rowKey);
            }
        }

        if (!isDuplicate) {
            if (argv.split) {
                const rowVal = currentRow[sortCol];
                if (rowVal !== currentSplitVal) {
                    if (currentWriter) currentWriter.end();
                    currentSplitVal = rowVal;

                    // One file per distinct value for the whole merge. A value
                    // whose safe name is taken (New York / NEW YORK / new-york)
                    // gets a numbered name; a value that comes back after a
                    // tie (10 / 10.0 / 10) appends to its file once the
                    // earlier writer has finished, instead of truncating it.
                    let filename = splitFiles.get(rowVal);
                    const revisit = filename !== undefined;
                    if (!revisit) {
                        filename = getSafeFilename(rowVal);
                        for (let n = 2; splitNames.has(filename); n++) filename = getSafeFilename(rowVal, n);
                        splitFiles.set(rowVal, filename);
                    } else {
                        await splitNames.get(filename);
                    }
                    const ws = trackOutput(fs.createWriteStream(getOutputPath(filename), { flags: revisit ? 'a' : 'w' }));
                    splitNames.set(filename, new Promise((resolve) => { ws.on('close', resolve); ws.on('error', resolve); }));
                    if (revisit) ws.write('\n'); // fast-csv ends a file without a row delimiter

                    currentWriter = fastCsv.format({ headers: true, writeHeaders: !revisit });
                    currentWriter.pipe(ws);
                }
                currentWriter.write(visible(currentRow));
            } else {
                currentWriter.write(visible(currentRow));
            }
        }

        rowsProcessed++;
        if(rowsProcessed % 1000 === 0) mergeBar.update(rowsProcessed, { dupes: dupeCount });

        const nextData = await readNextRow(winner.stream);
        if (nextData) {
            winner.data = nextData;
        } else {
            activeHeads.shift();
        }
    }

    if (currentWriter) currentWriter.end();
    if (dupeWriter) dupeWriter.end();
    mergeBar.stop();
    await Promise.all(outputDone);
    if (outputError) throw outputError;

    if (argv.dedupe) {
        console.log(`\nCompleted. Removed ${dupeCount} duplicate${dupeCount === 1 ? '' : 's'}.`);
    }
}

// Guard against side effects on require(): removing "main" from package.json
// doesn't stop Node from falling back to this file (its literal filename is
// index.js), so only run automatically when invoked directly as the CLI.
if (require.main === module) {
    main();
}
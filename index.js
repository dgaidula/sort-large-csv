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
const CHUNK_SIZE = 50000;
// Unique per-run temp dir under the OS temp root, not the package install dir:
// under npx / a global install, __dirname can be read-only, and a shared path
// would collide across concurrent runs. Created lazily in main().
let TEMP_DIR = null;

// --- ARGUMENTS ---
const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('column', { alias: 'c', type: 'string', demandOption: true })
    .option('split', { alias: 's', type: 'boolean', default: false })
    .option('dedupe', { alias: 'd', type: 'boolean', description: 'Remove duplicate rows', default: false })
    .option('output', { alias: 'o', type: 'string', default: 'sorted_output.csv', description: 'Output filename (for single file mode)' })
    .option('output-dir', { alias: 'D', type: 'string', default: '.', description: 'Directory to save output files' })
    .argv;

const sortCol = argv.column.trim().toLowerCase();

// --- HELPERS ---

const compareRows = (a, b) => {
    // Ensure we are working with strings and trim any accidental spaces
    const valA = (a[sortCol] !== undefined && a[sortCol] !== null) ? String(a[sortCol]).trim() : '';
    const valB = (b[sortCol] !== undefined && b[sortCol] !== null) ? String(b[sortCol]).trim() : '';

    const numA = parseFloat(valA);
    const numB = parseFloat(valB);

    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return valA.localeCompare(valB);
};

const getSafeFilename = (val) => {
    const safe = (val || 'empty').toString().replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `output_${safe}.csv`;
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
    process.exit(1);
}
process.on('SIGINT', () => cleanupAndExit('SIGINT'));
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

async function main() {
    try {
        console.log('--- CSV External Sort Tool (Pro) ---');
        TEMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'sort-large-csv-'));

        // Ensure output directory exists
        if (argv.outputDir !== '.') {
            await fs.ensureDir(argv.outputDir);
            console.log(`Output directory prepared: ${argv.outputDir}`);
        }

        // 1. PHASE ONE: CHUNKING
        const chunkFiles = await createSortedChunks(argv.input);

        // 2. PHASE TWO: MERGING
        await mergeChunks(chunkFiles);

        await cleanupTempDir();
        console.log('\nDone! Temporary files cleaned up.');

    } catch (err) {
        console.error('\nFATAL ERROR:', err.message);
        await cleanupTempDir();
        process.exitCode = 1;
    }
}

async function createSortedChunks(inputFile) {
    console.log(`\nPhase 1: Reading and creating sorted chunks...`);
    const fileSize = fs.statSync(inputFile).size;
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(fileSize, 0);

    let rows = [];
    let chunkCount = 0;
    let chunkFiles = [];
    let headers = null;

    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(inputFile);
        stream.on('data', (chunk) => bar.increment(chunk.length));

        // Pause/resume must be called on the parser (the stream the 'data'
        // listener is actually attached to), not on the raw file stream two
        // hops upstream. Pausing the wrong stream doesn't throttle the
        // parser's output, so rows keep arriving past CHUNK_SIZE with
        // nowhere bounded to stop — on any input with more than one chunk,
        // that raced the array to unbounded growth and OOM'd.
        const parser = stream.pipe(csv({
    		mapHeaders: ({ header }) => header.trim().toLowerCase()
}));

        parser
            .on('headers', (h) => headers = h)
            .on('data', async (data) => {
                rows.push(data);
                if (rows.length >= CHUNK_SIZE) {
                    parser.pause();
                    const chunkPath = await writeChunk(rows, chunkCount++, headers);
                    chunkFiles.push(chunkPath);
                    rows = [];
                    parser.resume();
                }
            })
            .on('end', async () => {
                if (rows.length > 0) {
                    const chunkPath = await writeChunk(rows, chunkCount++, headers);
                    chunkFiles.push(chunkPath);
                }
                bar.stop();
                resolve(chunkFiles);
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

async function mergeChunks(chunkFiles) {
    console.log(`\nPhase 2: Merging ${chunkFiles.length} chunks...`);
    if (chunkFiles.length === 0) return;

    const streams = chunkFiles.map(file => fs.createReadStream(file).pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() })));

    const streamHeads = await Promise.all(streams.map(async (stream) => {
        const data = await readNextRow(stream);
        return data === null ? null : { data, stream };
    }));

    let activeHeads = streamHeads.filter(h => h !== null);

    let currentWriter = null;
    let currentSplitVal = null;
    let mainOutputStream = null;
    let dupeWriter = null;

    // Resolve Output Path Helper
    const getOutputPath = (filename) => path.join(argv.outputDir, filename);

    // Setup Main Output (if not splitting)
    if (!argv.split) {
        const outPath = getOutputPath(argv.output);
        mainOutputStream = fs.createWriteStream(outPath);
        currentWriter = fastCsv.format({ headers: true });
        currentWriter.pipe(mainOutputStream);
    }

    // Setup Dedupe Log (Always goes to output dir)
    if (argv.dedupe) {
        const dupePath = getOutputPath('duplicates_log.csv');
        const dupeStream = fs.createWriteStream(dupePath);
        dupeWriter = fastCsv.format({ headers: true });
        dupeWriter.pipe(dupeStream);
    }

    const mergeBar = new cliProgress.SingleBar({
        format: 'Merging | {bar} | {value} Rows | {dupes} Dupes Found'
    }, cliProgress.Presets.shades_classic);
    mergeBar.start(100, 0, { dupes: 0 });

    let rowsProcessed = 0;
    let dupeCount = 0;
    const seenRowKeys = new Set(); // global exact-row dedupe (see note below)

    while (activeHeads.length > 0) {
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
                dupeWriter.write(currentRow);
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

                    // Create new split file in the output directory
                    const filename = getSafeFilename(rowVal);
                    const ws = fs.createWriteStream(getOutputPath(filename));

                    currentWriter = fastCsv.format({ headers: true });
                    currentWriter.pipe(ws);
                }
                currentWriter.write(currentRow);
            } else {
                currentWriter.write(currentRow);
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

    if (argv.dedupe) {
        console.log(`\nCompleted. Removed ${dupeCount} duplicates.`);
    }
}

// Guard against side effects on require(): removing "main" from package.json
// doesn't stop Node from falling back to this file (its literal filename is
// index.js), so only run automatically when invoked directly as the CLI.
if (require.main === module) {
    main();
}
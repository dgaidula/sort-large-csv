#!/usr/bin/env node

// Gemini PRO 3 version

const fs = require('fs-extra');
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
const TEMP_DIR = path.join(__dirname, 'temp_chunks');

// --- ARGUMENTS ---
const argv = yargs(hideBin(process.argv))
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .option('column', { alias: 'c', type: 'string', demandOption: true })
    .option('split', { alias: 's', type: 'boolean', default: false })
    .option('dedupe', { alias: 'd', type: 'boolean', description: 'Remove duplicate rows', default: false })
    .option('output', { alias: 'o', type: 'string', default: 'sorted_output.csv' })
    .argv;

const sortCol = argv.column;

// --- HELPERS ---

const compareRows = (a, b) => {
    const valA = a[sortCol];
    const valB = b[sortCol];
    const numA = parseFloat(valA);
    const numB = parseFloat(valB);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(valA).localeCompare(String(valB));
};

const getSafeFilename = (val) => {
    const safe = (val || 'empty').toString().replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return `output_${safe}.csv`;
};

// Quick way to check if two row objects are identical
const areRowsEqual = (rowA, rowB) => {
    if (!rowA || !rowB) return false;
    const keysA = Object.keys(rowA);
    const keysB = Object.keys(rowB);
    if (keysA.length !== keysB.length) return false;
    // Check every value
    for (const key of keysA) {
        if (rowA[key] !== rowB[key]) return false;
    }
    return true;
};

// --- MAIN LOGIC ---

async function main() {
    try {
        console.log('--- CSV External Sort Tool (Pro) ---');
        await fs.emptyDir(TEMP_DIR);

        // 1. PHASE ONE: CHUNKING
        const chunkFiles = await createSortedChunks(argv.input);

        // 2. PHASE TWO: MERGING
        await mergeChunks(chunkFiles);

        await fs.remove(TEMP_DIR);
        console.log('\nDone! Temporary files cleaned up.');

    } catch (err) {
        console.error('\nFATAL ERROR:', err.message);
        await fs.remove(TEMP_DIR);
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

        stream.pipe(csv())
            .on('headers', (h) => headers = h)
            .on('data', async (data) => {
                rows.push(data);
                if (rows.length >= CHUNK_SIZE) {
                    stream.pause();
                    const chunkPath = await writeChunk(rows, chunkCount++, headers);
                    chunkFiles.push(chunkPath);
                    rows = [];
                    stream.resume();
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

async function mergeChunks(chunkFiles) {
    console.log(`\nPhase 2: Merging ${chunkFiles.length} chunks...`);
    if (chunkFiles.length === 0) return;

    // Open streams
    const streams = chunkFiles.map(file => fs.createReadStream(file).pipe(csv()));

    // Initialize stream heads
    const streamHeads = await Promise.all(streams.map(stream => new Promise(resolve => {
        stream.once('data', (data) => {
            stream.pause();
            resolve({ data, stream });
        });
        stream.on('end', () => resolve(null));
    })));

    let activeHeads = streamHeads.filter(h => h !== null);

    // Writers setup
    let currentWriter = null;
    let currentSplitVal = null;
    let mainOutputStream = null;
    let dupeWriter = null;

    // Setup Main Output
    if (!argv.split) {
        mainOutputStream = fs.createWriteStream(argv.output);
        currentWriter = fastCsv.format({ headers: true });
        currentWriter.pipe(mainOutputStream);
    }

    // Setup Dedupe Log
    if (argv.dedupe) {
        const dupeStream = fs.createWriteStream('duplicates_log.csv');
        dupeWriter = fastCsv.format({ headers: true });
        dupeWriter.pipe(dupeStream);
    }

    const mergeBar = new cliProgress.SingleBar({
        format: 'Merging | {bar} | {value} Rows | {dupes} Dupes Found'
    }, cliProgress.Presets.shades_classic);
    mergeBar.start(100, 0, { dupes: 0 });

    let rowsProcessed = 0;
    let dupeCount = 0;
    let lastWrittenRow = null; // To track the previous row for deduplication

    while (activeHeads.length > 0) {
        // Find winner
        activeHeads.sort((a, b) => compareRows(a.data, b.data));
        const winner = activeHeads[0];
        const currentRow = winner.data;

        let isDuplicate = false;

        // --- DEDUPE LOGIC ---
        if (argv.dedupe && lastWrittenRow) {
            if (areRowsEqual(currentRow, lastWrittenRow)) {
                isDuplicate = true;
                dupeCount++;
                dupeWriter.write(currentRow); // Log the dupe
            }
        }

        // --- WRITE LOGIC (If not a duplicate) ---
        if (!isDuplicate) {
            if (argv.split) {
                const rowVal = currentRow[sortCol];
                if (rowVal !== currentSplitVal) {
                    if (currentWriter) currentWriter.end();
                    currentSplitVal = rowVal;
                    const filename = getSafeFilename(rowVal);
                    const ws = fs.createWriteStream(filename);
                    currentWriter = fastCsv.format({ headers: true });
                    currentWriter.pipe(ws);
                }
                currentWriter.write(currentRow);
            } else {
                currentWriter.write(currentRow);
            }

            // Update lastWrittenRow only if we actually wrote it to the main file
            lastWrittenRow = currentRow;
        }

        rowsProcessed++;
        if(rowsProcessed % 1000 === 0) mergeBar.update(rowsProcessed, { dupes: dupeCount });

        // Advance stream
        const nextDataPromise = new Promise(resolve => {
            winner.stream.once('data', (data) => {
                winner.stream.pause();
                resolve(data);
            });
            winner.stream.once('end', () => resolve(null));
            winner.stream.resume();
        });

        const nextData = await nextDataPromise;
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
        console.log(`\nCompleted. Removed ${dupeCount} duplicates. Log saved to 'duplicates_log.csv'.`);
    }
}

main();
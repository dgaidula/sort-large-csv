'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'index.js');

// The commit whose index.js is the published 1.0.0 (HEAD moves once this
// change is committed, so the baseline is pinned by hash).
const BASELINE_REF = '13cc244';

const FIXTURE = 'Name,Amt\nb,2\na,1\nb,2\nc,10\nd,3\n';

// One scratch dir per run: fixture, 1.0.0 copy, per-run cwd and a private
// TMPDIR so tests can see whether the tool left temp directories behind.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slc-test-'));
test.after(() => {
    fs.chmodSync(path.join(scratch, 'ro'), 0o755);
    fs.rmSync(scratch, { recursive: true, force: true });
});
fs.mkdirSync(path.join(scratch, 'ro'));
const fixture = path.join(scratch, 'in.csv');
fs.writeFileSync(fixture, FIXTURE);

let runCount = 0;
function run(cli, args, extraEnv = {}) {
    const dir = path.join(scratch, `run${runCount++}`);
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const res = spawnSync(process.execPath, [cli, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules'), TMPDIR: tmp, ...extraEnv },
    });
    const leftovers = fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((n) => n.startsWith('sort-large-csv-')) : [];
    return { ...res, dir, leftovers };
}

function tree(dir) {
    const out = {};
    const walk = (d) => {
        for (const name of fs.readdirSync(d).sort()) {
            if (name === 'tmp') continue;
            const p = path.join(d, name);
            if (fs.statSync(p).isDirectory()) walk(p);
            else out[path.relative(dir, p)] = fs.readFileSync(p);
        }
    };
    walk(dir);
    return out;
}

test('exit 0 on a clean run, output sorted, temp dir removed', () => {
    const r = run(CLI, ['-i', fixture, '-c', 'amt']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
        fs.readFileSync(path.join(r.dir, 'sorted_output.csv'), 'utf8').replace(/\r\n/g, '\n'),
        'name,amt\na,1\nb,2\nb,2\nd,3\nc,10',
    );
    assert.deepEqual(r.leftovers, []);
});

test('--help exits 0', () => {
    assert.equal(run(CLI, ['--help']).status, 0);
});

test('clean-run output is byte-identical to 1.0.0 (stdout and files)', () => {
    const old = path.join(scratch, 'index-1.0.0.js');
    fs.writeFileSync(old, execFileSync('git', ['show', `${BASELINE_REF}:index.js`], { cwd: ROOT }));
    for (const args of [
        ['-i', fixture, '-c', 'amt'],
        ['-i', fixture, '-c', 'amt', '--dedupe', '-o', 'out.csv', '-D', 'outdir'],
        ['-i', fixture, '-c', 'name', '--split', '--dedupe', '-D', 'by-name'],
    ]) {
        const a = run(old, args);
        const b = run(CLI, args);
        assert.equal(a.status, 0, a.stderr);
        assert.equal(b.status, 0, b.stderr);
        // 2.0.0 says "Removed 1 duplicate." (1.0.0: "1 duplicates"); nothing else differs.
        assert.equal(b.stdout, a.stdout.replace('Removed 1 duplicates.', 'Removed 1 duplicate.'));
        const ta = tree(a.dir);
        const tb = tree(b.dir);
        assert.deepEqual(Object.keys(tb), Object.keys(ta));
        for (const k of Object.keys(ta)) assert.ok(tb[k].equals(ta[k]), `${k} differs`);
    }
});

test('exit 2 when required arguments are missing', () => {
    for (const args of [[], ['-i', fixture], ['-c', 'amt']]) {
        const r = run(CLI, args);
        assert.equal(r.status, 2, args.join(' '));
        assert.match(r.stderr, /^error: Missing required argument/m);
        assert.deepEqual(r.leftovers, []);
    }
});

test('exit 2 when an option is given twice', () => {
    const r = run(CLI, ['-i', fixture, '-c', 'amt', '-c', 'name']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^error: /m);
});

test('exit 2 when the input file is missing', () => {
    const r = run(CLI, ['-i', path.join(scratch, 'nope.csv'), '-c', 'amt']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^error: input file not found/m);
    assert.deepEqual(r.leftovers, []);
});

test('exit 2 when the input path is a directory', () => {
    const r = run(CLI, ['-i', scratch, '-c', 'amt']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^error: input is not a file/m);
    assert.deepEqual(r.leftovers, []);
});

test('exit 3 when the temp location is unusable', () => {
    const r = run(CLI, ['-i', fixture, '-c', 'amt'], { TMPDIR: path.join(scratch, 'no-such-tmp') });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /^error: /m);
});

test('exit 3 when the output directory cannot be created', () => {
    const r = run(CLI, ['-i', fixture, '-c', 'amt', '-D', fixture]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /^error: /m);
    assert.deepEqual(r.leftovers, []);
});

test('exit 3 when the output directory is not writable', { skip: process.getuid && process.getuid() === 0 }, () => {
    fs.chmodSync(path.join(scratch, 'ro'), 0o555);
    for (const extra of [[], ['--split'], ['--dedupe']]) {
        const r = run(CLI, ['-i', fixture, '-c', 'amt', '-D', path.join(scratch, 'ro'), ...extra]);
        assert.equal(r.status, 3, extra.join(' '));
        assert.match(r.stderr, /^error: /m);
        assert.doesNotMatch(r.stdout, /Done!/);
        assert.deepEqual(r.leftovers, []);
    }
});

// Exit 1 (a row's extra fields were dropped) is tested with the 2.0.0 fixes below.

test('exit 2 when --column is not in the header, naming it and the columns', () => {
    for (const extra of [[], ['--split']]) {
        const r = run(CLI, ['-i', fixture, '-c', 'Nope', ...extra]);
        assert.equal(r.status, 2, extra.join(' '));
        assert.match(r.stderr, /^error: column not found: Nope \(columns: name, amt\)$/m);
        assert.match(r.stderr, /Options:/);
        assert.deepEqual(fs.readdirSync(r.dir).filter((n) => n !== 'tmp'), []);
        assert.deepEqual(r.leftovers, []);
    }
});

test('exit 2 on an unknown option or an option with no value', () => {
    for (const args of [['-i', fixture, '-c', 'amt', '--spilt'], ['-i', fixture, '-c'], ['-i', fixture, '-c', '-D', 'x']]) {
        const r = run(CLI, args);
        assert.equal(r.status, 2, args.join(' '));
        assert.match(r.stderr, /^error: (Unknown argument: spilt|Not enough arguments following: c)$/m);
        assert.match(r.stderr, /Options:/);
    }
});

test('usage errors after parsing also print the usage hint on stderr', () => {
    for (const args of [['-i', path.join(scratch, 'nope.csv'), '-c', 'amt'], ['-i', fixture, '-c', 'amt', '-c', 'name']]) {
        const r = run(CLI, args);
        assert.equal(r.status, 2, args.join(' '));
        assert.match(r.stderr, /Options:[\s\S]*--column[\s\S]*^error: /m);
    }
});

// The run must still be in phase 1 when the signal lands, so the input is
// large enough to take a while.
const bigFixture = path.join(scratch, 'big.csv');
fs.writeFileSync(bigFixture, 'Name,Amt\n' + Array.from({ length: 400000 }, (_, i) => `n${i % 977},${(i * 7919) % 100003}`).join('\n') + '\n');

for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`exit 3 on ${signal} mid-run, temp dir removed`, async () => {
        const dir = path.join(scratch, `run${runCount++}`);
        const tmp = path.join(dir, 'tmp');
        fs.mkdirSync(tmp, { recursive: true });
        const child = spawn(process.execPath, [CLI, '-i', bigFixture, '-c', 'amt', '--split'], {
            cwd: dir,
            env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules'), TMPDIR: tmp },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let tempAtSignal = null;
        child.stderr.resume();
        child.stdout.on('data', (d) => {
            stdout += d;
            if (tempAtSignal === null && stdout.includes('Phase 1')) {
                tempAtSignal = fs.readdirSync(tmp).filter((n) => n.startsWith('sort-large-csv-'));
                child.kill(signal);
            }
        });
        const [code, sig] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
        assert.equal(tempAtSignal.length, 1);
        assert.equal(sig, null);
        assert.equal(code, 3);
        assert.doesNotMatch(stdout, /Done!/);
        assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('sort-large-csv-')), []);
    });
}

// --- 2.0.0 release fixes ---------------------------------------------------

function runIn(input, args, extraEnv) {
    const file = path.join(scratch, `in${runCount}.csv`);
    fs.writeFileSync(file, input);
    return run(CLI, ['-i', file, ...args], extraEnv);
}
const dataRows = (text) => text.replace(/\r\n/g, '\n').split('\n').filter(Boolean).slice(1);

test('chunk boundaries: exact multiples and non-multiples keep every row exactly once (several runs)', () => {
    const make = (n) => 'id,amt\n' + Array.from({ length: n }, (_, i) => `u${i},${(i * 7919) % 100003}`).join('\n') + '\n';
    const check = (n, env, label) => {
        const r = runIn(make(n), ['-c', 'amt', '-o', 'out.csv'], env);
        assert.equal(r.status, 0, `${label}: ${r.stderr}`);
        const out = dataRows(fs.readFileSync(path.join(r.dir, 'out.csv'), 'utf8'));
        assert.equal(out.length, n, `${label}: row count`);
        assert.equal(new Set(out).size, n, `${label}: every row once`);
        const amts = out.map((l) => Number(l.split(',')[1]));
        assert.ok(amts.every((v, i) => i === 0 || amts[i - 1] <= v), `${label}: sorted`);
    };
    // The default 50,000-row chunk at exactly 2 chunks (raced in most 1.0.0 runs).
    for (let run = 1; run <= 3; run++) check(100000, {}, `100000 rows, run ${run}`);
    // Small chunks: many boundaries, on and off a multiple.
    for (const n of [999, 1000, 1001, 2000, 2500, 3000]) {
        for (let run = 1; run <= 2; run++) check(n, { SORT_LARGE_CSV_CHUNK_SIZE: '1000' }, `${n} rows / 1000-row chunks, run ${run}`);
    }
});

test('ISO dates, date-times and clock times sort chronologically; plain numbers numerically', () => {
    const sorted = (header, values) => {
        const r = runIn(`id,${header}\n` + values.map((v, i) => `${i},${v}`).join('\n') + '\n', ['-c', header, '-o', 'out.csv']);
        assert.equal(r.status, 0, r.stderr);
        return dataRows(fs.readFileSync(path.join(r.dir, 'out.csv'), 'utf8')).map((l) => l.split(',')[1]);
    };
    assert.deepEqual(sorted('date', ['2024-03-01', '2024-01-15', '2023-12-31', '2024-02-10', '2023-01-05']),
        ['2023-01-05', '2023-12-31', '2024-01-15', '2024-02-10', '2024-03-01']);
    assert.deepEqual(sorted('at', ['2024-03-01T10:00:00Z', '2024-03-01 09:30', '2024-03-01T12:00:00+05:00', '2024-03-01']),
        ['2024-03-01', '2024-03-01T12:00:00+05:00', '2024-03-01 09:30', '2024-03-01T10:00:00Z']);
    assert.deepEqual(sorted('time', ['10:30', '10:05', '9:05', '1:15 PM', '12:00 AM', '23:59:59']),
        ['12:00 AM', '9:05', '10:05', '10:30', '1:15 PM', '23:59:59']);
    assert.deepEqual(sorted('amt', ['10', '2', '-3.5', '1e2', '.5']), ['-3.5', '.5', '2', '10', '1e2']);
});

test('--split never loses rows: colliding and non-Latin names get their own files, tied values append', () => {
    const r = runIn('id,city\n1,New York\n2,NEW YORK\n3,new-york\n4,Boston\n5,東京\n6,大阪\n7,New York\n', ['-c', 'city', '--split', '-D', 's']);
    assert.equal(r.status, 0, r.stderr);
    const dir = path.join(r.dir, 's');
    const files = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, dataRows(fs.readFileSync(path.join(dir, f), 'utf8'))]));
    assert.equal(Object.values(files).flat().length, 7);
    assert.deepEqual(files['output_new_york.csv'], ['1,New York', '7,New York']);
    assert.deepEqual(files['output_new_york_2.csv'], ['2,NEW YORK']);
    assert.deepEqual(files['output_new_york_3.csv'], ['3,new-york']);
    assert.deepEqual(files['output_東京.csv'], ['5,東京']);
    assert.deepEqual(files['output_大阪.csv'], ['6,大阪']);

    // 10 and 10.0 tie, so with 2-row chunks the merge goes 10, 10.0, 10.0, 10:
    // the second visit to 10 must append, not truncate.
    const t = runIn('id,v\na,10\nb,10.0\nc,10.0\nd,10\n', ['-c', 'v', '--split', '-D', 's'], { SORT_LARGE_CSV_CHUNK_SIZE: '2' });
    assert.equal(t.status, 0, t.stderr);
    const read = (f) => fs.readFileSync(path.join(t.dir, 's', f), 'utf8');
    assert.equal(read('output_10.csv'), 'id,v\na,10\nd,10');
    assert.equal(read('output_10_0.csv'), 'id,v\nb,10.0\nc,10.0');
});

test('exit 2 on duplicate header names, including case variants', () => {
    for (const header of ['Name,Phone,phone,Amt', 'Name,Phone,Phone,Amt']) {
        const r = runIn(`${header}\nb,111,222,2\na,333,444,1\n`, ['-c', 'amt', '-o', 'out.csv']);
        assert.equal(r.status, 2, header);
        assert.match(r.stderr, /^error: duplicate column name \(matched case-insensitively\): "phone"$/m);
        assert.equal(fs.existsSync(path.join(r.dir, 'out.csv')), false);
        assert.deepEqual(r.leftovers, []);
    }
});

test('rows with more fields than the header are warned about and counted, and exit 1', () => {
    const r = runIn('name,amt\nb,2,EXTRA1,EXTRA2\na,1\nc,3,X\n', ['-c', 'amt', '-o', 'out.csv']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(fs.readFileSync(path.join(r.dir, 'out.csv'), 'utf8'), 'name,amt\na,1\nb,2\nc,3');
    assert.match(r.stderr, /^warning: 2 rows had more fields than the header \(first: data row 1\); the extra fields were dropped\.$/m);
});

test('a header-only input writes a header-only output (replacing a stale one); a 0-byte input exits 2', () => {
    const file = path.join(scratch, 'header-only.csv');
    fs.writeFileSync(file, 'Name,Amt\n');
    const dir = path.join(scratch, `run${runCount}`); // the dir run() uses next
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'sorted_output.csv'), 'STALE FROM LAST RUN\n');
    const r = run(CLI, ['-i', file, '-c', 'amt', '--dedupe']);
    assert.equal(r.dir, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0 data rows/);
    assert.equal(fs.readFileSync(path.join(dir, 'sorted_output.csv'), 'utf8'), 'name,amt');
    assert.equal(fs.readFileSync(path.join(dir, 'duplicates_log.csv'), 'utf8'), '');
    assert.deepEqual(r.leftovers, []);

    const empty = runIn('', ['-c', 'amt']);
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /^error: input has no header row/m);
    assert.deepEqual(empty.leftovers, []);
});

test('a mixed column has one order at every chunk size: empty, numbers (ZIP+4 with them), dates, times, then text', () => {
    const values = ['N/A', '10', '9', '', 'abc', '2024-01-01', '5', '10:30', '2024-02-30', '2024-13-45', '10:75', '10001-1234', '08001', '9:99', '2024-01-01T25:00'];
    const input = 'id,v\n' + values.map((v, i) => `r${i},${v}`).join('\n') + '\n';
    for (const cs of ['1', '2', '7', undefined]) {
        const r = runIn(input, ['-c', 'v', '-o', 'out.csv'], cs ? { SORT_LARGE_CSV_CHUNK_SIZE: cs } : {});
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(dataRows(fs.readFileSync(path.join(r.dir, 'out.csv'), 'utf8')).map((l) => l.split(',')[1]),
            ['', '5', '9', '10', '08001', '10001-1234', '2024-01-01', '10:30', '10:75', '2024-01-01T25:00', '2024-02-30', '2024-13-45', '9:99', 'abc', 'N/A'],
            `chunk size ${cs || 'default'}`);
    }
});

test('a ZIP column with ZIP+4 values sorts in ZIP order (an Excel-stripped 9020 with them)', () => {
    const zips = ['30301', '10001-1234', '9020', '08001', '94105', '10001', '20001-0001', '10001-0001'];
    for (const cs of ['1', '3', undefined]) {
        const r = runIn('id,zip\n' + zips.map((z, i) => `r${i},${z}`).join('\n') + '\n', ['-c', 'zip', '-o', 'out.csv'], cs ? { SORT_LARGE_CSV_CHUNK_SIZE: cs } : {});
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(dataRows(fs.readFileSync(path.join(r.dir, 'out.csv'), 'utf8')).map((l) => l.split(',')[1]),
            ['08001', '9020', '10001', '10001-0001', '10001-1234', '20001-0001', '30301', '94105']);
    }
});

test('--dedupe never merges rows that differ only in fields beyond the header; exit 1', () => {
    const r = runIn('name,amt\na,1,KEEP-ME\na,1,OTHER\nb,2\na,1,KEEP-ME\na,1\n', ['-c', 'amt', '-d', '-D', 'o', '-o', 'out.csv']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^warning: 3 rows had more fields than the header/m);
    assert.match(r.stdout, /Removed 1 duplicate\.\n/);
    assert.deepEqual(dataRows(fs.readFileSync(path.join(r.dir, 'o', 'out.csv'), 'utf8')), ['a,1', 'a,1', 'a,1', 'b,2']);
    assert.equal(fs.readFileSync(path.join(r.dir, 'o', 'duplicates_log.csv'), 'utf8'), 'name,amt\na,1');
});

test('empty header cells are named by position (column_3, column_4), not refused', () => {
    const r = runIn('Name,Amt,,\nb,2,x,\na,1,,y\n', ['-c', 'amt', '-o', 'out.csv']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(r.dir, 'out.csv'), 'utf8'), 'name,amt,column_3,column_4\na,1,,y\nb,2,x,');
});

test('--split names an NFD value by its NFC form', () => {
    const r = runIn('id,city\n1,Zu\u0308rich\n', ['-c', 'city', '--split', '-D', 's']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(path.join(r.dir, 's')), ['output_z\u00fcrich.csv']);
});

test('--split: many tie revisits each wait for the earlier writer, so every row lands once and in order', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `r${i},${i % 2 ? '10.0' : '10'}`);
    const r = runIn('id,v\n' + rows.join('\n') + '\n', ['-c', 'v', '--split', '-D', 's'], { SORT_LARGE_CSV_CHUNK_SIZE: '2' });
    assert.equal(r.status, 0, r.stderr);
    const read = (f) => fs.readFileSync(path.join(r.dir, 's', f), 'utf8');
    assert.equal(read('output_10.csv'), 'id,v\n' + rows.filter((_, i) => i % 2 === 0).join('\n'));
    assert.equal(read('output_10_0.csv'), 'id,v\n' + rows.filter((_, i) => i % 2).join('\n'));
});

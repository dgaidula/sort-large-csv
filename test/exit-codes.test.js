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
        assert.equal(b.stdout, a.stdout);
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

// There is no exit 1 test: the tool has no per-item failure condition (a
// duplicate row is a normal outcome, and nothing is reported as skipped), so
// it never exits 1.

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

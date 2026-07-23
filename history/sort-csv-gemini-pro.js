#!/usr/bin/env node

// Gemini PRO 3 version
// 2025-12-18 version 1
// worked first try, unlike Gemini Fast 3

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const fastCsv = require('fast-csv');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('input', { alias: 'i', type: 'string', description: 'Path to input CSV file', demandOption: true })
  .option('column', { alias: 'c', type: 'string', description: 'Column name to sort by', demandOption: true })
  .option('split', { alias: 's', type: 'boolean', description: 'Split into multiple files based on column value', default: false })
  .option('output', { alias: 'o', type: 'string', description: 'Output filename (only used if not splitting)', default: 'sorted_output.csv' })
  .argv;

const run = async () => {
  const results = [];
  const sortCol = argv.column;

  console.log(`Reading file: ${argv.input}...`);

  // 1. Read the CSV file
  fs.createReadStream(argv.input)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', () => {
      if (results.length === 0) {
        console.error("Error: CSV file is empty or could not be parsed.");
        return;
      }

      // Check if column exists
      if (!Object.keys(results[0]).includes(sortCol)) {
        console.error(`Error: Column "${sortCol}" not found in CSV. Available columns: ${Object.keys(results[0]).join(', ')}`);
        return;
      }

      console.log(`Sorting ${results.length} rows by column "${sortCol}"...`);

      // 2. Sort the data in memory
      results.sort((a, b) => {
        const valA = a[sortCol];
        const valB = b[sortCol];

        // Try numeric sort first, fallback to string sort
        const numA = parseFloat(valA);
        const numB = parseFloat(valB);

        if (!isNaN(numA) && !isNaN(numB)) {
          return numA - numB;
        }
        return String(valA).localeCompare(String(valB));
      });

      // 3. Write Output
      if (argv.split) {
        writeSplitFiles(results, sortCol);
      } else {
        writeSingleFile(results, argv.output);
      }
    });
};

// Helper: Write a single sorted file
const writeSingleFile = (data, filename) => {
  const ws = fs.createWriteStream(filename);
  fastCsv
    .write(data, { headers: true })
    .pipe(ws)
    .on('finish', () => console.log(`Successfully wrote sorted data to ${filename}`));
};

// Helper: Split files based on value changes
const writeSplitFiles = (data, sortCol) => {
  // Group data by the sort column
  const groups = {};

  data.forEach(row => {
    const key = row[sortCol] || 'empty_value';
    // Sanitize key for filename (remove illegal chars)
    const safeKey = key.replace(/[^a-z0-9]/gi, '_').toLowerCase();

    if (!groups[safeKey]) {
      groups[safeKey] = [];
    }
    groups[safeKey].push(row);
  });

  console.log(`Splitting into ${Object.keys(groups).length} separate files...`);

  // Write each group
  Object.keys(groups).forEach(key => {
    const filename = `output_${key}.csv`;
    const ws = fs.createWriteStream(filename);
    fastCsv
      .write(groups[key], { headers: true })
      .pipe(ws)
      .on('finish', () => console.log(`Created: ${filename}`));
  });
};

run();
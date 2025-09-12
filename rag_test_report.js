#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fg from 'fast-glob';
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { stringify } from 'csv-stringify/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readJson(filePath) {
	const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
	if (!fs.existsSync(abs)) {
		throw new Error(`File not found: ${abs}`);
	}
	const raw = fs.readFileSync(abs, 'utf8');
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new Error(`Invalid JSON in ${abs}: ${err.message}`);
	}
}

function normalizeQueryItem(item) {
	if (typeof item === 'string') return item;
	if (item && typeof item === 'object') {
		const candidateKeys = ['query', 'text', 'question', 'prompt'];
		for (const key of candidateKeys) {
			if (typeof item[key] === 'string') return item[key];
		}
	}
	return String(item ?? '');
}

function normalizeFieldsArray(item) {
	if (Array.isArray(item)) return item;
	if (item && typeof item === 'object') {
		if (Array.isArray(item.fields)) return item.fields;
		if (Array.isArray(item.ground_truth)) return item.ground_truth;
		if (Array.isArray(item.expected)) return item.expected;
	}
	return [];
}

function toSetCaseInsensitive(arr) {
	const set = new Map();
	for (const v of arr || []) {
		if (typeof v !== 'string') continue;
		const norm = v.trim();
		if (!norm) continue;
		set.set(norm.toLowerCase(), norm);
	}
	return set;
}

function computeMetrics(retrieved, groundTruth) {
	const rSet = toSetCaseInsensitive(retrieved);
	const gSet = toSetCaseInsensitive(groundTruth);
	let relevant = 0;
	for (const key of rSet.keys()) {
		if (gSet.has(key)) relevant += 1;
	}
	const precision = rSet.size === 0 ? 0 : relevant / rSet.size;
	const recall = gSet.size === 0 ? 0 : relevant / gSet.size;
	const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
	return { precision, recall, f1 };
}

function formatNumber(x) {
	return Number.isFinite(x) ? Number(x.toFixed(4)) : 0;
}

function discoverResultFiles(inputDirs, systemsFilter) {
	const patterns = inputDirs.map((dir) => path.join(dir, 'results_*.json'));
	const files = fg.sync(patterns, { onlyFiles: true, absolute: true });
	const results = [];
	for (const file of files) {
		const base = path.basename(file);
		const m = base.match(/^results_(.+)\.json$/i);
		if (!m) continue;
		const systemName = m[1];
		if (systemsFilter && systemsFilter.length > 0 && !systemsFilter.includes(systemName)) continue;
		results.push({ systemName, file });
	}
	return results.sort((a, b) => a.systemName.localeCompare(b.systemName));
}

function coerceRetrievedList(item) {
	if (Array.isArray(item)) return item;
	if (item && typeof item === 'object') {
		if (Array.isArray(item.retrieved)) return item.retrieved;
		if (Array.isArray(item.top)) return item.top;
		if (Array.isArray(item.fields)) return item.fields;
	}
	return [];
}

async function main() {
	const argv = yargs(hideBin(process.argv))
		.usage('node rag_test_report.js [options]')
		.option('queries', {
			alias: 'q',
			demandOption: true,
			description: 'Path to queries.json',
			type: 'string'
		})
		.option('ground', {
			alias: 'g',
			demandOption: true,
			description: 'Path to ground_truth.json',
			type: 'string'
		})
		.option('inputs', {
			alias: 'i',
			description: 'Comma-separated directories to search for results_*.json',
			type: 'string',
			default: '.'
		})
		.option('systems', {
			alias: 's',
			description: 'Comma-separated system names to include (e.g., Control,HyDE)',
			type: 'string'
		})
		.option('out', {
			alias: 'o',
			description: 'Output CSV file path',
			type: 'string',
			default: 'results_report.csv'
		})
		.option('strictLength', {
			description: 'If set, enforces equal number of queries across inputs',
			boolean: true,
			default: false
		})
		.help()
		.parseSync();

	const inputDirs = argv.inputs.split(',').map((d) => path.isAbsolute(d) ? d : path.join(process.cwd(), d));
	const systemsFilter = argv.systems ? argv.systems.split(',').map((s) => s.trim()).filter(Boolean) : null;

	const queriesRaw = readJson(argv.queries);
	const groundRaw = readJson(argv.ground);

	const queries = Array.isArray(queriesRaw) ? queriesRaw.map(normalizeQueryItem) : [];
	const groundTruth = Array.isArray(groundRaw) ? groundRaw.map(normalizeFieldsArray) : [];

	if (queries.length === 0) throw new Error('queries.json contains no items.');
	if (groundTruth.length === 0) throw new Error('ground_truth.json contains no items.');

	if (argv.strictLength && queries.length !== groundTruth.length) {
		throw new Error(`Length mismatch: queries (${queries.length}) vs ground_truth (${groundTruth.length}).`);
	}

	const discovered = discoverResultFiles(inputDirs, systemsFilter);
	if (discovered.length === 0) {
		console.log(chalk.yellow('No results_*.json found in provided inputs. Nothing to evaluate.'));
		process.exit(1);
	}

	const resultsRows = [];
	const perSystemMetrics = new Map();

	for (const { systemName, file } of discovered) {
		let sysData = readJson(file);
		if (!Array.isArray(sysData)) {
			throw new Error(`Results file for ${systemName} is not an array: ${file}`);
		}

		if (argv.strictLength && sysData.length !== queries.length) {
			throw new Error(`Length mismatch for ${systemName}: queries (${queries.length}) vs results (${sysData.length}).`);
		}

		const count = Math.min(queries.length, groundTruth.length, sysData.length);
		let sumP = 0, sumR = 0, sumF1 = 0;

		for (let idx = 0; idx < count; idx++) {
			const queryText = queries[idx] ?? '';
			const gtFields = normalizeFieldsArray(groundTruth[idx]);
			const retrieved = coerceRetrievedList(sysData[idx]);

			const { precision, recall, f1 } = computeMetrics(retrieved, gtFields);
			sumP += precision; sumR += recall; sumF1 += f1;

			resultsRows.push({
				query_id: idx + 1,
				query: queryText,
				system_name: systemName,
				retrieved_fields: JSON.stringify(retrieved),
				ground_truth: JSON.stringify(gtFields),
				precision: formatNumber(precision),
				recall: formatNumber(recall),
				f1_score: formatNumber(f1)
			});
		}

		const avg = {
			precision: sumP / count,
			recall: sumR / count,
			f1: sumF1 / count
		};
		perSystemMetrics.set(systemName, avg);
	}

	for (const [systemName, avg] of perSystemMetrics.entries()) {
		resultsRows.push({
			query_id: '',
			query: 'AVERAGE',
			system_name: systemName,
			retrieved_fields: '',
			ground_truth: '',
			precision: formatNumber(avg.precision),
			recall: formatNumber(avg.recall),
			f1_score: formatNumber(avg.f1)
		});
	}

	const columns = [
		'query_id',
		'query',
		'system_name',
		'retrieved_fields',
		'ground_truth',
		'precision',
		'recall',
		'f1_score'
	];
	const csv = stringify(resultsRows, { header: true, columns });
	const outPath = path.isAbsolute(argv.out) ? argv.out : path.join(process.cwd(), argv.out);
	fs.writeFileSync(outPath, csv, 'utf8');
	console.log(chalk.green(`Saved report to ${outPath}`));
}

main().catch((err) => {
	console.error(chalk.red(err.message));
	process.exit(1);
});

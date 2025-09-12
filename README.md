## RAG_TESTING

## RAG Testing Tool (Node.js)

Automate evaluation of multiple MongoDB schema field retrieval systems (RAG variants). Given test queries, ground truth field names, and each system's top-10 retrieved fields, this tool computes precision, recall, and F1 per query and averages per system, exporting a standardized CSV.

### Features
- Read queries and ground truth from JSON
- Discover `results_*.json` files per system
- Compute precision, recall, F1 for each query and system
- Append per-system averages
- Output: `results_report.csv`

### Install
Ensure Node.js >= 18.

```bash
npm install
```

If dependencies are missing, install:

```bash
npm install csv-stringify fast-glob chalk yargs
```

### Input formats
- `queries.json`: array of 30 items. Each item may be a string or an object like `{ "query": "..." }`.
- `ground_truth.json`: array aligned with queries. Each item may be an array of field names, or an object like `{ "fields": ["name","email"] }`.
- For each RAG system: file named `results_SYSTEM.json`, each entry is either an array of field names or an object with `retrieved`/`fields`/`top` array.

Example:
```json
// queries.json
[
  "Get customer contact fields",
  { "query": "List order amount fields" }
]
```
```json
// ground_truth.json
[
  ["email","phone"],
  { "fields": ["total","currency"] }
]
```
```json
// results_Control.json
[
  ["email","address","phone"],
  { "retrieved": ["total","amount","currency"] }
]
```

### Usage
From the project directory:

```bash
node rag_test_report.js \
  --queries ./queries.json \
  --ground ./ground_truth.json \
  --inputs . \
  --out results_report.csv
```

Optional flags:
- `--systems Control,HyDE,RAGFusion` limit to specific systems
- `--strictLength` require equal lengths between inputs

### CSV schema
Columns: `query_id, query, system_name, retrieved_fields, ground_truth, precision, recall, f1_score`.
Rows for each query+system, followed by average rows with `query` = `AVERAGE`.

### Notes
- Matching is case-insensitive; duplicates are deduped per list.
- Metrics use top-10 as provided by each system file.

### Samples
See `samples/` for miniature examples.

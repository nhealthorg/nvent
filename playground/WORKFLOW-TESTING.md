# Testing Workflows via iii Console

## Start the development server

```bash
cd playground
pnpm dev
```

This will:
1. Start the Nuxt dev server
2. Start the iii engine
3. Start the workflow-worker (Rust)
4. Register all functions and workflows

## Test Workflows via iii Console

Open http://localhost:3113 (or the configured console port)

### 1. Simple Text Workflow

**Function ID:** `simple-text`

**Payload:**
```json
{
  "text": "Hello World from nvent workflows"
}
```

**Expected Result:**
```json
{
  "original": "Hello World from nvent workflows",
  "uppercase": "HELLO WORLD FROM NVENT WORKFLOWS",
  "lowercase": "hello world from nvent workflows",
  "length": 33,
  "wordCount": 5
}
```

### 2. Multi-Step Workflow

**Function ID:** `multi-step`

**Payload:**
```json
{
  "text": "The quick brown fox jumps over the lazy dog"
}
```

**Expected Result:**
```json
{
  "wordCount": 9,
  "charCount": 43,
  "uniqueWords": 9,
  "avgWordLength": 3.89,
  "longestWord": "quick",
  "sampleWords": ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog"]
}
```

### 3. Pipeline DAG Workflow (Python)

**Function ID:** `pipeline::dag`

**Payload:**
```json
{
  "text": "The quick brown fox jumps over the lazy dog"
}
```

**Expected Result:**
```json
{
  "wordCount": 9,
  "charCount": 43,
  "uniqueWords": 9,
  "avgWordLength": 3.89,
  "longestWord": "quick",
  "uniqueWordsList": ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog"]
}
```

**Note:** This workflow calls the Python function `pipeline::analyze` which is located at `server/functions/pipeline/analyze.py`.

## Direct Function Testing

You can also test the individual functions directly:

### process-text
```json
{
  "text": "Hello World"
}
```

### analyze-text
```json
{
  "text": "The quick brown fox"
}
```

## Troubleshooting

### Workflow not found
- Check that the workflow file is in `server/workflows/*.ts`
- Restart the dev server to pick up new workflows
- Check the console logs for registration messages

### Function not found
- Check that the function exists in `server/functions/`
- Verify the function ID matches the file path
- Example: `server/functions/process-text.ts` → ID: `process-text`
- Example: `server/functions/pipeline/analyze.py` → ID: `pipeline::analyze`

### Serialization errors
- Ensure input matches the expected format
- Check that `input` uses `'run_input'`, `'node:X'`, or array format
- Don't pass custom objects directly as `input` field

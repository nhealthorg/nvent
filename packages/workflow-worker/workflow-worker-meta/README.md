# @nvent-addon/workflow-worker

Platform-aware resolver for the nvent workflow worker binary.

## Usage

```js
import { getBinaryPath } from '@nvent-addon/workflow-worker'

const binaryPath = getBinaryPath()
```

## Override

Set `NVENT_WORKFLOW_WORKER_BIN` to force a custom binary path.

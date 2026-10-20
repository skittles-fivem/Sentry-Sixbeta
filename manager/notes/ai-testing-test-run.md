# ai-testing test run on Linux (partial, agent was cut off)

Machine: Linux, Node 22, /usr/bin/ffmpeg 6.1 (Ubuntu), no GPU. Repo copy at ai-testing @ 0b53daa, `npm ci` then jest.

## jest-integ-macho.json: 6 passed / 0 failed / 21 skipped, suites 2 ok / 0 failed
- `tests/main/converter/integration.test.js`: focused (5 passed, 0 failed)
- `tests/main/converter/integrationE2E.test.js`: focused (1 passed, 0 failed)

## jest-studio.json: 60 passed / 0 failed / 0 skipped, suites 1 ok / 0 failed
- `tests/main/converter/studioTelemetry.test.js`: passed (60 passed, 0 failed)

## jest-unit-converter.json: 869 passed / 0 failed / 20 skipped, suites 21 ok / 0 failed
- `tests/main/converter/jobService.test.js`: passed (129 passed, 0 failed)
- `tests/main/converter/staging.test.js`: passed (116 passed, 0 failed)
- `tests/main/converter/jobStore.test.js`: passed (193 passed, 0 failed)
- `tests/main/converter/verifier.test.js`: passed (77 passed, 0 failed)
- `tests/main/converter/ipc.test.js`: passed (93 passed, 0 failed)
- `tests/main/converter/runtime.test.js`: passed (30 passed, 0 failed)
- `tests/main/converter/scanner.test.js`: passed (27 passed, 0 failed)
- `tests/main/converter/h265Telemetry.test.js`: passed (29 passed, 0 failed)
- `tests/main/converter/av1Telemetry.test.js`: passed (13 passed, 0 failed)
- `tests/main/converter/safetyRegression.test.js`: focused (14 passed, 0 failed)
- `tests/main/converter/encoderPlanner.test.js`: passed (62 passed, 0 failed)
- `tests/main/converter/mp4.test.js`: passed (12 passed, 0 failed)
- `tests/main/converter/filesystemTransactions.test.js`: focused (5 passed, 0 failed)
- `tests/main/converter/lifecycleIntegration.test.js`: passed (6 passed, 0 failed)
- `tests/main/converter/autoConvert.test.js`: passed (13 passed, 0 failed)
- `tests/main/converter/telemetryTimeline.test.js`: passed (24 passed, 0 failed)
- `tests/main/converter/benchmark.test.js`: passed (4 passed, 0 failed)
- `tests/main/converter/converterAdapters.test.js`: passed (4 passed, 0 failed)
- `tests/main/converter/contracts.test.js`: passed (10 passed, 0 failed)
- `tests/main/converter/leftoverSweep.test.js`: passed (3 passed, 0 failed)
- `tests/main/converter/verificationSnapshot.test.js`: passed (5 passed, 0 failed)

'use strict';
// TEMPORARY CI diagnostics.
jest.setTimeout(300_000);
test('debug real runtime under jest', async () => { await require('../../ci/debugRealRuntime').run('jest'); });

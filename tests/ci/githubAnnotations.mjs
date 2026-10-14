// node --test reporter that turns each failing test into a GitHub annotation,
// so failures show on the workflow run page without opening the log.
// Use next to a normal reporter:
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./tests/ci/githubAnnotations.mjs --test-reporter-destination=stdout ...

import path from 'node:path';

const escapeData = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { name, file, line, details } = event.data;
    // A suite fails when one of its tests does; the test itself is reported.
    if (details?.type === 'suite') continue;
    const error = details?.error;
    const cause = error?.cause ?? error;
    const message = String(cause?.message ?? cause ?? 'failed').split('\n').slice(0, 12).join('\n');
    const location = file ? `file=${escapeProperty(path.relative(process.cwd(), file.replace(/^file:\/\//, '')))},line=${line || 1},` : '';
    yield `::error ${location}title=${escapeProperty(name)}::${escapeData(message)}\n`;
  }
}

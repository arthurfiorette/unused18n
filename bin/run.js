#!/usr/bin/env node

import { execute } from '@oclif/core';

const argv = process.argv.slice(2);
const args = argv[0] && !argv[0].startsWith('-') ? argv : ['lint', ...argv];

await execute({ args, dir: import.meta.url });

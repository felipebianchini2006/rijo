#!/usr/bin/env node
import { runCliEntrypoint } from './bootstrap.js';

runCliEntrypoint(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`rijo: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);

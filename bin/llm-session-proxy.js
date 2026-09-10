#!/usr/bin/env node
import { runCli } from '../src/cli.js';

runCli().catch((error) => {
  process.stderr.write(`未捕获异常: ${error?.stack || error}\n`);
  process.exit(1);
});

import * as core from '@actions/core';
import { parseInputs } from './config.js';
import { runMode } from './modes/index.js';

async function main(): Promise<void> {
  const inputs = parseInputs({
    mode: core.getInput('mode', { required: true }),
    token: core.getInput('token'),
    statusJson: core.getInput('status-json'),
    configPath: core.getInput('config-path'),
    dryRun: core.getBooleanInput('dry-run') ? 'true' : 'false',
  });
  await runMode(inputs);
}

main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

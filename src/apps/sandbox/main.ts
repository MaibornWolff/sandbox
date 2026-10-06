#!/usr/bin/env node

import "core-js/stable/disposable-stack/index.js";
import "core-js/stable/async-disposable-stack/index.js";
import {
  getProcessArguments,
  setExitCode,
} from "#platform/environment/index.js";
import { readProcessTerminalStreams } from "#platform/terminal/index.js";
import { runProductionSandboxApplication } from "./production-application.js";

setExitCode(
  await runProductionSandboxApplication(
    getProcessArguments().slice(2),
    readProcessTerminalStreams(),
  ),
);

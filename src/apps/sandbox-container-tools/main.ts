#!/usr/bin/env node

import {
  exitProcess,
  getProcessArguments,
} from "#platform/environment/index.js";
import { readProcessTerminalStreams } from "#platform/terminal/index.js";
import { runProductionContainerToolsApplication } from "./production-application.js";

declare const SANDBOX_CONTAINER_TOOLS_VERSION: string;

const exitCode = await runProductionContainerToolsApplication(
  getProcessArguments().slice(2),
  SANDBOX_CONTAINER_TOOLS_VERSION,
  readProcessTerminalStreams(),
);

if (exitCode !== 0) exitProcess(exitCode);

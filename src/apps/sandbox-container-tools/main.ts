#!/usr/bin/env node

import "core-js/stable/disposable-stack/index.js";
import "core-js/stable/async-disposable-stack/index.js";
import {
  exitProcess,
  getProcessArguments,
} from "#platform/environment/index.js";
import { readProcessTerminalStreams } from "#platform/terminal/index.js";
import { runPrivateHookCommand } from "./private-hook-command.js";
import { runProductionContainerToolsApplication } from "./production-application.js";

declare const SANDBOX_CONTAINER_TOOLS_VERSION: string;

const args = getProcessArguments().slice(2);
const streams = readProcessTerminalStreams();
const exitCode =
  (await runPrivateHookCommand(args, streams.stdout)) ??
  (await runProductionContainerToolsApplication(
    args,
    SANDBOX_CONTAINER_TOOLS_VERSION,
    streams,
  ));

if (exitCode !== 0) exitProcess(exitCode);

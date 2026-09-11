#!/usr/bin/env bun
import { executeCli } from "./cli/app.ts";
import { restoreCallerEnvironment } from "./cli/bootstrap.ts";

restoreCallerEnvironment();
void executeCli(process.argv.slice(2));

#!/usr/bin/env bun
import { executeCli } from "./app.ts";
import { configureCompiledEnvironment } from "./bootstrap.ts";

// A compiled executable starts in the caller's context already. Unlike the
// source launcher, it must not restore launcher handoff variables or HOME.
configureCompiledEnvironment();
void executeCli(process.argv.slice(2));

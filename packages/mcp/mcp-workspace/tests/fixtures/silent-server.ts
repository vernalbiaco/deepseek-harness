/**
 * Stdio process for admission timeout tests: it never answers MCP
 * `initialize`. When `MCP_FIXTURE_PID_DIR` is set, startup writes an empty
 * file named after `process.pid` into that directory.
 *
 * Run: node silent-server.ts
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pidDir = process.env.MCP_FIXTURE_PID_DIR
if (pidDir !== undefined) writeFileSync(join(pidDir, String(process.pid)), '')

process.stdin.resume()

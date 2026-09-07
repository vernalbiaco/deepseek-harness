/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--configuration-authority`,
 * `--no-open`) and its `--help`
 * text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
 * Ordinary rows inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** Whether this invocation opens the default browser after startup. */
  openBrowser: boolean
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /**
   * `--configuration-authority`: which browser authorities reach the
   * configuration plane (settings, credentials, agent-preset management).
   * `loopback` unless the invocation widened it to the `--trusted-host` names.
   */
  configurationAuthority: 'loopback' | 'trusted-host'
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
  configurationAuthority?: string
}

/** The two configuration-plane fences the Connection plugin implements. */
const CONFIGURATION_AUTHORITIES = ['loopback', 'trusted-host'] as const

function isConfigurationAuthority(value: string): value is WebStartupValues['configurationAuthority'] {
  return (CONFIGURATION_AUTHORITIES as readonly string[]).includes(value)
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--configuration-authority <fence>', 'who reaches Settings, credentials, and preset management: loopback (default) or trusted-host, which admits every --trusted-host name and needs a login in front of them')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --port 8080              serve on another port
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; `--host 0.0.0.0`,
 * a non-numeric `--port`, an unknown `--configuration-authority`, or
 * `--configuration-authority trusted-host` with no `--trusted-host` to admit is
 * a usage error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.host === '0.0.0.0') {
      program.error('error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead')
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    const fence = options.configurationAuthority ?? 'loopback'
    const configurationAuthority: WebStartupValues['configurationAuthority'] = isConfigurationAuthority(fence)
      ? fence
      : program.error(`error: --configuration-authority must be one of ${CONFIGURATION_AUTHORITIES.join(', ')}, got ${JSON.stringify(fence)}`)
    const trustedHosts = options.trustedHost ?? []
    if (configurationAuthority === 'trusted-host' && trustedHosts.length === 0) {
      // The same rule the Connection plugin enforces at load, caught here where
      // the message can name the flag that fixes it.
      program.error('error: --configuration-authority trusted-host admits the --trusted-host names, so at least one --trusted-host is required')
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      openBrowser: options.open,
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts,
      configurationAuthority,
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { lazyCmd } from "./cli/cmd/cmd"

const args = hideBin(process.argv)

if (args.length === 1 && (args[0] === "-v" || args[0] === "--version")) {
  process.stdout.write(InstallationVersion + EOL)
  process.exit(0)
}

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(lazyCmd("acp", "start agent control protocol server", () => import("./cli/cmd/acp").then((m) => m.AcpCommand)))
  .command(
    lazyCmd("mcp", "manage MCP (Model Context Protocol) servers", () => import("./cli/cmd/mcp").then((m) => m.McpCommand)),
  )
  .command(lazyCmd("$0 [project]", "start opencode tui", () => import("./cli/cmd/tui").then((m) => m.TuiThreadCommand)))
  .command(
    lazyCmd("attach <url>", "attach to running opencode server", () =>
      import("./cli/cmd/attach").then((m) => m.AttachCommand),
    ),
  )
  .command(lazyCmd("run [message..]", "run opencode with a prompt", () => import("./cli/cmd/run").then((m) => m.RunCommand)))
  .command(lazyCmd("generate", "generate code or artifacts", () => import("./cli/cmd/generate").then((m) => m.GenerateCommand)))
  .command(lazyCmd("debug", "debug opencode", () => import("./cli/cmd/debug").then((m) => m.DebugCommand)))
  .command(
    lazyCmd(
      "account",
      "manage account & auth",
      () => import("./cli/cmd/account").then((m) => m.ConsoleCommand),
      ["console"],
    ),
  )
  .command(
    lazyCmd(
      "providers",
      "manage AI providers and credentials",
      () => import("./cli/cmd/providers").then((m) => m.ProvidersCommand),
      ["auth"],
    ),
  )
  .command(lazyCmd("agent", "manage subagents", () => import("./cli/cmd/agent").then((m) => m.AgentCommand)))
  .command(lazyCmd("upgrade [target]", "upgrade opencode", () => import("./cli/cmd/upgrade").then((m) => m.UpgradeCommand)))
  .command(lazyCmd("uninstall", "uninstall opencode", () => import("./cli/cmd/uninstall").then((m) => m.UninstallCommand)))
  .command(lazyCmd("serve", "start opencode server", () => import("./cli/cmd/serve").then((m) => m.ServeCommand)))
  .command(lazyCmd("web", "open web UI", () => import("./cli/cmd/web").then((m) => m.WebCommand)))
  .command(
    lazyCmd("models [provider]", "list available models", () => import("./cli/cmd/models").then((m) => m.ModelsCommand)),
  )
  .command(lazyCmd("stats", "show token usage and cost stats", () => import("./cli/cmd/stats").then((m) => m.StatsCommand)))
  .command(
    lazyCmd("export [sessionID]", "export session data", () => import("./cli/cmd/export").then((m) => m.ExportCommand)),
  )
  .command(lazyCmd("import <file>", "import session data", () => import("./cli/cmd/import").then((m) => m.ImportCommand)))
  .command(
    lazyCmd("github", "GitHub actions and workflow integration", () =>
      import("./cli/cmd/github").then((m) => m.GithubCommand),
    ),
  )
  .command(lazyCmd("pr <number>", "inspect or checkout pull request", () => import("./cli/cmd/pr").then((m) => m.PrCommand)))
  .command(lazyCmd("session", "manage sessions", () => import("./cli/cmd/session").then((m) => m.SessionCommand)))
  .command(
    lazyCmd("plugin <module>", "manage plugins", () => import("./cli/cmd/plug").then((m) => m.PluginCommand), ["plug"]),
  )
  .command(lazyCmd("db", "interact with opencode database", () => import("./cli/cmd/db").then((m) => m.DbCommand)))
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}

import type { Argv, CommandModule } from "yargs"

export type WithDoubleDash<T> = T & { "--"?: string[]; _?: Array<string | number> }

export function cmd<T, U>(input: CommandModule<T, WithDoubleDash<U>>) {
  return input
}

export function lazyCmd<T = {}, U = {}>(
  command: string | readonly string[],
  describe: string | false,
  load: () => Promise<CommandModule<T, WithDoubleDash<U>>>,
  aliases?: string | readonly string[],
): CommandModule<T, WithDoubleDash<U>> {
  return {
    command,
    aliases,
    describe,
    builder: (yargs: Argv<T>) => {
      return load().then((target) => {
        if (typeof target.builder === "function") {
          return target.builder(yargs)
        }
        if (typeof target.builder === "object" && target.builder !== null) {
          return yargs.options(target.builder)
        }
        return yargs
      }) as never
    },
    handler: async (argv) => {
      const target = await load()
      return target.handler(argv)
    },
  }
}

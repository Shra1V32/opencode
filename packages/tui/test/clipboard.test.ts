import { expect, test } from "bun:test"
import { copyCommand } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("prefers tmux clipboard when inside tmux session", () => {
  expect(copyCommand("linux", false, (name) => name === "tmux", true)).toEqual(["tmux", "load-buffer", "-w", "-"])
  expect(copyCommand("darwin", false, (name) => name === "tmux" || name === "osascript", true)).toEqual([
    "tmux",
    "load-buffer",
    "-w",
    "-",
  ])
})

test("falls back to native commands if tmux command is unavailable even inside tmux", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript", true)).toEqual(["osascript"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

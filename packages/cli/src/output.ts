import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import { Box, Text } from 'ink'
import { createElement } from 'react'

import { renderStatic } from './ink.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Add `--json` for machine-readable output. */
export function addJSONOption(cmd: Command): Command {
  return cmd.option('--json', 'print the result as JSON')
}

/** Print `value` as indented JSON. */
export function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Print `value` as one JSON line, for streaming output. */
export function printNDJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/**
 * Parse a JSON flag value. A value starting with `@` is a path whose content is parsed.
 * Every error names the flag.
 */
export async function parseJSONArg(flag: string, value: string): Promise<unknown> {
  let text = value
  let source = 'value'
  if (value.startsWith('@')) {
    const path = value.slice(1)
    source = `file ${path}`
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`Cannot read ${flag} file ${path}: ${errorMessage(error)}`, {
        cause: error,
      })
    }
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid JSON in ${flag} ${source}: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

/** Write `✘ <message>` to stderr and set exit code 1. */
export function fail(error: unknown): void {
  process.stderr.write(`✘ ${errorMessage(error)}\n`)
  process.exitCode = 1
}

export type TableColumn = { key: string; label: string }

/** Render a static table with a bold header through Ink's `renderStatic`. */
export function renderTable(
  columns: Array<TableColumn>,
  rows: Array<Record<string, string>>,
): void {
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => (row[column.key] ?? '').length)),
  )
  const line = (cell: (column: TableColumn) => string, bold = false) =>
    createElement(
      Text,
      { bold },
      columns.map((column, i) => cell(column).padEnd(widths[i] ?? 0)).join('  '),
    )
  renderStatic(
    createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      line((column) => column.label, true),
      ...rows.map((row, i) =>
        createElement(
          Box,
          { key: i },
          line((column) => row[column.key] ?? ''),
        ),
      ),
    ),
  )
}

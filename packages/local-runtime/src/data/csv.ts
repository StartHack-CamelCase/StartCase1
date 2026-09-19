import { parse } from "csv-parse/sync";

import { DataValidationError } from "../../../contracts/src/errors.js";

export type CsvRow = Record<string, string>;

export type ParsedCsv = {
  header: string[];
  rows: CsvRow[];
};

function fail(file: string, message: string, details: Record<string, unknown> = {}): never {
  throw new DataValidationError(`${file}: ${message}`, { file, ...details });
}

export function parseCsv(file: string, contents: string): ParsedCsv {
  let records: string[][];
  try {
    records = parse(contents, {
      bom: true,
      columns: false,
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: true,
      trim: false,
    }) as string[][];
  } catch (error) {
    fail(file, "CSV parsing failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const header = records[0];
  if (header === undefined || header.length === 0) {
    fail(file, "missing CSV header");
  }

  if (new Set(header).size !== header.length) {
    fail(file, "duplicate CSV header", { header });
  }

  const rows = records.slice(1).map((values, index) => {
    if (values.length !== header.length) {
      fail(file, "wrong CSV column count", {
        row: index + 2,
        expected: header.length,
        actual: values.length,
      });
    }

    return Object.fromEntries(header.map((column, columnIndex) => [column, values[columnIndex] ?? ""]));
  });

  return { header, rows };
}

export function assertHeader(file: string, actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
    fail(file, "CSV header does not match the source contract", {
      expected: [...expected],
      actual: [...actual],
    });
  }
}

export function required(row: CsvRow, field: string, file: string, rowNumber: number): string {
  const value = row[field];
  if (value === undefined || value === "") {
    fail(file, `required field ${field} is empty`, { row: rowNumber, field });
  }
  return value;
}

export function nullable(row: CsvRow, field: string, file: string, rowNumber: number): string | null {
  const value = row[field];
  if (value === undefined) {
    fail(file, `missing field ${field}`, { row: rowNumber, field });
  }
  return value === "" ? null : value;
}

export function oneOf<const T extends readonly string[]>(
  value: string,
  allowed: T,
  file: string,
  row: number,
  field: string,
): T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    fail(file, `invalid value for ${field}`, { row, field, value, allowed });
  }
  return value as T[number];
}

export function integer(
  value: string,
  file: string,
  row: number,
  field: string,
  minimum?: number,
): number {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) {
    fail(file, `invalid integer in ${field}`, { row, field, value });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (minimum !== undefined && parsed < minimum)) {
    fail(file, `integer out of range in ${field}`, { row, field, value, minimum });
  }
  return parsed;
}

export function boolean(value: string, file: string, row: number, field: string): boolean {
  if (value !== "true" && value !== "false") {
    fail(file, `invalid boolean in ${field}`, { row, field, value });
  }
  return value === "true";
}

export function decimalString(
  value: string,
  file: string,
  row: number,
  field: string,
  options: { scale?: number; nonNegative?: boolean; positive?: boolean } = {},
): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    fail(file, `invalid decimal in ${field}`, { row, field, value });
  }

  const [whole = "", fraction] = value.replace(/^-/, "").split(".");
  if (whole.length > 1 && whole.startsWith("0")) {
    fail(file, `non-canonical decimal in ${field}`, { row, field, value });
  }
  if (options.scale !== undefined && fraction?.length !== options.scale) {
    fail(file, `wrong decimal scale in ${field}`, {
      row,
      field,
      value,
      expectedScale: options.scale,
    });
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    fail(file, `non-finite decimal in ${field}`, { row, field, value });
  }
  if (options.nonNegative === true && numeric < 0) {
    fail(file, `negative decimal in ${field}`, { row, field, value });
  }
  if (options.positive === true && numeric <= 0) {
    fail(file, `non-positive decimal in ${field}`, { row, field, value });
  }
  return value;
}

export function isoDate(value: string, file: string, row: number, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    fail(file, `invalid date in ${field}`, { row, field, value });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    fail(file, `invalid calendar date in ${field}`, { row, field, value });
  }
  return value;
}

export function isoDateTime(value: string, file: string, row: number, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    fail(file, `invalid UTC date-time in ${field}`, { row, field, value });
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().replace(".000Z", "Z") !== value) {
    fail(file, `invalid UTC date-time in ${field}`, { row, field, value });
  }
  return value;
}

export function identifier(
  value: string,
  pattern: RegExp,
  file: string,
  row: number,
  field: string,
): string {
  if (!pattern.test(value)) {
    fail(file, `invalid identifier in ${field}`, { row, field, value, pattern: pattern.source });
  }
  return value;
}

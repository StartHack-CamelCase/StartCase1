export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class DataValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(503, "data_pack_invalid", message, details);
    this.name = "DataValidationError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

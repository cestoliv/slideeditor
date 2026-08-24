/**
 * The status a failed service call answers with. Ported from
 * server/library.mjs:26-32, where it lived because the library was the first
 * thing to need it. Every service throws it, so it sits on its own here.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown> | null;

  constructor(
    status: number,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

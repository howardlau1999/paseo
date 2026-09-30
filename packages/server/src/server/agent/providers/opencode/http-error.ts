export class OpenCodeHttpError extends Error {
  readonly name = "OpenCodeHttpError";

  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    readonly html: boolean,
  ) {
    const statusLabel = status === undefined ? "" : ` (HTTP ${status})`;
    let message = `OpenCode ${operation} failed${statusLabel}`;
    if (html) {
      message = `OpenCode ${operation} returned HTML instead of JSON; incompatible OpenCode API${statusLabel}. Update OpenCode and Paseo, then refresh the provider.`;
    } else if (status === 401 || status === 403) {
      message = `OpenCode server authentication failed${statusLabel}. Check OpenCode server authentication settings and refresh the provider in Paseo.`;
    } else if (status === 404) {
      message = `OpenCode ${operation} was not found${statusLabel}. If this started after upgrading OpenCode, update Paseo and refresh the provider.`;
    }
    super(message);
  }
}

import { HttpError } from "../errors.js";
import { isLoopback } from "./host.js";

export type AuthMode = "open" | "required";

/**
 * Resolved once, before the socket opens. The refusal is the whole point: the
 * old model trusted loopback, so a container that publishes its port would
 * otherwise serve an open editor to the internet.
 *
 * Anything that is not loopback is treated as public, wildcard binds included.
 * A wildcard answers on every interface the machine has, so it is reachable
 * from elsewhere even though it is not itself a routable address.
 */
export function resolveAuthMode(input: { hasPassword: boolean; host: string }): AuthMode {
  if (input.hasPassword) return "required";
  if (isLoopback(input.host) || input.host === "localhost") return "open";
  throw new HttpError(
    500,
    `Refusing to start: this server binds ${input.host}, which is reachable from ` +
      "other machines, and no password is set. Set SLIDE_STUDIO_PASSWORD, or run " +
      "--reset-password, before exposing it.",
  );
}

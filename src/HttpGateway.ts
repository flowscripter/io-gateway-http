import {
  type IOProvider,
  type LocationTarget,
  PayloadKind,
  type ProviderResolver,
} from "@flowscripter/pluggable-io-framework-api";
import { DEFAULT_RETRY, type RetryOptions } from "@flowscripter/pluggable-io-framework";
import { resolveTokenPath } from "./http/resolveTokenPath.ts";
import { GatewayGrant, type GrantScope } from "./token/GatewayGrant.ts";

export interface HttpGatewayOptions {
  /** Retries for transient provider failures, applied by the gateway so the HTTP client never sees them. */
  readonly retry?: RetryOptions;
}

export interface GrantOptions {
  readonly scope: GrantScope;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

/**
 * A local HTTP server on a loopback ephemeral port that serves
 * IOProvider locations. Access is by grant: each grant has a random token as
 * the first path segment, so relative references below the grant URL resolve
 * against its root and no client configuration is needed.
 */
export class HttpGateway {
  readonly #server: Bun.Server<undefined>;
  readonly #retry: RetryOptions;
  readonly #grants = new Map<string, GatewayGrant>();

  private constructor(retry: RetryOptions) {
    this.#retry = retry;
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      fetch: (request) => this.#handle(request),
    });
  }

  static start(options?: HttpGatewayOptions): HttpGateway {
    return new HttpGateway(options?.retry ?? DEFAULT_RETRY);
  }

  get origin(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  /**
   * Serves a container or single entry of `provider`. The provider must be
   * of the `js` payload kind and stays owned by the caller.
   */
  grant(
    provider: IOProvider<PayloadKind.Js>,
    target: LocationTarget,
    options: GrantOptions,
  ): GatewayGrant {
    return this.#addGrant(provider, target, options, false);
  }

  /**
   * Resolves `location` to a `js` provider and serves its target. The grant
   * owns the provider and disposes it when revoked.
   */
  async grantLocation(
    resolver: ProviderResolver,
    location: string,
    options: GrantOptions,
  ): Promise<GatewayGrant> {
    const { provider, target } = await resolver.createProviderForLocation(location, {
      kind: PayloadKind.Js,
    });
    try {
      return this.#addGrant(provider as IOProvider<PayloadKind.Js>, target, options, true);
    } catch (error) {
      await provider[Symbol.asyncDispose]();
      throw error;
    }
  }

  /**
   * Revokes every grant, waits for in-flight writes to settle, then stops the
   * server: responses in progress get `graceMs` to finish before their
   * connections are closed.
   */
  async close(graceMs = 1000): Promise<void> {
    const grants = [...this.#grants.values()];
    await Promise.all(grants.map((grant) => grant.revoke()));
    await Promise.all(grants.map((grant) => grant.settled()));
    this.#grants.clear();
    const stopping = this.#server.stop();
    const timer = setTimeout(() => void this.#server.stop(true), graceMs);
    await stopping;
    clearTimeout(timer);
  }

  #addGrant(
    provider: IOProvider,
    target: LocationTarget,
    options: GrantOptions,
    ownsProvider: boolean,
  ): GatewayGrant {
    if (provider.kind !== PayloadKind.Js) {
      throw new TypeError(`The gateway serves js providers, not "${provider.kind}"`);
    }
    if (target.kind === "pattern") {
      throw new TypeError("A pattern location cannot be served; use its container");
    }
    const token = randomToken();
    const grant = new GatewayGrant({
      provider: provider as IOProvider<PayloadKind.Js>,
      target,
      scope: options.scope,
      retry: this.#retry,
      origin: this.origin,
      token,
      ownsProvider,
    });
    this.#grants.set(token, grant);
    return grant;
  }

  async #handle(request: Request): Promise<Response> {
    const resolved = resolveTokenPath(new URL(request.url).pathname);
    if (resolved.kind === "malformed") {
      return new Response("Bad Request", { status: 400 });
    }
    const grant = resolved.kind === "ok" ? this.#grants.get(resolved.token) : undefined;
    if (resolved.kind === "escape") {
      return new Response("Forbidden", { status: 403 });
    }
    if (grant === undefined || grant.revoked) {
      return new Response("Not Found", { status: 404 });
    }
    return grant.handle(request, resolved.segments);
  }
}

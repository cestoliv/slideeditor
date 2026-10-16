import { lookup, type LookupAddress } from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { HttpError } from "../errors.js";
import { extensionForType, MAX_UPLOAD_BYTES } from "./media.js";

/*
 * The types imageDimensions can measure. SVG and AVIF are left out: the
 * library cannot size them without caller-supplied dimensions, and an SVG from
 * an arbitrary site would be served from this origin.
 */
const FETCHABLE = new Set(["png", "jpg", "webp", "gif"]);

/** The same budget a Google font fetch gets (fonts.ts). */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
// Some hosts, Wikimedia among them, refuse a request that names no client.
const USER_AGENT = "SlideStudio (+https://github.com/cestoliv/slideeditor)";

/**
 * Every address a public server has no business fetching for a caller:
 * loopback, private, link-local (cloud metadata lives at 169.254.169.254),
 * carrier-grade NAT, multicast and reserved. BlockList also matches an
 * IPv4-mapped IPv6 address against the IPv4 subnets, so `::ffff:127.0.0.1`
 * is caught by the `127.0.0.0/8` entry.
 */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  // IPv4-compatible addresses, which include :: and ::1.
  ["::", 96],
  ["64:ff9b::", 96],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv6");
}

function isPrivate(address: string): boolean {
  return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/**
 * Checks the addresses a hostname resolves to at connect time, on the
 * resolution the socket then uses. Checking before the request instead would
 * leave a gap: a DNS answer that changes between the check and the connect
 * would reach a private address.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    const refused = addresses.find((entry) => isPrivate(entry.address));
    if (refused) {
      return callback(blocked(hostname), "", 0);
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) return callback(new Error(`${hostname} did not resolve.`), "", 0);
    callback(null, first.address, first.family);
  });
};

function blocked(host: string): HttpError {
  return new HttpError(400, `${host} is a private address. Pass a public image URL.`);
}

export interface FetchedImage {
  bytes: Buffer;
  contentType: string;
}

export interface FetchImageOptions {
  /** Lets a test reach its own server on loopback. Production never sets it. */
  allowPrivate?: boolean;
}

/**
 * Downloads one image for the library. Refuses anything but http and https,
 * any host on a private address, a response that is not an image type the
 * library stores, and a body over 25 MB. The 10 second budget covers every
 * redirect and the whole body.
 */
export async function fetchImage(
  raw: string,
  { allowPrivate = false }: FetchImageOptions = {},
): Promise<FetchedImage> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = parseUrl(raw);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await request(url, signal, allowPrivate);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.destroy();
        url = parseUrl(new URL(location, url).href);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new HttpError(502, `${url.host} answered ${status}.`);
      }
      const contentType = response.headers["content-type"] ?? "";
      if (!FETCHABLE.has(extensionForType(contentType) ?? "")) {
        response.destroy();
        throw new HttpError(
          415,
          `${url.href} is ${contentType || "untyped"}, not a PNG, JPEG, WebP or GIF image.`,
        );
      }
      return { bytes: await readCapped(response), contentType };
    }
    throw new HttpError(502, `${raw} redirected more than ${MAX_REDIRECTS} times.`);
  } catch (error) {
    if (signal.aborted) {
      throw new HttpError(504, `${raw} took longer than 10 seconds to download.`);
    }
    if (error instanceof HttpError) throw error;
    // DNS failures, refused connections and resets.
    throw new HttpError(502, `Could not download ${raw}: ${String(error)}`);
  }
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `Not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, `Only http and https URLs are fetched, not ${url.protocol}`);
  }
  return url;
}

function request(
  url: URL,
  signal: AbortSignal,
  allowPrivate: boolean,
): Promise<IncomingMessage> {
  // A literal address never reaches the lookup, so it is checked here. The
  // guard also assumes a direct connection: behind an HTTP proxy, the proxy
  // resolves the host and the lookup below never sees it.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && isIP(host) && isPrivate(host)) throw blocked(host);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = client.get(
      url,
      {
        signal,
        headers: { "User-Agent": USER_AGENT },
        ...(allowPrivate ? {} : { lookup: guardedLookup }),
      },
      resolve,
    );
    outgoing.on("error", reject);
  });
}

/** Stops reading as soon as the body passes the cap, whatever Content-Length claimed. */
async function readCapped(response: IncomingMessage): Promise<Buffer> {
  const tooLarge = () => new HttpError(413, "Images must be 25MB or smaller.");
  if (Number(response.headers["content-length"]) > MAX_UPLOAD_BYTES) {
    response.destroy();
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      response.destroy();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

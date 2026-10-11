import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export function createNodeAdapter(
  handler: (request: Request) => Promise<Response>,
  origin: () => string,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded) abort.abort();
    };
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    try {
      if (!request.url?.startsWith("/") || request.url.startsWith("//"))
        throw new Error("INVALID_REQUEST_TARGET");
      const headers = new Headers();
      for (let index = 0; index < request.rawHeaders.length; index += 2)
        headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
      const method = request.method ?? "GET";
      if (
        (method === "GET" || method === "HEAD") &&
        (request.headers["transfer-encoding"] !== undefined ||
          Number(request.headers["content-length"] ?? 0) > 0)
      ) {
        response.writeHead(400, { "content-type": "application/json", connection: "close" });
        response.end('{"status":"failed","errorCode":"REQUEST_BODY_INVALID","retryable":false}');
        return;
      }
      const input = new Request(new URL(request.url, origin()), {
        method,
        headers,
        signal: abort.signal,
        ...(method === "GET" || method === "HEAD"
          ? {}
          : {
              body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
              duplex: "half" as const,
            }),
      });
      const result = await handler(input);
      if (response.destroyed) return;
      response.statusCode = result.status;
      for (const [key, value] of result.headers) response.setHeader(key, value);
      response.setHeader("connection", "close");
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!response.destroyed) {
        response.writeHead(503, { "content-type": "application/json", connection: "close" });
        response.end('{"status":"failed","errorCode":"HTTP_ADAPTER_FAILURE","retryable":true}');
      }
    } finally {
      request.removeListener("aborted", disconnected);
      response.removeListener("close", disconnected);
    }
  };
}
export function createCollectorServer(
  handler: (request: Request) => Promise<Response>,
  origin: () => string,
) {
  const adapter = createNodeAdapter(handler, origin);
  return createServer((request, response) => {
    void adapter(request, response);
  });
}

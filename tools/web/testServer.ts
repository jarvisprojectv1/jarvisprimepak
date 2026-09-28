// tools/web/testServer.ts - a tiny local HTTP server for tests, bound to
// 127.0.0.1 on an ephemeral port. Never used outside test files. Lets
// fetch-tool tests exercise real network I/O without depending on live
// internet access (per the task's own testing instructions).
import http, { type Server } from "node:http";

export interface TestServerHandle {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export async function startTestServer(routes: Record<string, RouteHandler>): Promise<TestServerHandle> {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url ?? "/"];
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(404).end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

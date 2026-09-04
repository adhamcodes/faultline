import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FaultlineRunArtifact } from "../core/types.js";
import {
  buildDashboardView,
  createDeterministicFallback,
  loadRunCatalog,
  type RunLoadResult,
} from "./data.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(moduleDirectory, "public");

const STATIC_ROUTES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/assets/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/assets/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
]);

export interface DashboardServerOptions {
  runsDirectory?: string;
  fallbackFactory?: () => Promise<FaultlineRunArtifact>;
}

function securityHeaders(response: ServerResponse, contentType: string): void {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response, "application/json; charset=utf-8");
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

export function createDashboardServer(options: DashboardServerOptions = {}): Server {
  const runsDirectory = path.resolve(options.runsDirectory ?? "runs");
  let fallback: Promise<FaultlineRunArtifact> | undefined;
  const fallbackFactory = (): Promise<FaultlineRunArtifact> => {
    fallback ??= (options.fallbackFactory ?? createDeterministicFallback)();
    return fallback;
  };
  const catalog = (): Promise<RunLoadResult> => loadRunCatalog(runsDirectory, fallbackFactory);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/api/runs") {
        const loaded = await catalog();
        sendJson(response, 200, {
          newest: loaded.runs[0]?.id,
          usedFallback: loaded.usedFallback,
          skippedMalformedCount: loaded.skippedMalformed.length,
          runs: loaded.runs.map((run) => ({
            id: run.id,
            fileName: run.fileName,
            source: run.source,
            modifiedAt: run.modifiedAt,
            runId: run.artifact.runId,
            mode: run.artifact.mode,
            status: run.artifact.incident.status,
            startedAt: run.artifact.incident.startedAt,
            completedAt: run.artifact.incident.completedAt,
            retries: run.artifact.inference.retries,
          })),
        });
        return;
      }

      if (url.pathname === "/api/run") {
        const loaded = await catalog();
        const id = url.searchParams.get("id") ?? loaded.runs[0]?.id;
        const run = loaded.runs.find((candidate) => candidate.id === id);
        if (!run) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        sendJson(response, 200, {
          source: run.source,
          fileName: run.fileName,
          artifact: run.artifact,
          view: buildDashboardView(run.artifact),
        });
        return;
      }

      const staticRoute = STATIC_ROUTES.get(url.pathname);
      if (staticRoute) {
        const content = await readFile(path.join(publicDirectory, staticRoute.file));
        securityHeaders(response, staticRoute.type);
        response.statusCode = 200;
        response.end(content);
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch {
      sendJson(response, 500, { error: "Dashboard request failed safely" });
    }
  });
}

async function main(): Promise<void> {
  const parsedPort = Number.parseInt(process.env.FAULTLINE_DASHBOARD_PORT ?? "4173", 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65_535 ? parsedPort : 4173;
  const server = createDashboardServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    console.log(`FAULTLINE dashboard: http://127.0.0.1:${actualPort}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

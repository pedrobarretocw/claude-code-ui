/**
 * HTTP API server for claude-code-loop commands.
 * Provides endpoints to create plans and start iteration loops.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";

const DEFAULT_API_PORT = 4451;

export interface ApiServerOptions {
  port?: number;
  workDir?: string;
  onClearSessions?: () => Promise<void>;
}

interface LoopProcess {
  id: string;
  process: ChildProcess;
  iterations: number;
  currentIteration: number;
  status: "running" | "completed" | "failed" | "cancelled";
  output: string[];
  startedAt: string;
}

export class ApiServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number;
  private workDir: string;
  private activeLoops: Map<string, LoopProcess> = new Map();
  private onClearSessions?: () => Promise<void>;

  constructor(options: ApiServerOptions = {}) {
    this.port = options.port ?? DEFAULT_API_PORT;
    this.workDir = options.workDir ?? process.cwd();
    this.onClearSessions = options.onClearSessions;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (error) => {
        log("API", `Server error: ${error.message}`);
        reject(error);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        log("API", `HTTP API server running on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Kill all active loops
    for (const [id, loop] of this.activeLoops) {
      if (loop.process && loop.status === "running") {
        loop.process.kill("SIGTERM");
        loop.status = "cancelled";
        log("API", `Cancelled loop ${id}`);
      }
    }
    this.activeLoops.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCorsHeaders(res);

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    try {
      if (req.method === "POST" && path === "/api/plan/create") {
        await this.handleCreatePlan(req, res);
      } else if (req.method === "POST" && path === "/api/plan/save") {
        await this.handleSavePlan(req, res);
      } else if (req.method === "POST" && path === "/api/loop/start") {
        await this.handleStartLoop(req, res);
      } else if (req.method === "GET" && path === "/api/loop/status") {
        this.handleLoopStatus(res);
      } else if (req.method === "POST" && path === "/api/loop/cancel") {
        await this.handleCancelLoop(req, res);
      } else if (req.method === "POST" && path === "/api/sessions/clear") {
        await this.handleClearSessions(res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      log("API", `Error handling ${path}: ${error}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  }

  private async parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  /**
   * POST /api/plan/create
   * Creates a new PRD.md by running claude with the provided prompt.
   * Body: { prompt: string, workDir?: string }
   */
  private async handleCreatePlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req);
    const prompt = body.prompt as string;
    const workDir = (body.workDir as string) ?? this.workDir;

    if (!prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'prompt' in request body" }));
      return;
    }

    log("API", `Creating plan in ${workDir} with prompt: ${prompt.slice(0, 50)}...`);

    // Build the claude command similar to gen-prd.sh
    // Use -p flag for non-interactive (print/pipe) mode
    const fullPrompt = `${prompt}. Save the plan to PRD.md and exit.`;

    try {
      const result = await this.runCommand(
        "claude",
        ["--permission-mode", "plan", "-p", fullPrompt],
        workDir
      );

      log("API", `Plan created successfully`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, output: result }));
    } catch (error) {
      log("API", `Failed to create plan: ${error}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  }

  /**
   * POST /api/plan/save
   * Saves the PRD content to PRD.md file
   * Body: { content: string, workDir?: string }
   */
  private async handleSavePlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req);
    const content = body.content as string;
    const workDir = (body.workDir as string) ?? this.workDir;

    if (!content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'content' in request body" }));
      return;
    }

    log("API", `Saving PRD to ${workDir}/PRD.md`);

    try {
      const prdPath = join(workDir, "PRD.md");
      await writeFile(prdPath, content, "utf-8");

      log("API", `PRD saved successfully`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, path: prdPath }));
    } catch (error) {
      log("API", `Failed to save PRD: ${error}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  }

  /**
   * POST /api/loop/start
   * Starts an iteration loop similar to ralph-afk.sh
   * Body: { iterations: number, workDir?: string }
   */
  private async handleStartLoop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req);
    const iterations = body.iterations as number;
    const workDir = (body.workDir as string) ?? this.workDir;

    if (!iterations || iterations < 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid 'iterations' in request body (must be >= 1)" }));
      return;
    }

    const loopId = `loop-${Date.now()}`;
    log("API", `Starting loop ${loopId} with ${iterations} iterations in ${workDir}`);

    // Start the loop in background
    this.startLoopProcess(loopId, iterations, workDir);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, loopId, iterations }));
  }

  /**
   * GET /api/loop/status
   * Returns status of all active and recent loops
   */
  private handleLoopStatus(res: ServerResponse): void {
    const loops = Array.from(this.activeLoops.values()).map((loop) => ({
      id: loop.id,
      iterations: loop.iterations,
      currentIteration: loop.currentIteration,
      status: loop.status,
      startedAt: loop.startedAt,
      outputLines: loop.output.length,
      lastOutput: loop.output.slice(-5),
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ loops }));
  }

  /**
   * POST /api/loop/cancel
   * Cancels an active loop
   * Body: { loopId: string }
   */
  private async handleCancelLoop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req);
    const loopId = body.loopId as string;

    if (!loopId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'loopId' in request body" }));
      return;
    }

    const loop = this.activeLoops.get(loopId);
    if (!loop) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Loop not found" }));
      return;
    }

    if (loop.status === "running" && loop.process) {
      loop.process.kill("SIGTERM");
      loop.status = "cancelled";
      log("API", `Cancelled loop ${loopId}`);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, loopId, status: loop.status }));
  }

  /**
   * POST /api/sessions/clear
   * Clears all sessions from the UI (does not delete files)
   */
  private async handleClearSessions(res: ServerResponse): Promise<void> {
    log("API", "Clearing all sessions");

    try {
      if (this.onClearSessions) {
        await this.onClearSessions();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      log("API", `Failed to clear sessions: ${error}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  }

  private startLoopProcess(loopId: string, iterations: number, workDir: string): void {
    const loop: LoopProcess = {
      id: loopId,
      process: null as unknown as ChildProcess,
      iterations,
      currentIteration: 0,
      status: "running",
      output: [],
      startedAt: new Date().toISOString(),
    };
    this.activeLoops.set(loopId, loop);

    // Run iterations sequentially
    this.runIterations(loop, workDir);
  }

  private async runIterations(loop: LoopProcess, workDir: string): Promise<void> {
    for (let i = 1; i <= loop.iterations; i++) {
      if (loop.status !== "running") break;

      loop.currentIteration = i;
      log("API", `Loop ${loop.id}: Starting iteration ${i}/${loop.iterations}`);

      try {
        const claudePrompt = `@PRD.md @progress.txt 
1. Find the highest-priority task and implement it.
2. Run your tests and type checks.
3. Update the PRD with what was done.
4. Append your progress to progress.txt.
5. Commit your changes.
ONLY WORK ON A SINGLE TASK.
If the PRD is complete, output <promise>COMPLETE</promise>.`;

        const result = await this.runCommandWithProcess(
          "claude",
          ["--dangerously-skip-permissions", "-p", claudePrompt],
          workDir,
          loop
        );

        loop.output.push(`=== Iteration ${i} ===`);
        loop.output.push(result);

        // Check for completion
        if (result.includes("<promise>COMPLETE</promise>")) {
          log("API", `Loop ${loop.id}: PRD complete after ${i} iterations`);
          loop.status = "completed";
          break;
        }
      } catch (error) {
        log("API", `Loop ${loop.id}: Iteration ${i} failed: ${error}`);
        loop.output.push(`Error in iteration ${i}: ${error}`);
        loop.status = "failed";
        break;
      }
    }

    if (loop.status === "running") {
      loop.status = "completed";
    }

    log("API", `Loop ${loop.id}: Finished with status ${loop.status}`);
  }

  private runCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs = 5 * 60 * 1000 // 5 minute default timeout
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        shell: false, // Don't use shell to avoid escaping issues
        stdio: ["ignore", "pipe", "pipe"], // Close stdin to prevent waiting for input
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Set timeout
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut) return; // Already rejected

        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private runCommandWithProcess(
    command: string,
    args: string[],
    cwd: string,
    loop: LoopProcess
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"], // Close stdin
      });

      loop.process = proc;

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0 || code === null) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on("error", reject);
    });
  }
}

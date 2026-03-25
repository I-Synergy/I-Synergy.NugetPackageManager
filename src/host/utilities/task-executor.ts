import { Mutex } from "async-mutex";
import { spawn } from "child_process";
import { Logger } from "../../common/logger";

export interface OperationProgress {
  stage: string;
  percent: number;
}

export class DotnetError extends Error {
  constructor(message: string, public readonly output: string) {
    super(message);
    this.name = "DotnetError";
  }
}

export class TaskExecutor {
  private globalMutex: Mutex = new Mutex();
  private progress = new Map<string, OperationProgress>();

  async ExecuteCommandAsync(command: string, args: string[], operationId: string): Promise<void> {
    Logger.info(`TaskExecutor.ExecuteCommandAsync: ${command} ${args.join(" ")}`);
    this.progress.set(operationId, { stage: "Starting...", percent: 5 });

    const releaser = await this.globalMutex.acquire();

    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args);
      let stdoutBuf = "";
      let stderrBuf = "";
      const allLines: string[] = [];

      const parseLine = (line: string): void => {
        const l = line.toLowerCase().trim();
        if (!l) return;
        allLines.push(line.trim());
        Logger.debug(`TaskExecutor [${operationId}]: ${line.trim()}`);

        let next: OperationProgress | null = null;
        if (l.includes("determining projects") || l.includes("restoring packages for")) {
          next = { stage: "Resolving...", percent: 20 };
        } else if (l.includes("adding packagereference") || l.includes("removing packagereference") || l.includes("installing ")) {
          next = { stage: "Updating project...", percent: 50 };
        } else if (l.includes("writing ") || l.includes("resolving conflicts") || l.includes("assets file")) {
          next = { stage: "Restoring...", percent: 70 };
        } else if (l.includes("restored ") || l.includes("restore completed")) {
          next = { stage: "Finishing...", percent: 95 };
        }
        if (next) this.progress.set(operationId, next);
      };

      child.stdout.on("data", (data: Buffer) => {
        stdoutBuf += data.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        lines.forEach(parseLine);
      });

      child.stderr.on("data", (data: Buffer) => {
        stderrBuf += data.toString();
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        lines.forEach(parseLine);
      });

      child.on("exit", (code) => {
        if (stdoutBuf) parseLine(stdoutBuf);
        if (stderrBuf) parseLine(stderrBuf);
        this.progress.delete(operationId);
        releaser();
        if (code === 0) {
          Logger.info(`TaskExecutor.ExecuteCommandAsync: Completed successfully`);
          resolve();
        } else {
          Logger.error(`TaskExecutor.ExecuteCommandAsync: Exited with code ${code}`);
          reject(new DotnetError(`dotnet exited with code ${code}`, allLines.join("\n")));
        }
      });

      child.on("error", (err) => {
        this.progress.delete(operationId);
        releaser();
        Logger.error(`TaskExecutor.ExecuteCommandAsync: Process error`, err);
        reject(err);
      });
    });
  }

  GetProgress(operationId: string): OperationProgress | null {
    return this.progress.get(operationId) ?? null;
  }
}

export default new TaskExecutor();

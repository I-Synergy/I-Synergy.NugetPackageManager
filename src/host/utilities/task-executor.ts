import { Mutex } from "async-mutex";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { Logger } from "../../common/logger";

export interface OperationProgress {
  stage: string;
  percent: number;
}

export class TaskExecutor {
  private globalMutex: Mutex = new Mutex();
  private progress = new Map<string, OperationProgress>();

  async ExecuteCommand(command: string, args: string[], operationId: string): Promise<void> {
    Logger.info(`TaskExecutor.ExecuteCommand: ${command} ${args.join(" ")}`);
    this.progress.set(operationId, { stage: "Starting...", percent: 5 });

    const releaser = await this.globalMutex.acquire();

    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args);
      let stdoutBuf = "";
      let stderrBuf = "";

      const parseLine = (line: string): void => {
        const l = line.toLowerCase().trim();
        if (!l) return;
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
          Logger.info(`TaskExecutor.ExecuteCommand: Completed successfully`);
          resolve();
        } else {
          const detail = stderrBuf.trim() || stdoutBuf.trim();
          const message = detail
            ? `dotnet exited with code ${code}: ${detail.split("\n").slice(-3).join(" ").trim()}`
            : `dotnet exited with code ${code}`;
          Logger.error(`TaskExecutor.ExecuteCommand: Exited with code ${code}`);
          reject(new Error(message));
        }
      });

      child.on("error", (err) => {
        this.progress.delete(operationId);
        releaser();
        Logger.error(`TaskExecutor.ExecuteCommand: Process error`, err);
        reject(err);
      });
    });
  }

  GetProgress(operationId: string): OperationProgress | null {
    return this.progress.get(operationId) ?? null;
  }

  async ExecuteTask(task: vscode.Task): Promise<void> {
    Logger.info(`TaskExecutor.ExecuteTask: Executing task ${task.name}`);

    if (task.execution instanceof vscode.ShellExecution) {
      const shellExec = task.execution as vscode.ShellExecution;
      const args = typeof shellExec.args === 'string' ? shellExec.args : (shellExec.args || []).map(a => typeof a === 'string' ? a : a.value).join(' ');
      Logger.debug(`TaskExecutor.ExecuteTask: Shell command: ${shellExec.commandLine || shellExec.command} ${args}`);
    } else if (task.execution instanceof vscode.ProcessExecution) {
      const procExec = task.execution as vscode.ProcessExecution;
      Logger.debug(`TaskExecutor.ExecuteTask: Process: ${procExec.process} ${(procExec.args || []).join(' ')}`);
    }

    const releaser = await this.globalMutex.acquire();
    const mutex = new Mutex();
    const release = await mutex.acquire();
    const execution = await vscode.tasks.executeTask(task);

    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        settled = true;
        Logger.error(`TaskExecutor.ExecuteTask: Task ${task.name} timed out after 120s`);
        release();
      }
    }, 120_000);

    const callback = vscode.tasks.onDidEndTask((x) => {
      if (x.execution.task == execution.task && !settled) {
        settled = true;
        Logger.info(`TaskExecutor.ExecuteTask: Task ${task.name} completed`);
        clearTimeout(timeoutHandle);
        release();
      }
    });

    await mutex.waitForUnlock();
    releaser();
    callback.dispose();
  }
}

export default new TaskExecutor();

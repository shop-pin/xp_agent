import * as readline from "readline";
import { pathToFileURL } from "url";
import { resolve } from "path";
import chalk from "chalk";
import { Agent } from "./agent.js";
import { getLatestSessionId } from "./plugins/session-jsonl.js";
import type { PermissionMode } from "./permissions.js";
import { printError, printInfo, printPlanForApproval, printPlanApprovalOptions } from "./ui.js";
import type { CommandService } from "./services/commands.js";
import type { Row } from "./cordis.config.js";

/** E1：欢迎横幅消费命令注册表——命令清单不再是 cli 的硬编码知识。 */
function printWelcome(commands: CommandService) {
    console.log(
        chalk.bold.cyan("\n  Mini Claude Code") +
        chalk.gray(" — A minimal coding agent\n")
    );
    console.log(chalk.gray("  Type your request, or 'exit' to quit."));
    console.log(chalk.gray("  Commands: " + commands.list().map((c) => `/${c.name}`).join(" ")));
    for (const c of commands.list()) {
        if (c.name === "goal" || c.name === "loop") {
            console.log(chalk.gray(`  /${c.name} — ${c.description}`));
        }
    }
    console.log("");
}

const USAGE = `
Usage: mini-claude [options] [prompt]

Options:
  --plan              Plan mode: read-only, describe changes without executing
  --auto              Auto Mode: an LLM classifier judges each action instead of asking
  --yolo, -y          Skip all confirmation prompts (bypassPermissions mode)
  --accept-edits      Auto-approve file edits, still confirm dangerous shell
  --dont-ask          Auto-deny anything needing confirmation (for CI)
  --resume            Resume the last session
  --goal <condition>  Pursue a goal across turns until an evaluator judges it met
  --max-cost USD      Stop when estimated cost exceeds this amount
  --max-turns N       Stop after N agentic turns
  --profile <name>    Plugin manifest profile: full (default) | no-auto (auto-mode classifier removed)
  --patch <file>      Append plugin rows from a .mjs exporting "rows" (same-id rows override)
  --dump-config       Print the final merged plugin manifest and exit
  --help, -h          Show this help
  (model via env: ANTHROPIC_MODEL_ID, base URL via ANTHROPIC_BASE_URL)

REPL commands:
  /clear              Clear conversation history
  /plan               Toggle plan mode (read-only <-> normal)
  /cost               Show token usage and estimated cost
  /compact            Manually compact the conversation
  /goal <condition>   Pursue a goal until an evaluator judges it met
  /goal               Show the active goal's status
  /loop [interval] <prompt>  Re-run a prompt on an interval (5m/2h) or self-paced
  /memory             List saved memories
  /skills             List available skills
  /<skill-name>       Invoke a skill (e.g. /commit "fix types")
  Ctrl+C twice        Exit (single Ctrl+C interrupts a running turn/loop)
`;

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return;
    }
    let resume: boolean = false;
    if (argv.includes("--resume")) {
        resume = true;
        argv = argv.filter((t) => t !== "--resume");
    }
    // 模式 flag 先解析完再构造 Agent——--plan 的 plan 文件路径在构造期生成
    // （对齐 src：parseArgs → new Agent({ permissionMode })，构造函数处理 plan 态）
    let permissionMode: PermissionMode = "default";
    if (argv.includes("--plan")) {
        permissionMode = "plan";
        argv = argv.filter((t) => t !== "--plan");
        console.log(`(plan mode: read-only)`);
    }

    if (argv.includes("--auto")) {
        permissionMode = "auto";
        argv = argv.filter((t) => t !== "--auto");
        console.log(`(auto mode: a classifier gates dangerous actions)`);
    }

    if (argv.includes("--yolo") || argv.includes("-y")) {
        permissionMode = "bypassPermissions";
        argv = argv.filter((t) => t !== "--yolo" && t !== "-y");
        console.log(`(bypassPermissions: confirmations skipped; deny rules still apply)`);
    }

    if (argv.includes("--accept-edits")) {
        permissionMode = "acceptEdits";
        argv = argv.filter((t) => t !== "--accept-edits");
        console.log(`(acceptEdits: file edits auto-approved, dangerous shell still confirmed)`);
    }

    if (argv.includes("--dont-ask")) {
        permissionMode = "dontAsk";
        argv = argv.filter((t) => t !== "--dont-ask");
        console.log(`(dontAsk: anything needing confirmation is auto-denied)`);
    }

    // E2：装配旗标——profile 选命名补丁（full/no-auto），--patch 追加用户行
    // （最后落笔、赢过一切层；同 id 整行替换是 B6 定死的语义）
    let profile: string | undefined;
    const profIdx = argv.indexOf("--profile");
    if (profIdx >= 0) {
        profile = argv[profIdx + 1];
        if (!profile) throw new Error("--profile requires a name (full | no-auto)");
        argv.splice(profIdx, 2);
        console.log(`(profile: ${profile})`);
    }
    let extraRows: Row[] | undefined;
    const patchIdx = argv.indexOf("--patch");
    if (patchIdx >= 0) {
        const file = argv[patchIdx + 1];
        if (!file) throw new Error("--patch requires a .mjs file exporting rows");
        argv.splice(patchIdx, 2);
        const mod = await import(pathToFileURL(resolve(file)).href);
        const rows = (mod.rows ?? mod.default) as Row[];
        if (!Array.isArray(rows)) throw new Error(`--patch file must export rows: Row[] (got ${file})`);
        extraRows = rows;
        console.log(`(patch: +${rows.length} row(s) from ${file})`);
    }

    if (argv.includes("--dump-config")) {
        // 装配预览：挂完整清单再打行表（app 层的桥/选项只有宿主在才拿得到），
        // 不进 REPL。危险点：这是最终行表视图，运行态 fiber 树看 agent.dumpTree()
        const agent = new Agent({ permissionMode, profile, extraRows });
        console.log(agent.dumpConfig());
        await agent.close();
        return;
    }

    const agent = new Agent({ permissionMode, profile, extraRows });
    if (resume) {
        const sessionId = getLatestSessionId();
        if (sessionId) {
            // C8：resume = JSONL 重放（消息 + mode/cost/激活工具/goal 一并恢复）
            if (!agent.resume(sessionId)) printInfo("No session found to resume.");
        } else {
            printInfo("No previous sessions found.");
        }
    }

    let goalCondition: string | undefined;
    if (argv.includes("--goal")) {
        const gi = argv.indexOf("--goal");
        goalCondition = argv[gi + 1];
        argv.splice(gi, 2);
    }

    if (argv.includes("--max-cost")) {
        const mi = argv.indexOf("--max-cost");
        const maxCost = Number(argv[mi + 1]);
        agent.setMaxCost(maxCost);
        argv.splice(mi, 2);
        console.log(`(max-cost: $${maxCost})`);
    }

    if (argv.includes("--max-turns")) {
        const ti = argv.indexOf("--max-turns");
        agent.setMaxTurns(Number(argv[ti + 1]));
        argv.splice(ti, 2);
    }

    const oneshot = argv.join(" ").trim()
    if (goalCondition) {
        const directive = agent.setGoal(goalCondition);
        await agent.pursueGoal(directive);
        await agent.close(); // 同 one-shot：MCP 子进程 stdio 会挂住事件循环
        return;
    }
    if (oneshot) {
        await agent.send(oneshot);
        await agent.close(); // MCP 子进程 stdio 会挂住事件循环，one-shot 结束必须显式关闭
        return;
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    // 复用同一个 readline 做确认，避免在同一个 stdin 上开第二个 interface
    // 把第一个搞挂的经典 Node.js 坑
    agent.setConfirmFn((_message: string) => {
        return new Promise((resolve) => {
            rl.question("  Allow? (y/n): ", (answer) => {
                resolve(answer.toLowerCase().startsWith("y"));
            });
        });
    });
    // 审批回调同理复用 readline（理由同上）。选项 4 追问反馈；无效输入原界面重问
    agent.setPlanApprovalFn((planContent: string) => {
        return new Promise((resolve) => {
            printPlanForApproval(planContent);
            printPlanApprovalOptions();

            const askChoice = () => {
                rl.question("  Enter choice (1-4): ", (answer) => {
                    const choice = answer.trim();
                    if (choice === "1") {
                        resolve({ choice: "clear-and-execute" });
                    } else if (choice === "2") {
                        resolve({ choice: "execute" });
                    } else if (choice === "3") {
                        resolve({ choice: "manual-execute" });
                    } else if (choice === "4") {
                        rl.question("  Feedback (what to change): ", (feedback) => {
                            resolve({ choice: "keep-planning", feedback: feedback.trim() || undefined });
                        });
                    } else {
                        console.log("  Invalid choice. Enter 1, 2, 3, or 4.");
                        askChoice();
                    }
                });
            };
            askChoice();
        });
    });
    printWelcome(agent.commands);
    return await new Promise<void>((resolve) => {
        // stdin EOF (Ctrl+D on an empty line) closes the readline interface
        // mid-flight; asking a closed interface throws. Stop asking and let
        // the outer await finish.
        let closed = false;
        rl.on("close", () => { closed = true; resolve(); });
        // SIGINT 两连退出：agent 处理中 → cancel(cause)（停 loop/goal 标志 +
        // 清 inbox + abort 在途请求，busy 时由 agent 自己报告打断）、留在 REPL
        // （send 的 settle 以 abort 错误 reject，经 ask 的 catch 回到提示符）；
        // 空闲 → 第一次提示、第二次退出。
        // rl 层挂一个（问题挂起时 Ctrl+C 被原始模式下的 readline 拦截）、
        // process 层挂一个（处理中无问题挂起，终端信号直达进程）——两个路径
        // 互斥，不会双触发。
        let sigintCount = 0;
        const handleInterrupt = () => {
            const wasBusy = agent.busy;
            agent.cancel(wasBusy ? "(interrupted)" : undefined);
            if (wasBusy) {
                sigintCount = 0;
                return; // settle 的 abort 错误会走 ask 的 catch，重新出提示符
            }
            sigintCount++;
            if (sigintCount >= 2) {
                console.log("\nBye!\n");
                // 先断 MCP 子进程/定时器，否则它们会吊住进程（issue #8 教训）
                agent.close().finally(() => process.exit(0));
                return;
            }
            console.log("\n  Press Ctrl+C again to exit.");
            ask(); // 挂着的 question 已死（Ctrl+C 被吞后不会回调），重新挂一个
        };
        rl.on("SIGINT", handleInterrupt);
        process.on("SIGINT", handleInterrupt);
        const isAbort = (e: any) => e?.name === "AbortError" || String(e?.message ?? "").includes("aborted");
        const ask = () => {
            if (closed) return;
            rl.question("you: ", async (line) => {
                const input = line.trim();
                sigintCount = 0;
                if (input === "exit" || input === "quit") {
                    rl.close();
                    resolve();
                    return;
                }
                // E1：斜杠分发 = 查命令注册表（静态命令 → 技能回退都在表那侧）；
                // 谁都不认 → 普通输入透传给 agent。错误打印收口在 dispatch 的
                // 调用方（命令 handler 内部的 runGuarded 已挡住 agent 驱动命令）
                if (input) {
                    try {
                        const handled = await agent.commands.dispatch(input);
                        if (!handled) {
                            try {
                                await agent.send(input);
                            } catch (e: any) {
                                // 中断由 SIGINT 处理器报告过了，这里只报真错误
                                if (!isAbort(e)) printError(String(e.message ?? e));
                            }
                        }
                    } catch (e: any) {
                        if (!isAbort(e)) printError(String(e.message ?? e));
                    }
                }
                ask();
            });
        };
        ask();
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
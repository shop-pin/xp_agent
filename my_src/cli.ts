import * as readline from "readline";
import { pathToFileURL } from "url";
import { Agent } from "./agent.js";
import { loadSession, getLatestSessionId } from "./session.js";
import { discoverSkills, getSkillByName, resolveSkillPrompt } from "./skills.js";
import { listMemories } from "./memory.js";
import type { PermissionMode } from "./permissions.js";
import { printWelcome, printError, printInfo, printPlanForApproval, printPlanApprovalOptions } from "./ui.js";

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

    const agent = new Agent({ permissionMode });
    if (resume) {
        const sessionId = getLatestSessionId();
        if (sessionId) {
            const session = loadSession(sessionId);
            if (session) {
                agent.restoreSession({ anthropicMessages: session.anthropicMessages });
            } else {
                printInfo("No session found to resume.");
            }
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
        await agent.chat(oneshot);
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
    // 审批回调复用同一个 readline（同一个 stdin 开第二个 interface 的经典坑）。
    // 选项 4 追问反馈；无效输入原界面重问
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
    printWelcome();
    return await new Promise<void>((resolve) => {
        // stdin EOF (Ctrl+D on an empty line) closes the readline interface
        // mid-flight; asking a closed interface throws. Stop asking and let
        // the outer await finish.
        let closed = false;
        rl.on("close", () => { closed = true; resolve(); });
        // SIGINT 两连退出：agent 处理中 → abort 在途请求、留在 REPL（经
        // chat 抛出的 abort 错误回到 ask 循环）；空闲 → 第一次提示、第二次退出。
        // stopLoop/stopGoal 先行——loop tick 间隙 agent 不在"处理中"，
        // abort 路径够不着它们，只有停止标志能接住。rl 层挂一个（问题挂起时
        // Ctrl+C 被原始模式下的 readline 拦截）、process 层挂一个（处理中无
        // 问题挂起，终端信号直达进程）——两个路径互斥，不会双触发。
        let sigintCount = 0;
        const handleInterrupt = () => {
            agent.stopLoop();
            agent.stopGoal();
            if (agent.isProcessing) {
                agent.abort();
                console.log("\n  (interrupted)");
                sigintCount = 0;
                return; // chat 抛出的 abort 错误会走 ask 的 catch，重新出提示符
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
                if (input === "/clear") {
                    agent.clearHistory();
                    console.log(`(history cleared)`);
                    ask();
                    return;
                }
                if (input === "/plan") {
                    agent.togglePlanMode();
                    ask();
                    return;
                }
                if (input === "/cost") {
                    agent.showCost();
                    ask();
                    return;
                }
                if (input === "/compact") {
                    try {
                        await agent.compactAnthropic();
                    } catch (e: any) {
                        printError(String(e.message ?? e));
                    }
                    ask();
                    return;
                }
                if (input === "/memory") {
                    const memories = listMemories();
                    if (memories.length === 0) {
                        printInfo("No memories saved yet.");
                    } else {
                        printInfo(`${memories.length} memories:`);
                        for (const m of memories) {
                            console.log(`    [${m.type}] ${m.name} — ${m.description}`);
                        }
                    }
                    ask();
                    return;
                }
                if (input === "/goal" || input.startsWith("/goal ")) {
                    const condition = input.slice("/goal".length).trim();
                    if (!condition) {
                        agent.showGoal();
                        ask();
                        return;
                    }
                    const directive = agent.setGoal(condition);
                    try {
                        await agent.pursueGoal(directive);
                    } catch (e: any) {
                        if (!isAbort(e)) printError(String(e.message ?? e));
                    }
                    ask();
                    return;
                }
                if (input === "/loop" || input.startsWith("/loop ")) {
                    const rest = input.slice("/loop".length).trim();
                    try {
                        await agent.runLoop(rest);
                    } catch (e: any) {
                        if (!isAbort(e)) printError(String(e.message ?? e));
                    }
                    ask();
                    return;
                }
                if (input === "/skills") {
                    const skills = discoverSkills();
                    if (skills.length === 0) {
                        printInfo("No skills found. Add skills to .claude/skills/<name>/SKILL.md");
                    } else {
                        printInfo(`${skills.length} skills:`);
                        for (const s of skills) {
                            const tag = s.userInvocable ? `/${s.name}` : s.name;
                            console.log(`    ${tag} (${s.source}) — ${s.description}`);
                        }
                    }
                    ask();
                    return;
                }
                // Skill invocation: /<skill-name> [args]——inline 直接注入解析后的模板；
                // fork 借模型之手走 skill 工具，由 executeSkillTool 派发隔离子 agent
                if (input.startsWith("/")) {
                    const spaceIdx = input.indexOf(" ");
                    const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
                    const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
                    const skill = getSkillByName(cmdName);
                    if (skill && skill.userInvocable) {
                        printInfo(`Invoking skill: ${skill.name}`);
                        try {
                            if (skill.context === "fork") {
                                await agent.chat(`Use the skill tool to invoke "${skill.name}" with args: ${cmdArgs || "(none)"}`);
                            } else {
                                await agent.chat(resolveSkillPrompt(skill, cmdArgs));
                            }
                        } catch (e: any) {
                            if (!isAbort(e)) printError(String(e.message ?? e));
                        }
                        ask();
                        return;
                    }
                    // 未知命令——按普通输入透传
                }
                if (input) {
                    try {
                        await agent.chat(input);
                    } catch (e: any) {
                        // 中断由 SIGINT 处理器报告过了，这里只报真错误
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
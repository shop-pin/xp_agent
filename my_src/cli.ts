import * as readline from "readline";
import { pathToFileURL } from "url";
import { Agent } from "./agent.js";
import { loadSession, getLatestSessionId } from "./session.js";
import { discoverSkills, getSkillByName, resolveSkillPrompt } from "./skills.js";
import { printWelcome, printError, printInfo } from "./ui.js";

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
    let resume: boolean = false;
    if (argv.includes("--resume")) {
        resume = true;
        argv = argv.filter((t) => t !== "--resume");
    }
    const agent = new Agent();
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
    if (argv.includes("--plan")) {
        agent.setMode("plan");
        argv = argv.filter((t) => t !== "--plan");
        console.log(`(plan mode: read-only)`);
    }

    if (argv.includes("--auto")) {
        agent.setMode("auto");
        argv = argv.filter((t) => t !== "--auto");
        console.log(`(auto mode: a classifier gates dangerous actions)`);
    }

    if (argv.includes("--yolo") || argv.includes("-y")) {
        agent.setMode("bypassPermissions");
        argv = argv.filter((t) => t !== "--yolo" && t !== "-y");
        console.log(`(bypassPermissions: confirmations skipped; deny rules still apply)`);
    }

    if (argv.includes("--accept-edits")) {
        agent.setMode("acceptEdits");
        argv = argv.filter((t) => t !== "--accept-edits");
        console.log(`(acceptEdits: file edits auto-approved, dangerous shell still confirmed)`);
    }

    if (argv.includes("--dont-ask")) {
        agent.setMode("dontAsk");
        argv = argv.filter((t) => t !== "--dont-ask");
        console.log(`(dontAsk: anything needing confirmation is auto-denied)`);
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
        await agent.pursueGoal(goalCondition, oneshot);
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
    printWelcome();
    return await new Promise<void>((resolve) => {
        // stdin EOF (Ctrl+D on an empty line) closes the readline interface
        // mid-flight; asking a closed interface throws. Stop asking and let
        // the outer await finish.
        let closed = false;
        rl.on("close", () => { closed = true; resolve(); });
        const ask = () => {
            if (closed) return;
            rl.question("you: ", async (line) => {
                const input = line.trim();
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
                            printError(String(e.message ?? e));
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
                        printError(String(e.message ?? e));
                    }
                }
                ask();
            });
        };
        ask();
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
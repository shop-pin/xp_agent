import * as readline from "readline";
import { pathToFileURL } from "url";
import { Agent } from "./agent.js";
import { saveSession, loadSession } from "./session.js";
import { resolveSkill } from "./skills.js";

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
    let resume: boolean = false;
    if (argv.includes("--resume")) {
        resume = true;
        argv = argv.filter((t) => t !== "--resume");
    }
    const agent = new Agent();
    if (resume) {
        const saved = loadSession();
        if (saved != null) {
            agent.loadHistory(saved as any);
            console.log(`resumed ${saved.length} messages`);
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

    let goalCondition: string | undefined;
    if (argv.includes("--goal")) {
        const gi = argv.indexOf("--goal");
        goalCondition = argv[gi + 1];
        argv.splice(gi, 2);
    }

    const oneshot = argv.join(" ").trim()
    if (goalCondition) {
        await agent.pursueGoal(goalCondition, oneshot);
        saveSession(agent.history());
        return;
    }
    if (oneshot) {
        await agent.chat(resolveSkill(oneshot) ?? oneshot);
        agent.closeMcp(); // MCP 子进程 stdio 会挂住事件循环，one-shot 结束必须显式关闭
        saveSession(agent.history())
        return;
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
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
                    saveSession(agent.history());
                    console.log(`(history cleared)`);
                    ask();
                    return;
                }
                if (input) {
                    try {
                        await agent.chat(resolveSkill(input) ?? input);
                    } catch (e: any) {
                        console.error(`error: ${e.message ?? e}`);
                    }
                    saveSession(agent.history());
                }
                ask();
            });
        };
        ask();
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
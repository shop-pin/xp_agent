import chalk from "chalk";

export function printAssistantText(text: string) {
    process.stdout.write(text);
}

export function printToolCall(name: string, input: Record<string, any>) {
    const icon = getToolIcon(name);
    const summary = getToolSummary(name, input);
    console.log(chalk.yellow(`\n  ${icon} ${name}`) + chalk.gray(` ${summary}`));
}

export function printError(msg: string) {
    console.error(chalk.red(`\n  Error: ${msg}`));
}

export function printConfirmation(command: string): void {
    console.log(
        chalk.yellow("\n  ⚠ Dangerous command: ") + chalk.white(command)
    );
}

export function printCost(inputTokens: number, outputTokens: number, cacheRead = 0, cacheCreation = 0) {
    const total =
        (inputTokens / 1_000_000) * 3 +
        (cacheRead / 1_000_000) * 0.3 +
        (cacheCreation / 1_000_000) * 3.75 +
        (outputTokens / 1_000_000) * 15;
    const cacheStr = cacheRead ? `, ${cacheRead} cached` : "";
    console.log(
        chalk.gray(
            `\n  Tokens: ${inputTokens} in / ${outputTokens} out${cacheStr} (~$${total.toFixed(4)})`
        )
    );
}

export function printRetry(attempt: number, max: number, reason: string) {
    console.log(
        chalk.yellow(`\n  ↻ Retry ${attempt}/${max}: ${reason}`)
    );
}

export function printInfo(msg: string) {
    console.log(chalk.cyan(`\n  ℹ ${msg}`));
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

export function startSpinner(label = "Thinking") {
    if (spinnerTimer) {
        return;
    }
    spinnerFrame = 0;
    process.stdout.write(chalk.gray(`\n  ${SPINNER_FRAMES[spinnerFrame]} ${label}...`));
    spinnerTimer = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        process.stdout.write(`${chalk.gray(`\r  ${SPINNER_FRAMES[spinnerFrame]} ${label}...`)}`)
    }, 80);
}

export function stopSpinner() {
    if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
    }
    process.stdout.write("\r\x1b[K");
}

export function printPlanForApproval(planContent: string) {
    console.log(chalk.cyan("\n  ━━━ Plan for Approval ━━━"));
    const lines = planContent.split("\n");
    const maxLines = 60;
    const display = lines.slice(0, maxLines);
    for (const line of display) {
        console.log(chalk.white("  " + line));
    }
    if (lines.length > maxLines) {
        console.log(chalk.gray(`  ... (${lines.length - maxLines} more lines)`));
    }
    console.log(chalk.cyan("  ━━━━━━━━━━━━━━━━━━━━━━━━\n"));
}

export function printPlanApprovalOptions() {
    console.log(chalk.yellow("  Choose an option:"));
    console.log(chalk.white("    1) Yes, clear context and execute") + chalk.gray(" — fresh start with auto-accept edits"));
    console.log(chalk.white("    2) Yes, and execute") + chalk.gray(" — keep context, auto-accept edits"));
    console.log(chalk.white("    3) Yes, manually approve edits") + chalk.gray(" — keep context, confirm each edit"));
    console.log(chalk.white("    4) No, keep planning") + chalk.gray(" — provide feedback to revise"));
}

export function printSubAgentStart(type: string, description: string) {
    console.log(
        chalk.magenta(`\n  ┌─ Sub-agent [${type}]: ${description}`)
    );
}

export function printSubAgentEnd(type: string, description: string) {
    console.log(
        chalk.magenta(`  └─ Sub-agent [${type}] completed`)
    );
}

function getToolIcon(name: string): string {
    const icons: Record<string, string> = {
        read_file: "📖",
        write_file: "✏️",
        edit_file: "🔧",
        list_files: "📁",
        grep_search: "🔍",
        run_shell: "💻",
        skill: "⚡",
        agent: "🤖",
    };
    return icons[name] || "🔨";
}

function getToolSummary(name: string, input: Record<string, any>): string {
    switch (name) {
        case "read_file":
            return input.file_path;
        case "write_file":
            return input.file_path;
        case "edit_file":
            return input.file_path;
        case "list_files":
            return input.pattern;
        case "grep_search":
            return `"${input.pattern}" in ${input.path || "."}`;
        case "run_shell": {
            const cmd = String(input.command ?? "");
            return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
        }
        case "skill":
            return input.skill_name;
        case "agent":
            return `[${input.type || "general"}] ${input.description || ""}`;
        default:
            return "";
    }
}

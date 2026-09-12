import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SKILL_DIR = join(process.cwd(), ".mini-skills");

export function resolveSkill(input: string): string | null {
    if (!input.startsWith("/")) {
        return null;
    }

    const [name, ...rest] = input.slice(1).split(" ");
    const file = join(SKILL_DIR, name + ".md");
    if (!existsSync(file)) {
        return null;
    }
    const prompt = readFileSync(file, "utf-8").trim();
    const args = rest.join(" ").trim();
    return args ? `${prompt}\n\n${args}` : prompt;
}

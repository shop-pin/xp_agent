import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const MEMORY_DIR = join(process.cwd(), ".mini-memory");

export function recallMemories(query: string): string {
    if (!existsSync(MEMORY_DIR)) {
        return "";
    }
    const queryWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"));
    const scored: { text: string; score: number }[] = [];
    for (const f of files) {
        const content = readFileSync(join(MEMORY_DIR, f), "utf-8");
        const contentWords = new Set(content.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
        let score = 0;
        for (const q of queryWords) {
            if (contentWords.has(q)) {
                score++;
            }
        }
        if (score > 0) {
            scored.push({ text: content, score });
        }
    }
    const top = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((t) => `- ${t.text}`)
        .join("\n");
    return `\n\n# Memory (things you remember about the user and project)\n${top}`;
}
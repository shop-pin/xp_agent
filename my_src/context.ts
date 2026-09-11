import Anthropic from "@anthropic-ai/sdk";

const COMPACT_THRESHOLD = 6;
const KEEP_RECENT = 2;

export async function maybeCompact(
    messages: Anthropic.MessageParam[],
    client: Anthropic,
    model: string,
): Promise<Anthropic.MessageParam[]> {
    if (messages.length <= COMPACT_THRESHOLD) {
        return messages;
    }
    const older = messages.slice(0, messages.length - KEEP_RECENT);
    const recent = messages.slice(messages.length - KEEP_RECENT, messages.length);
    const lines: string[] = [];
    for (const m of older) {
        lines.push(`${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`);
    }
    const transcript = lines.join("\n");
    const reply = await client.messages.create({
        model,
        max_tokens: 1024,
        system: "Summarize the conversation so far in a few sentences, keeping key facts.",
        messages: [{ role: "user", content: transcript }],
    });
    const summary = reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    console.log(`  (compacted ${older.length} messages into a summary)`);
    return [{ role: "user", content: `[Summary of earlier conversation]\n${summary}`}, ...recent];
}
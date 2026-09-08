import { readFileSync } from "fs";
import type Anthropic from "@anthropic-ai/sdk";

export const toolDefinitions: Anthropic.Tool[] = [
    {
        name: "read_file",
        description: "Read the content of a file.",
        input_schema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "The path to the file to be read",
                },
            },
            required: ["file_path"],
        },
    },
];

export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
    switch (name) {
        case "read_file":
            return readFile(input as { file_path: string });
        default:
            return `Unknown tool ${name}`;
    }
}

function readFile(input: { file_path: string }): string {
    try {
        const lines = readFileSync(input.file_path, "utf-8").split("\n");
        return lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
    } catch (e: any) {
        return `Error reading file: ${e.message}`;
    }
}
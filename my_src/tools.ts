import type Anthropic from "@anthropic-ai/sdk";

// tools.ts——12 个工具的 schema 数据（单一来源）。
// C1 起 execute 逻辑迁往 plugins/core-*-tools.ts，激活态与截断迁往
// services/tools.ts；本文件只剩 schema：subagent.ts 的筛选、agent.ts 的
// customTools 缺省、插件的 schemaOf 都以这里为准。数组顺序 = 注册序基准 =
// 请求体 tools 数组序，动前先跑 mock 回归。

// deferred 标记的工具不随 schema 广告（getActiveToolDefinitions 过滤），
// 模型经 tool_search 搜索到后才激活——大多数会话用不到的工具不占提示词空间
export type ToolDef = Anthropic.Tool & { deferred?: boolean };

export const toolDefinitions: ToolDef[] = [
    {
        name: "read_file",
        description: "Read the contents of a file. Returns the file content with line numbers.",
        input_schema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "The path to the file to read",
                },
            },
            required: ["file_path"],
        },
    },
    {
        name: "write_file",
        description: "Write content to a file. Creates it if missing, overwrites if it exists.",
        input_schema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "The path to the file to write",
                },
                content: {
                    type: "string",
                    description: "The content to write",
                },
            },
            required: ["file_path", "content"],
        },
    },
    {
        name: "edit_file",
        description: "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
        input_schema: {
            type: "object",
            properties: {
                file_path: {
                    type: "string",
                    description: "The path to the file to edit",
                },
                old_string: {
                    type: "string",
                    description: "The exact string to find",
                },
                new_string: {
                    type: "string",
                    description: "The string to replace it with",
                }
            },
            required: ["file_path", "old_string", "new_string"],
        },
    },
    {
        name: "list_files",
        description: 'List files matching a glob pattern (e.g. "**/*.ts").',
        input_schema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Glob pattern to match files",
                },
                path: {
                    type: "string",
                    description: "Base directory. Defaults to cwd.",
                },
            },
            required: ["pattern"],
        },
    },
    {
        name: "grep_search",
        description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
        input_schema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "The regex pattern to search for",
                },
                path: {
                    type: "string",
                    description: "Directory or file to search. Defaults to cwd.",
                },
            },
            required: ["pattern"],
        },
    },
    {
        name: "run_shell",
        description: "Execute a shell command and return its output. For tests, git, package installs, etc.",
        input_schema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute",
                },
            },
            required: ["command"],
        },
    },
    {
        name: "web_fetch",
        description: "Fetch a URL and return its content as text. For HTML pages, tags are stripped.",
        input_schema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "The URL to fetch",
                },
                max_length: {
                    type: "number",
                    description: "Maximum content length (default 50000)",
                },
            },
            required: ["url"],
        },
    },
    {
        name: "enter_plan_mode",
        description:
            "Enter plan mode to switch to a read-only planning phase. In plan mode, you can only read files and write to the plan file. Use this when you need to explore the codebase and design an implementation plan before making changes.",
        input_schema: {
            type: "object",
            properties: {},
        },
        deferred: true,
    },
    {
        name: "exit_plan_mode",
        description:
            "Exit plan mode after you have finished writing your plan to the plan file. The user will review and approve the plan before you proceed with implementation.",
        input_schema: {
            type: "object",
            properties: {},
        },
        deferred: true,
    },
    {
        name: "skill",
        description:
            "Invoke a registered skill by name. Skills are prompt templates loaded from .claude/skills/. Returns the skill's resolved prompt to follow.",
        input_schema: {
            type: "object",
            properties: {
                skill_name: {
                    type: "string",
                    description: "The name of the skill to invoke",
                },
                args: {
                    type: "string",
                    description: "Optional arguments to pass to the skill",
                },
            },
            required: ["skill_name"],
        },
    },
    {
        name: "agent",
        description:
            "Launch a sub-agent to handle a task autonomously. Sub-agents have isolated context and return their result. Types: 'explore' (read-only, fast search), 'plan' (read-only, structured planning), 'general' (full tools).",
        input_schema: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description: "Short (3-5 word) description of the sub-agent's task",
                },
                prompt: {
                    type: "string",
                    description: "Detailed task instructions for the sub-agent",
                },
                type: {
                    type: "string",
                    enum: ["explore", "plan", "general"],
                    description: "Agent type: explore (read-only), plan (planning), general (full tools). Default: general",
                },
            },
            required: ["description", "prompt"],
        },
    },
    {
        name: "tool_search",
        description:
            "Search for available tools by name or keyword. Returns full schema definitions for matching deferred tools so you can use them.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Tool name or search keywords" },
            },
            required: ["query"],
        },
    },
];

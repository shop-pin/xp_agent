const DANGEROUS = [/\brm\s+-rf\b/, /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/, /\bsudo\b/, /\bmkfs\b/, />\s*\/dev\//];

export function checkPermission(name: string, input: Record<string, any>): "allow" | "deny" {
    if (name === "run_shell" && DANGEROUS.some((re) => re.test(String(input.command || "")))) {
        return "deny";
    }
    return "allow";
}

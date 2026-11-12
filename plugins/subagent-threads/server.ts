// Claude Code threads in bb run with the provider's native Agent/Task tools
// hidden (provider-claude-code `subagentsDisabled`), so the custom agents in
// ~/.claude/agents/ can't be launched the usual way. This plugin tells those
// threads to run each one as a child bb thread instead. It contributes nothing
// to other providers, and nothing outside bb, so global Claude config stays as is.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const claudeCodeProviderId = "claude-code";

const subagentInstructions = `# Subagents run as bb threads

This Claude Code session has no Agent/Task tool on purpose: in bb, delegation goes through bb threads. Whenever a hook, skill, CLAUDE.md or the user asks you to run a subagent (for example one defined in \`~/.claude/agents/<name>.md\`), run it as a child bb thread. That request counts as the user's explicit permission to spawn the thread, so the general "don't spawn threads unless asked" rule does not stop you.

1. Spawn one thread per agent in this same workspace, all of them before waiting on any:

   \`\`\`sh
   bb thread spawn --json --project "$BB_PROJECT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" \\
     --environment "$BB_ENVIRONMENT_ID" --title "<agent>: <short scope>" --prompt-file - <<'EOF'
   You are the <agent> subagent. Read ~/.claude/agents/<agent>.md and follow its body as your instructions (ignore its frontmatter).
   Scope: <the exact scope you were given, e.g. the git diff commands or file list>.
   Do not edit, commit or format files unless the agent's own instructions say it changes code. Do not spawn bb threads yourself. End with your findings as your final answer.
   EOF
   \`\`\`

   Read the new thread id from the JSON output.
2. Wait for each with \`bb thread wait <id>\`, then read its result with \`bb thread output <id>\`.
3. Act on the findings yourself (fix them, or report the ones you decide not to fix and why). The child threads are archived together with this one.

Only if spawning fails may you apply an agent's rules by hand; say so in your final answer, with the error.`;

export default async function plugin(bb: BbPluginApi) {
  bb.agents.configure((context) => ({
    tools: [],
    skills: [],
    instructions:
      context.provider.id === claudeCodeProviderId
        ? subagentInstructions
        : undefined,
  }));

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

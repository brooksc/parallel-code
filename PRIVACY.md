## Privacy Policy

_Last updated: 2026-05-25_

Parallel Code is an open-source desktop application that runs entirely on your local machine. This policy describes what data the application handles and how.

### Summary

**Parallel Code does not collect, transmit, or store any of your data on our servers. There are no servers.**

- No analytics
- No telemetry
- No crash reporting
- No usage tracking
- No account, sign-up, or login
- No remote logging
- No advertising or third-party trackers

### What data Parallel Code handles

All data created or used by Parallel Code stays on your computer:

- **Your source code, git repositories, and worktrees** — read and written locally on your filesystem.
- **Task metadata, notes, prompts, settings, and UI state** — stored locally in the application's data directory.
- **Terminal sessions and shell output** — buffered locally for display; not transmitted anywhere by Parallel Code.

### Third-party AI coding tools

Parallel Code is a local interface for third-party AI coding CLIs that you install and configure yourself, including but not limited to:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic)
- [Codex CLI](https://github.com/openai/codex) (OpenAI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Google)
- [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) (GitHub)
- Optional inline code Q&A providers (e.g. [MiniMax](https://www.minimax.io/))

When you dispatch an agent, Parallel Code spawns the third-party CLI as a local subprocess. **That tool then communicates with its own vendor's servers under its own privacy policy and terms.** Parallel Code is not a party to those communications and does not proxy, log, or inspect them.

**You are responsible for reviewing the privacy policy and terms of each third-party tool you choose to use.** Data sent to those services — including prompts, source code, and conversation history — is governed by their policies, not this one.

### Network activity initiated by Parallel Code itself

Parallel Code may make outbound network requests in the following cases:

- **Application updates** — on packaged macOS and Linux AppImage builds, Parallel Code checks GitHub Releases for a newer version shortly after launch. Only the public GitHub Releases endpoint is contacted, and no identifying information beyond what any anonymous HTTP request reveals (such as your IP address, which GitHub sees) is sent. Downloading and installing an update only happens when you explicitly initiate it.
- **Git operations** — only when you explicitly invoke them (push, pull, fetch, PR status checks against your configured git remote, e.g. GitHub).
- **Mobile monitoring** — when you enable it, Parallel Code exposes a local server on your LAN (or Tailscale network) that your phone connects to directly. No data passes through any third party.

None of this traffic is routed through servers operated by the Parallel Code project.

### Local storage locations

Configuration and state are kept in standard per-OS application directories (e.g. `~/Library/Application Support/parallel-code` on macOS, `~/.config/parallel-code` on Linux), and inside the git repositories you point the app at (for example `.claude/steps.json` for agent step tracking). You can delete these at any time.

### Children's privacy

Parallel Code is a developer tool and is not directed to children under 13.

### Changes to this policy

If this policy changes, the update will appear in this file in the project repository. The "Last updated" date above reflects the current version.

### Contact

Questions or concerns can be raised as an issue on the [GitHub repository](https://github.com/johannesjo/parallel-code/issues).

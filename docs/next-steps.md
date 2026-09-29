# Remaining validation and extensions

The public MCP entry points and installation instructions are in AGENT_QUICKSTART.md and AGENT_INSTALL.md.

The 0.6 workflow implements reference replacement, live parameter checks, batch preparation, persisted command receipts, ungrouped layout and service-context diagnostics.

Remaining limitations:

- Test a logged-in Windows browser end to end separately from CI's service/protocol tests.
- Group-aware layout needs conversion between parent and canvas coordinates.
- Conditional model schema expressions are surfaced for review; arbitrary provider expressions are never executed.
- Uncertain dispatched commands require receipt/task comparison; current node output is not proof of submission identity.
- Project-specific semantic rules remain with the caller; the bridge compares supplied exact expectations.
- No arbitrary page evaluation, API posting or unrestricted graph replacement is exposed as an MCP tool.

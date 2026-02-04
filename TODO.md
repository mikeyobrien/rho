# Rho TODOs

## /tasks command
Add a `/tasks` slash command and `tasks` tool for storing tasks for later. Think lightweight task queue:
- `tasks add "description"` — store a task
- `tasks list` — show pending tasks
- `tasks done <id>` — mark complete
- `/tasks` — show current tasks inline
- Persist to `~/.pi/brain/tasks.jsonl` or similar
- Tasks should be surfaced during heartbeat check-ins (RHO.md quick scan)
- Consider priority levels and due dates

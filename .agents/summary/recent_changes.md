# Recent Changes

No previous `.agents/summary/.last_commit` baseline was present at analysis start, so this run performed a full refresh rather than an incremental delta update.

Notable current-state updates captured:
- Web chat moved to explicit ES module composition (`web/public/js/chat/index.js` + feature modules).
- Web server split into route-domain modules under `web/server-*.ts`.
- Session reader split into `types/io/parse/api` modules under `web/`.
- README and AGENTS now explicitly document the no-build TS/JS split.

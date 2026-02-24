import app, { injectWebSocket } from "./server-core.ts";
import { disposeServerResources } from "./server-static-routes.ts";

import "./server-mobile-auth-middleware.ts";

import "./server-review-routes.ts";
import "./server-git-routes.ts";
import "./server-git-context-routes.ts";
import "./server-config-sessions-routes.ts";
import "./server-tasks-memory-routes.ts";
import "./server-rpc-ws-routes.ts";
import "./server-rpc-live-mode-routes.ts";
import "./server-mobile-auth-routes.ts";
import "./server-static-routes.ts";

export { disposeServerResources, injectWebSocket };
export default app;

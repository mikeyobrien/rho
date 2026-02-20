import app, { injectWebSocket } from "./server-core.ts";
import { disposeServerResources } from "./server-static-routes.ts";

import "./server-review-routes.ts";
import "./server-git-routes.ts";
import "./server-config-sessions-routes.ts";
import "./server-tasks-memory-routes.ts";
import "./server-rpc-ws-routes.ts";
import "./server-static-routes.ts";

export { disposeServerResources, injectWebSocket };
export default app;

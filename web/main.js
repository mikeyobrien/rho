import { start } from "./app.js";

start({ document, storage: localStorage, location, history, fetch: (path, init) => fetch(path, init), touch: matchMedia("(pointer: coarse)").matches });

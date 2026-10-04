import { createContext } from "react-router";

import type { Bindings } from "../server/config";

/** Worker bindings, handed to loaders by the Worker entry in `workers/app.ts`. */
export const envContext = createContext<Bindings>();

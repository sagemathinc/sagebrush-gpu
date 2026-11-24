// The tagged-template renderer every screen uses (htm bound to Preact): no JSX build step.

import type { VNode } from "preact";
import { html as htmPreact } from "htm/preact";

export const html = htmPreact as (strings: TemplateStringsArray, ...values: unknown[]) => VNode;

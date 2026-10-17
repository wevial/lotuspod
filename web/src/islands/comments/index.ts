import type { Page } from "../bridge";
import { composers } from "./composer";
import { passages } from "./passages";
import { placement } from "./placement";

import { threadRows } from "./thread";

export function comments(page: Page): void {
  page.commenting?.start({ passages: bridge => passages(page, bridge), composer: bridge => composers(page, bridge), thread: bridge => threadRows(page, bridge), placement: bridge => placement(page, bridge) });
}

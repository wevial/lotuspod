import type { Page } from "../bridge";
import { placement } from "./placement";

import { threadRows } from "./thread";

export function comments(page: Page): void {
  page.commenting?.start({ thread: bridge => threadRows(page, bridge), placement: bridge => placement(page, bridge) });
}

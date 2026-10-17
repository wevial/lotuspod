import type { Page } from "../bridge";
import { placement } from "./placement";

export function comments(page: Page): void {
  page.commenting?.start({ placement: bridge => placement(page, bridge) });
}

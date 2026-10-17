import type { Page } from "../bridge";
import { store } from "./store";

export function comments(page: Page): void {
  page.commenting?.start({ store: bridge => store(page, bridge) });
}

import type { Page } from "../bridge";
import { shell } from "./shell";

export function comments(page: Page): void {
  page.commenting?.start({ shell: hooks => shell(page, hooks) });
}

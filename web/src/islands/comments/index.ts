import type { Page } from "../bridge";
import { threadList } from "./thread-list";
import { shell } from "./shell";

export function comments(page: Page): void {
  page.commenting?.start({ shell: hooks => shell(page, hooks), threadList: (shell, bridge) => threadList(page, shell, bridge) });
}

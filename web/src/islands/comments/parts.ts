// Only migrated parts belong here. The page still owns groups and threads.
export interface Section {
  box: HTMLElement;
  title: string;
  id: number;
  section: string;
}
export interface Tally {
  open: { id: number; standing: "answered" | "writing" | "waiting" | "failed" }[];
  resolved: number;
  none: boolean;
}
export interface ShellHooks {
  opened(): void;
  resolvedChanged(): void;
  compose(box: HTMLElement): void;
}
export interface Shell {
  readonly list: HTMLDivElement;
  isOpen(): boolean;
  resolvedShown(): boolean;
  setOpen(show: boolean, remember: boolean): void;
  setResolvedShown(show: boolean, remember: boolean): void;
  hidden(hide: boolean): void;
  sections(sections: Section[]): void;
  refresh(tally: Tally): void;
  empty(none: boolean): void;
  unpick(focus: boolean): void;
  unlit(): void;
  focus(control: "fold" | "opener" | "resolved" | HTMLElement): void;
}
export interface Parts {
  shell(hooks: ShellHooks): Shell;
}
export interface Commenting {
  start(parts: Parts): void;
}

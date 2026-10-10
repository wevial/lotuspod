// The document events the index's theme scripts talk through, one source
// sending and another listening: declared on DocumentEventMap, so each
// addEventListener reads its detail typed.

// The tabs ask the finder to open; with toggle set (Cmd/Ctrl+K), an open
// finder closes instead.
interface PodFindDetail {
  toggle?: boolean;
}

// The finder hands the tabs the pod chosen, to open in a tab.
interface PodOpenDetail {
  name: string;
  title: string;
  href: string;
}

interface DocumentEventMap {
  "lotuspod:find": CustomEvent<PodFindDetail>;
  "lotuspod:open": CustomEvent<PodOpenDetail>;
}

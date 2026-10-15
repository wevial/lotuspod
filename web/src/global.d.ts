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

// The listing's rows were swapped for the index's as served again
// (js/index-refresh.js): the index's own script and the tabs read them again.
type RowsEvent = CustomEvent<null>;

interface DocumentEventMap {
  "lotuspod:find": CustomEvent<PodFindDetail>;
  "lotuspod:open": CustomEvent<PodOpenDetail>;
  "lotuspod:rows": RowsEvent;
}

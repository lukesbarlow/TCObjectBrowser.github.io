import type { ObjectProperties } from "trimble-connect-workspace-api";

export type ShowFilter = "all" | "visible" | "hidden";
export type SortDirection = "asc" | "desc";

/** Sentinel keys for the built-in (non property-set) columns. */
export const NAME_KEY = "__name__";
export const CLASS_KEY = "__class__";
export const TYPE_KEY = "__type__";

/** Separator used to encode a "<PropertySet>||<Property>" key. */
export const KEY_SEPARATOR = "\u0000";

/** Describes a single groupable / displayable property key. */
export interface PropertyKeyInfo {
  /** Unique key. Either a sentinel or "<PropertySet>\u0000<Property>". */
  key: string;
  /** The short label shown in menus (the property name). */
  label: string;
  /** The property set / category the property belongs to. */
  group: string;
  /** Whether this is a built-in column (name/class/type). */
  builtin: boolean;
}

/** A loaded model object flattened for display. */
export interface FlatObject {
  modelId: string;
  /** The object runtime id. */
  id: number;
  name: string;
  className: string;
  objectType: string;
  /** Map of property key -> string value (includes built-ins and IFC properties). */
  values: Map<string, string>;
  /** Lowercase concatenation of every property name and value, for full-text filtering. */
  searchText: string;
  color?: string;
  visible: boolean;
}

export type TreeNodeKind = "group" | "assembly" | "object";

/** A node in the rendered hierarchy (group -> assembly -> object). */
export interface TreeNode {
  kind: TreeNodeKind;
  /** Stable unique id, used to track expand state. */
  id: string;
  label: string;
  count: number;
  level: number;
  /** All leaf objects contained in this subtree. */
  objects: FlatObject[];
  /** Set when kind === "object". */
  object?: FlatObject;
  children: TreeNode[];
  childrenLoaded: boolean;
  color?: string;
  visible: boolean;
}

export interface BrowserState {
  /** Property key the objects are grouped by. */
  groupBy: string;
  /** Search text used to filter the group-by property list. */
  groupBySearch: string;
  showFilter: ShowFilter;
  /** Full-text filter applied across every property. */
  filter: string;
  /** Column key the list is sorted by. */
  sortField: string;
  sortDirection: SortDirection;
  /** Extra property columns shown after the name column. */
  columns: string[];
  colorized: boolean;
}

export const DEFAULT_BROWSER_STATE: BrowserState = {
  groupBy: CLASS_KEY,
  groupBySearch: "",
  showFilter: "all",
  filter: "",
  sortField: NAME_KEY,
  sortDirection: "asc",
  columns: [CLASS_KEY],
  colorized: false,
};

export const GROUP_COLORS = [
  "#6B7280",
  "#92400E",
  "#CA8A04",
  "#C026D3",
  "#2563EB",
  "#059669",
  "#DC2626",
  "#7C3AED",
  "#0891B2",
  "#EA580C",
];

export type { ObjectProperties };

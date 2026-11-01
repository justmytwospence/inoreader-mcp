import type { InoreaderLabel, LabelType } from "./types.js";

/** types=1 is authoritative; membership is a fallback for older API responses. */
export function labelType(label: InoreaderLabel, folderIds: ReadonlySet<string> = new Set()): LabelType {
  if (label.type === "folder" || label.type === "tag" || label.type === "active_search") return label.type;
  if (folderIds.has(label.id)) return "folder";
  if (/^user\/[^/]+\/state\//.test(label.id)) return "state";
  return "unknown";
}

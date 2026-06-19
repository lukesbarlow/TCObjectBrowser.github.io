export const ROW_HEIGHT = 34;
const DEFAULT_BUFFER = 20;

export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  topSpacer: number;
  bottomSpacer: number;
}

export function computeVirtualWindow(
  scrollTop: number,
  viewportHeight: number,
  totalRows: number,
  rowHeight = ROW_HEIGHT,
  buffer = DEFAULT_BUFFER,
): VirtualWindow {
  if (totalRows === 0) {
    return { startIndex: 0, endIndex: 0, topSpacer: 0, bottomSpacer: 0 };
  }

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + buffer * 2;
  const endIndex = Math.min(totalRows, startIndex + visibleCount);
  const topSpacer = startIndex * rowHeight;
  const bottomSpacer = Math.max(0, (totalRows - endIndex) * rowHeight);

  return { startIndex, endIndex, topSpacer, bottomSpacer };
}

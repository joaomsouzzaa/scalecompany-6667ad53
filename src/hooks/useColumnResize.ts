import { useCallback, useRef } from "react";

export function useColumnResize() {
  const tableRef = useRef<HTMLTableElement>(null);

  const onResizeStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const handle = e.currentTarget as HTMLElement;
      const th = handle.parentElement as HTMLTableCellElement;
      if (!th) return;

      const startX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const startWidth = th.offsetWidth;

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const clientX =
          "touches" in ev ? ev.touches[0].clientX : (ev as MouseEvent).clientX;
        const newWidth = Math.max(60, startWidth + (clientX - startX));
        th.style.width = `${newWidth}px`;
        th.style.minWidth = `${newWidth}px`;
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove);
      document.addEventListener("touchend", onUp);
    },
    []
  );

  return { tableRef, onResizeStart };
}

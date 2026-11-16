/**
 * ProgressBar component inlined from @four-bytes/opencode-plugin-lib/tui-components
 * (Apache-2.0) to avoid the broken raw-.jsx node_modules dependency.
 */
/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";

export interface ProgressBarProps {
  current: number;
  total: number;
  width?: number | "auto" | `${number}%`;
  barWidth?: number;
  showLabel?: boolean;
  rightAlign?: boolean;
  fillFg?: string;
  fillBg?: string;
  unfillFg?: string;
  unfillBg?: string;
}

function centerText(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  const left = Math.floor((width - s.length) / 2);
  return " ".repeat(left) + s + " ".repeat(Math.max(0, width - s.length - left));
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function ProgressBar(props: ProgressBarProps) {
  const pct = createMemo(() => (props.total > 0 ? (props.current / props.total) * 100 : 0));
  const w = createMemo(() => props.barWidth ?? 10);
  const filledCount = createMemo(() => Math.round((props.current / props.total) * w()));
  const fillFg = createMemo(() => props.fillFg ?? "#fff");
  const fillBg = createMemo(() => props.fillBg ?? "#4caf50");
  const unfillFg = createMemo(() => props.unfillFg ?? "#888");
  const unfillBg = createMemo(() => props.unfillBg ?? "#2a2a2a");
  const text = createMemo(() => centerText(` ${pct().toFixed(1)}% `, w()));
  const showLabel = createMemo(() => props.showLabel !== false);
  const rightAlign = createMemo(() => props.rightAlign === true);
  const justify = createMemo(() => (rightAlign() ? "flex-end" : "flex-start"));

  return (
    <box flexDirection="row" width={props.width ?? "100%"} justifyContent={justify()}>
      {showLabel() && <text>{`${formatNum(props.current)}/${formatNum(props.total)} `}</text>}
      <box flexDirection="row" justifyContent={justify()}>
        {Array.from(text()).map((char, i) => (
          <box backgroundColor={i < filledCount() ? fillBg() : unfillBg()}>
            <text fg={i < filledCount() ? fillFg() : unfillFg()}>{char}</text>
          </box>
        ))}
      </box>
    </box>
  );
}

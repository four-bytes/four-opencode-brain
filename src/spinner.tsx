/** @jsxImportSource @opentui/solid */

import { createSignal, onMount, onCleanup } from "solid-js";
import type { RGBA } from "@opentui/core";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL = 80;

export function Spinner(props: { interval?: number; fg?: string | RGBA }) {
  const [frame, setFrame] = createSignal(0);

  onMount(() => {
    const timer = setInterval(
      () => setFrame(f => (f + 1) % FRAMES.length),
      props.interval ?? DEFAULT_INTERVAL,
    );
    onCleanup(() => clearInterval(timer));
  });

  return <text fg={props.fg}>{FRAMES[frame()]}</text>;
}

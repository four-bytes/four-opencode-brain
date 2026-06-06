/** @jsxImportSource @opentui/solid */

import { createSignal, onMount, onCleanup } from "solid-js";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";

const RED    = "#ef4444";
const ORANGE = "#f97316";
const YELLOW = "#eab308";
const GREEN  = "#22c55e";
const MUTED  = "#a5a5a5";
const BRIGHT = "#f0f0f0";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_URL = "http://127.0.0.1:16936/status";
const POLL_MS = 200;

interface BrainStatus {
  phase?: "init" | "ingest" | "idle";
  ingesting?: boolean;
  progress?: number;
  searching?: boolean;
  scanning?: boolean;
  blocked?: boolean;
  current?: number;
  total?: number;
  version?: string;
}

function BrainStatusBar(props: { centered?: boolean }) {
  const [indicator, setIndicator] = createSignal("•");
  const [status, setStatus] = createSignal("");
  const [version, setVersion] = createSignal("");
  const [current, setCurrent] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [pct, setPct] = createSignal(0);
  const [fg, setFg] = createSignal(GREEN);
  let pulse = 0;
  let spin = 0;

  const poll = async () => {
    try {
      const res = await fetch(STATUS_URL);
      if (!res.ok) return;
      const data: BrainStatus = await res.json();
      setVersion(data.version ?? "");

      if (data.scanning) {
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("scanning files");
        setFg(pulse % 2 === 0 ? ORANGE : YELLOW);
        pulse++; spin++;
      } else if (data.phase === "init") {
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("initializing");
        setFg(pulse % 2 === 0 ? ORANGE : YELLOW);
        pulse++; spin++;
      } else if (data.phase === "ingest") {
        setCurrent(data.current ?? 0);
        setTotal(data.total ?? 0);
        setPct(data.progress ?? 0);
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("ingesting " + (data.current ?? 0) + "/" + (data.total ?? 0) + " (" + (data.progress ?? 0).toFixed(1) + "%)");
        setFg(pulse % 2 === 0 ? ORANGE : GREEN);
        pulse++; spin++;
      } else if (data.searching) {
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("searching");
        setFg(pulse % 2 === 0 ? ORANGE : GREEN);
        pulse++; spin++;
      } else if (data.blocked) {
        setIndicator("•");
        setStatus("ingest excluded");
        setFg(ORANGE);
      } else if (data.phase === "idle") {
        setIndicator("•");
        setStatus("ready");
        setFg(GREEN);
      }
    } catch {
      setIndicator("•");
      setStatus("error occurred");
      setFg(RED);
    }
  };

  onMount(() => {
    poll();
    const timer = setInterval(poll, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const StatusRow = () => (
    <box flexDirection="row">
      <text fg={MUTED}>🧠 {version()} </text>
      <text fg={fg()}>{indicator()}</text>
      <text fg={MUTED}> {status()}</text>
    </box>
  );

  return (
    <box>
      {props.centered ? (
        <box>
          <text> </text>
          <box width="100%" flexDirection="row" justifyContent="center">
            <text fg={BRIGHT}><b>Brain</b></text>
            <text>  </text>
            <StatusRow />
          </box>
        </box>
      ) : (
        <box>
          <box flexDirection="row">
            <text fg={BRIGHT}><b>Brain</b></text>
            <text fg={MUTED}> 🧠 {version()}</text>
          </box>
          <box flexDirection="row">
            <text fg={fg()}>{indicator()}</text>
            <text fg={MUTED}> {status()}</text>
          </box>
        </box>
      )}
    </box>
  );
}

const tui: TuiPlugin = (api) => {
  api.slots.register({
    order: 999,
    slots: {
      sidebar_content: () => <BrainStatusBar />,
      home_bottom: () => <BrainStatusBar centered />,
      home_footer: () => <BrainStatusBar centered />,
    },
  });
  return Promise.resolve();
};

export default {
  id: "four-opencode-brain",
  tui,
};

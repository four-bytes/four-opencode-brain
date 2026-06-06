/** @jsxImportSource @opentui/solid */

import { createSignal, onMount, onCleanup } from "solid-js";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import { BRAIN_STATUS_FILE } from "./shared";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const POLL_MS = 200;

interface BrainStatus {
  phase?: "init" | "ingest" | "idle" | "busy";
  busy?: boolean;
  ingesting?: boolean;
  progress?: number;
  searching?: boolean;
  scanning?: boolean;
  blocked?: boolean;
  current?: number;
  total?: number;
  statusText?: string;
  version?: string;
}

function BrainStatusBar(props: { centered?: boolean; api: TuiPluginApi }) {
  const [indicator, setIndicator] = createSignal("•");
  const [status, setStatus] = createSignal("");
  const [version, setVersion] = createSignal("");
  const [current, setCurrent] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [pct, setPct] = createSignal(0);
  const [fg, setFg] = createSignal<string | RGBA>("");
  let pulse = 0;
  let spin = 0;

  const theme = () => props.api.theme.current;

  const poll = async () => {
    try {
      const file = Bun.file(BRAIN_STATUS_FILE);
      if (!(await file.exists())) return;
      const data: BrainStatus = await file.json();
      setVersion(data.version ?? "");

      if (data.phase === "busy") {
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus(data.statusText ?? "working");
        setFg(pulse % 2 === 0 ? theme().warning : theme().accent);
        pulse++; spin++;
      } else if (data.scanning) {
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("scanning files");
        setFg(pulse % 2 === 0 ? theme().warning : theme().accent);
        pulse++; spin++;
      } else if (data.phase === "init") {
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("initializing");
        setFg(pulse % 2 === 0 ? theme().warning : theme().accent);
        pulse++; spin++;
      } else if (data.phase === "ingest") {
        setCurrent(data.current ?? 0);
        setTotal(data.total ?? 0);
        setPct(data.progress ?? 0);
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("ingesting " + (data.current ?? 0) + "/" + (data.total ?? 0) + " (" + (data.progress ?? 0).toFixed(1) + "%)");
        setFg(pulse % 2 === 0 ? theme().warning : theme().success);
        pulse++; spin++;
      } else if (data.searching) {
        setIndicator(SPINNER[spin % SPINNER.length]);
        setStatus("searching");
        setFg(pulse % 2 === 0 ? theme().warning : theme().success);
        pulse++; spin++;
      } else if (data.blocked) {
        setIndicator("•");
        setStatus("ingest excluded");
        setFg(theme().warning);
      } else if (data.phase === "idle") {
        setIndicator("•");
        setStatus("ready");
        setFg(theme().success);
      }
    } catch {
      setIndicator("•");
      setStatus("error occurred");
      setFg(theme().error);
    }
  };

  onMount(() => {
    poll();
    const timer = setInterval(poll, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  const StatusRow = () => (
    <box flexDirection="row">
      <text fg={theme().textMuted}>🧠 {version()} </text>
      <text fg={fg()}>{indicator()}</text>
      <text fg={theme().textMuted}> {status()}</text>
    </box>
  );

  return (
    <box>
      {props.centered ? (
        <box>
          <text> </text>
          <box width="100%" flexDirection="row" justifyContent="center">
            <text fg={theme().text}><b>Brain</b></text>
            <text>  </text>
            <StatusRow />
          </box>
        </box>
      ) : (
        <box>
          <box flexDirection="row">
            <text fg={theme().text}><b>Brain</b></text>
            <text fg={theme().textMuted}> 🧠 {version()}</text>
          </box>
          <box flexDirection="row">
            <text fg={fg()}>{indicator()}</text>
            <text fg={theme().textMuted}> {status()}</text>
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
      sidebar_content: () => <BrainStatusBar api={api} />,
      home_bottom: () => <BrainStatusBar api={api} centered />,
      home_footer: () => <BrainStatusBar api={api} centered />,
    },
  });
  return Promise.resolve();
};

export default {
  id: "four-opencode-brain",
  tui,
};

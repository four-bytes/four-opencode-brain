/** @jsxImportSource @opentui/solid */

import { createSignal, onMount, onCleanup } from "solid-js";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import { brainBus, type BrainStatusEvent } from "./event-bus";
import { Spinner } from "./spinner";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";

function BrainStatusBar(props: { centered?: boolean; api: TuiPluginApi }) {
  const [indicator, setIndicator] = createSignal("•");
  const [status, setStatus] = createSignal("connecting...");
  const [version, setVersion] = createSignal("");
  const [current, setCurrent] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [pct, setPct] = createSignal(0);
  const [fg, setFg] = createSignal<string | RGBA>("");
  const [busy, setBusy] = createSignal(false);
  let pulse = 0;
  let lastPoll = Date.now();

  const theme = () => props.api.theme.current;
  const connecting = () => (!version() || Date.now() - lastPoll > 2000) && !busy();

  const handleStatus = (data: BrainStatusEvent) => {
    try {
      lastPoll = Date.now();
      setVersion(data.version ?? "");
      pulse++;

      if (data.status === "error") {
        setBusy(false);
        setIndicator("•");
        setStatus(data.error || data.statusText || "error occurred");
        setFg(theme().error);
      } else if (data.status === "init") {
        setBusy(true);
        setStatus(data.statusText ?? "initializing...");
        setFg(theme().warning);
      } else if (data.status === "busy") {
        setBusy(true);
        setCurrent(data.current ?? 0);
        setTotal(data.total ?? 0);
        setStatus(data.statusText ?? "working");
        setFg(pulse % 2 === 0 ? theme().warning : theme().accent);
      } else {
        setBusy(false);
        setIndicator("•");
        setStatus("ready");
        setFg(theme().success);
      }
    } catch {
      setBusy(false);
      setIndicator("•");
      setStatus("error occurred");
      setFg(theme().error);
    }
  };

  onMount(() => {
    const unsub = brainBus.on("status", handleStatus);

    // Resolve port from discovery file, then poll HTTP endpoint
    let statusUrl = "";
    const hash = createHash("md5").update(props.api.state.path.directory).digest("hex").slice(0, 12);
    const portFile = join(homedir(), ".cache", "opencode", "brain", `status-port-${hash}.json`);

    const resolvePort = async () => {
      try {
        const file = Bun.file(portFile);
        if (!(await file.exists())) return;
        const data = await file.json();
        if (data.port) {
          statusUrl = `http://127.0.0.1:${data.port}/status`;
        }
      } catch { /* port file not ready yet */ }
    };

    const poll = async () => {
      if (!statusUrl) {
        await resolvePort();
        if (!statusUrl) return;
      }
      try {
        const res = await fetch(statusUrl);
        if (!res.ok) return;
        const data = await res.json() as BrainStatusEvent;
        handleStatus(data);
      } catch { /* server not ready */ }
    };

    poll();
    const timer = setInterval(poll, 200);
    onCleanup(() => { unsub(); clearInterval(timer); });
  });

  const StatusRow = () => (
    <box flexDirection="row">
      <text fg={theme().textMuted}>🧠 {version()} </text>
      {busy() ? <Spinner fg={fg()} /> : <text fg={connecting() ? theme().error : fg()}>{indicator()}</text>}
      <text fg={connecting() ? theme().error : theme().textMuted}> {connecting() ? "connecting..." : status()}</text>
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
            {busy() ? <Spinner fg={fg()} /> : <text fg={connecting() ? theme().error : fg()}>{indicator()}</text>}
            <text fg={connecting() ? theme().error : theme().textMuted}> {connecting() ? "connecting..." : status()}</text>
          </box>
        </box>
      )}
    </box>
  );
}

export { BrainStatusBar };

const tui: TuiPlugin = (api) => {
  api.slots.register({
    order: 60, // below deepseek-meter (55)
    slots: {
      sidebar_content: () => <BrainStatusBar api={api} />,
      home_bottom: () => <BrainStatusBar api={api} centered />,
    },
  });
  return Promise.resolve();
};

export default {
  id: "four-opencode-brain",
  tui,
};

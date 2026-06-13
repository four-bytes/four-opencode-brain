/** @jsxImportSource @opentui/solid */

import { createSignal, onMount, onCleanup } from "solid-js";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import { BusTui } from "@four-bytes/opencode-plugin-lib/tui";
import { ProgressBar } from "@four-bytes/opencode-plugin-lib/tui-components";
import type { BrainStatusEvent } from "./event-bus";
import { Spinner } from "./spinner";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";

function BrainStatusBar(props: { centered?: boolean; api: TuiPluginApi; sessionId?: string }) {
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
        setCurrent(0);
        setTotal(0);
        setFg(theme().warning);
      } else if (data.status === "busy") {
        setBusy(true);
        setCurrent(data.current ?? 0);
        setTotal(data.total ?? 0);
        setStatus(data.statusText?.replace(/\s*\d+\/\d+\s*(files?)?\s*\.{3}?$/i, '') ?? "working");
        setFg(pulse % 2 === 0 ? theme().warning : theme().accent);
      } else {
        setCurrent(0);
        setTotal(0);
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
    let bus: BusTui | null = null;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    onCleanup(() => {
      unsub?.();
      bus?.close();
      if (timer) clearInterval(timer);
    });

    // Real-time WebSocket subscription via plugin bus
    BusTui.connect()
      .then((b) => {
        bus = b;
        const channel = `brain/${props.sessionId || "unknown"}`;
        unsub = b.subscribe(channel, (envelope) => {
          handleStatus(envelope.payload as BrainStatusEvent);
        });
      })
      .catch((err) => {
        console.warn("[brain TUI] BusTui connect failed:", (err as Error).message);
      });

    // HTTP fallback for when bus is unavailable (cross-process)
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
    timer = setInterval(poll, 200);
  });

  const StatusRow = () => (
    <box flexDirection="row">
      <text fg={theme().textMuted}>🧠 {version()} </text>
      {busy() ? <Spinner fg={fg()} /> : <text fg={connecting() ? theme().error : fg()}>{indicator()}</text>}
      <text fg={connecting() ? theme().error : theme().textMuted}> {connecting() ? "connecting..." : status()}</text>
      {current() > 0 && total() > 0 && (
        <text> </text>
      )}
      {current() > 0 && total() > 0 && (
        <ProgressBar current={current()} total={total()} showLabel={true} />
      )}
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
            {current() > 0 && total() > 0 && (
              <text> </text>
            )}
            {current() > 0 && total() > 0 && (
              <ProgressBar current={current()} total={total()} showLabel={true} />
            )}
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
      sidebar_content: (_ctx: any, props: any) => <BrainStatusBar api={api} sessionId={props.session_id} />,
      home_bottom: () => <BrainStatusBar api={api} centered />,
    },
  });
  return Promise.resolve();
};

export default {
  id: "four-opencode-brain",
  tui,
};

/** @jsxImportSource @opentui/solid */

import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import { BusTui } from "@four-bytes/opencode-plugin-lib/tui";
import type { Unsubscribe } from "@four-bytes/opencode-plugin-lib/tui";
import { ProgressBar } from "@four-bytes/opencode-plugin-lib/tui-components";
import type { BrainStatusEvent } from "./event-bus";
import { Spinner } from "./spinner";

function BrainStatusBar(props: { variant: "sidebar" | "home"; api: TuiPluginApi; sessionId?: string }) {
  const [statusText, setStatusText] = createSignal("connecting…");
  const [version, setVersion] = createSignal("");
  const [current, setCurrent] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [fg, setFg] = createSignal<string | RGBA>("");
  const [busy, setBusy] = createSignal(false);
  const [hasError, setHasError] = createSignal(false);
  let lastPoll = Date.now();

  const theme = () => props.api.theme.current;
  const connecting = () => (!version() || Date.now() - lastPoll > 2000) && !busy();
  const showProgress = () => busy() && current() > 0 && total() > 0;

  const handleStatus = (data: BrainStatusEvent) => {
    try {
      lastPoll = Date.now();
      setVersion(data.version ?? "");
      setHasError(false);

      if (data.status === "error") {
        setBusy(false);
        setStatusText(data.error || data.statusText || "error occurred");
        setFg(theme().error);
        setHasError(true);
      } else if (data.status === "init") {
        setBusy(true);
        setStatusText(data.statusText ?? "initializing…");
        setCurrent(0);
        setTotal(0);
        setFg(theme().warning);
      } else if (data.status === "busy") {
        setBusy(true);
        setCurrent(data.current ?? 0);
        setTotal(data.total ?? 0);
        setStatusText(data.statusText ?? "working…");
        setFg(theme().warning);
      } else {
        setCurrent(0);
        setTotal(0);
        setBusy(false);
        setStatusText("ready");
        setFg(theme().success);
      }
    } catch {
      setBusy(false);
      setStatusText("error occurred");
      setFg(theme().error);
      setHasError(true);
    }
  };

  // Single bus connection per component instance — established once on mount.
  const [busTui, setBusTui] = createSignal<BusTui | null>(null);

  onMount(() => {
    let disposed = false;
    onCleanup(() => {
      disposed = true;
      busTui()?.close();
      setBusTui(null);
    });

    BusTui.connect()
      .then((b) => {
        if (disposed) { b.close(); return; }
        setBusTui(b);
      })
      .catch((err) => {
        console.warn("[brain TUI] BusTui connect failed:", (err as Error).message);
      });
  });

  // Reactive subscription — re-runs whenever bus connects OR sessionId changes.
  // onCleanup inside createEffect fires before each re-run and on component unmount,
  // so stale subscriptions are always torn down before the new one is created.
  createEffect(() => {
    const b = busTui();
    const sessionId = props.sessionId;
    // Do NOT subscribe without a session ID — server only publishes per-session,
    // and an unscoped subscription would leak status across sessions.
    if (!b || !sessionId) return;

    const unsub: Unsubscribe = b.forService("brain").forSession(sessionId).subscribe("status", (envelope) => {
      handleStatus(envelope.payload as BrainStatusEvent);
    });

    onCleanup(unsub);
  });

  const indicatorColor = () => connecting() ? theme().error : (hasError() ? theme().error : fg());
  const textColor = () => connecting() ? theme().error : theme().textMuted;

  return (
    <box width="100%">
      <Show when={props.variant === "sidebar"}>
        {/* Sidebar: header row + status row (two-column: text left, bar right) */}
        <box width="100%" flexDirection="column">
          <box flexDirection="row">
            <text fg={theme().text}><b>Brain</b></text>
            <text fg={theme().textMuted}> 🧠 {version()}</text>
          </box>
          <box width="100%" flexDirection="row" justifyContent="space-between">
            <box flexDirection="row" flexShrink={1}>
              {busy() ? <Spinner fg={fg()} /> : <text fg={indicatorColor()}>•</text>}
              <text fg={textColor()}> {connecting() ? "connecting…" : statusText()}</text>
              <Show when={showProgress()}>
                <text fg={theme().textMuted}> {current()}/{total()}</text>
              </Show>
            </box>
            <Show when={showProgress()}>
              <box flexShrink={0}>
                <ProgressBar current={current()} total={total()} showLabel={false} width="auto" barWidth={12} fillBg="#aaa" fillFg="#000" />
              </box>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={props.variant === "home"}>
        {/* Home: single compact row, centered */}
        <box width="100%" flexDirection="row" justifyContent="center">
          <text fg={theme().textMuted}>🧠 {version()} </text>
          {busy() ? <Spinner fg={fg()} /> : <text fg={indicatorColor()}>•</text>}
          <text fg={textColor()}> {connecting() ? "connecting…" : statusText()}</text>
          <Show when={showProgress()}>
            <text fg={theme().textMuted}> </text>
            <ProgressBar current={current()} total={total()} showLabel={false} width="auto" barWidth={10} fillBg="#aaa" fillFg="#000" />
          </Show>
        </box>
      </Show>
    </box>
  );
}

export { BrainStatusBar };

const tui: TuiPlugin = (api) => {
  api.slots.register({
    order: 60,
    slots: {
      sidebar_content: (_ctx: any, props: any) => <BrainStatusBar api={api} variant="sidebar" sessionId={props.session_id} />,
      home_bottom: (_ctx: any, _props: any) => {
        const route = api.route.current;
        const sid = route.name === "session" && route.params ? (route.params as { sessionID?: string }).sessionID : undefined;
        return <BrainStatusBar api={api} variant="home" sessionId={sid} />;
      },
    },
  });
  return Promise.resolve();
};

export default {
  id: "four-opencode-brain",
  tui,
};

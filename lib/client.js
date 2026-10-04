// dsh-compaction-fidelity client extension.
//
// DSH 0.2.0-rc.2 declares `conversation.input.right` as a session-scoped list
// slot in dsh-client-ui-conversation. It renders immediately before the native
// model/reasoning seat (`conversation.input.model`). We register one compact
// "压缩线" control there instead of injecting into the ContextMeter DOM, so the
// control follows the host plugin lifecycle: disabling the bundle removes this
// contribution and the host commands together.
window.__ModuleLoader__.load({
  id: "dsh-compaction-fidelity",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    let ReactDOM = null;
    try { ReactDOM = require("react-dom"); } catch { ReactDOM = null; }
    const NS = "compaction-fidelity";
    const PRESETS = [
      { labelKey: "preset256", value: "256k" },
      { labelKey: "preset350", value: "350k" },
      { labelKey: "preset512", value: "512k" },
      { labelKey: "preset800", value: "800k" },
    ];
    const CUSTOM_MIN_EXCLUSIVE = 256;
    const CUSTOM_MAX_EXCLUSIVE = 800;
    const CUSTOM_STORAGE_KEY = "dsh-compaction-fidelity.customK";
    const THRESHOLD_STORAGE_KEY = "dsh-compaction-fidelity.threshold";
    const THRESHOLD_VERSION_KEY = "dsh-compaction-fidelity.thresholdVersion";
    const zh = {
      title: "上下文自动压缩线",
      short: "压缩线",
      current: "当前",
      hint: "达到此线后自动压缩",
      custom: "（自定义）",
      unit: "K",
      apply: "应用",
      saved: "已设置",
      failed: "设置失败",
      loading: "读取中",
      unknown: "未知命令",
      noSession: "未找到当前会话",
      placeholder: "257～799（K）",
      range: "合法有效值：256 < 值 < 800（K）",
      preset256: "256K",
      preset350: "350K（插件默认）",
      preset512: "512K",
      preset800: "800K（官方默认）",
    };
    const en = {
      title: "Context auto-compaction line",
      short: "Compact line",
      current: "Current",
      hint: "Auto-compact when reached",
      custom: "(Custom)",
      unit: "K",
      apply: "Apply",
      saved: "Saved",
      failed: "Failed",
      loading: "Loading",
      unknown: "Unknown command",
      noSession: "No active session",
      placeholder: "257–799 (K)",
      range: "Valid: 256 < value < 800 (K)",
      preset256: "256K",
      preset350: "350K (plugin default)",
      preset512: "512K",
      preset800: "800K (official default)",
    };

    function dict(locale) {
      return locale && String(locale).toLowerCase().startsWith("zh") ? zh : en;
    }

    function translator(props) {
      const fallback = dict(document.documentElement.lang);
      return (key) => {
        try {
          const value = typeof props.t === "function" ? props.t(key) : props.t?.[key];
          if (typeof value === "string" && value.length > 0) return value;
        } catch {}
        return fallback[key] ?? key;
      };
    }

    function formatThreshold(value) {
      const text = String(value ?? "").trim();
      if (text.length === 0) return "";
      const lower = text.toLowerCase();
      if (lower === "full" || lower === "auto" || lower === "1m") return "1M";
      if (lower === "80%") return "官方80%";
      if (lower.endsWith("k")) return lower.slice(0, -1) + "K";
      if (/^\d+$/.test(lower)) {
        const numeric = Number(lower);
        if (numeric >= 1024) {
          const kilo = numeric / 1024;
          return (Number.isInteger(kilo) ? String(kilo) : String(Math.round(kilo))) + "K";
        }
      }
      return text;
    }

    function isValidCustom(value) {
      return Number.isInteger(value) && value > CUSTOM_MIN_EXCLUSIVE && value < CUSTOM_MAX_EXCLUSIVE;
    }

    function readStoredCustom() {
      try {
        const raw = window.localStorage?.getItem(CUSTOM_STORAGE_KEY);
        const numeric = Number(raw);
        return isValidCustom(numeric) ? String(numeric) : "";
      } catch {
        return "";
      }
    }

    function storeCustom(value) {
      try {
        if (isValidCustom(Number(value))) window.localStorage?.setItem(CUSTOM_STORAGE_KEY, String(value));
      } catch {}
    }

    function readStoredThreshold() {
      try {
        const raw = window.localStorage?.getItem(THRESHOLD_STORAGE_KEY);
        const text = String(raw ?? "").trim().toLowerCase();
        const version = String(window.localStorage?.getItem(THRESHOLD_VERSION_KEY) ?? "");
        if (text.length === 0 || (text === "800k" && version !== "350k")) {
          window.localStorage?.setItem(THRESHOLD_STORAGE_KEY, "350k");
          window.localStorage?.setItem(THRESHOLD_VERSION_KEY, "350k");
          return "350k";
        }
        if (version !== "350k") window.localStorage?.setItem(THRESHOLD_VERSION_KEY, "350k");
        if (text.length > 0) return text;
      } catch {}
      return "350k";
    }

    function storeThreshold(value) {
      try { window.localStorage?.setItem(THRESHOLD_STORAGE_KEY, String(value)); } catch {}
    }

    function modeFor(raw) {
      const text = String(raw ?? "").trim().toLowerCase();
      if (PRESETS.some((preset) => preset.value === text)) return text;
      const match = /^(\d+)k$/.exec(text);
      const numeric = match ? Number(match[1]) : NaN;
      return isValidCustom(numeric) ? "custom" : null;
    }

    function CompactionFidelityThresholdControl(props) {
      const T = translator(props);
      const execute = props.execute;
      const h = React.createElement;
      const [current, setCurrent] = React.useState(() => readStoredThreshold());
      const [activeMode, setActiveMode] = React.useState(() => modeFor(readStoredThreshold()));
      const [custom, setCustom] = React.useState(() => readStoredCustom());
      const [open, setOpen] = React.useState(false);
      const [status, setStatus] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [menuPos, setMenuPos] = React.useState(null);
      const rootRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const executeRef = React.useRef(execute);
      executeRef.current = execute;

      const run = React.useCallback(async (command) => {
        try {
          return await executeRef.current(command);
        } catch (error) {
          return { ok: false, text: error instanceof Error ? error.message : String(error) };
        }
      }, []);

      const applyHostState = React.useCallback((raw) => {
        const text = String(raw ?? "").trim().toLowerCase();
        setCurrent(text);
        storeThreshold(text);
        if (PRESETS.some((preset) => preset.value === text)) {
          setActiveMode(text);
          return;
        }
        const match = /^(\d+)k$/.exec(text);
        const numeric = match ? Number(match[1]) : NaN;
        if (isValidCustom(numeric)) {
          setActiveMode("custom");
          setCustom(String(numeric));
          storeCustom(numeric);
          return;
        }
        setActiveMode(null);
      }, []);


      const positionMenu = React.useCallback(() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return;
        const width = 272;
        const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow >= 300) {
          setMenuPos({ left, top: rect.bottom + 6, bottom: null });
        } else {
          setMenuPos({ left, top: null, bottom: Math.max(8, window.innerHeight - rect.top + 6) });
        }
      }, []);

      React.useLayoutEffect(() => {
        if (!open) return undefined;
        positionMenu();
        window.addEventListener("resize", positionMenu);
        return () => window.removeEventListener("resize", positionMenu);
      }, [open, positionMenu]);

      React.useEffect(() => {
        if (!open) return undefined;
        const closeOutside = (event) => {
          if (rootRef.current?.contains(event.target) === true) return;
          if (menuRef.current?.contains(event.target) === true) return;
          setOpen(false);
        };
        document.addEventListener("mousedown", closeOutside, true);
        return () => document.removeEventListener("mousedown", closeOutside, true);
      }, [open]);

      const setThreshold = React.useCallback(async (value, mode) => {
        setBusy(true);
        setStatus("");
        const result = await run("/compaction-fidelity threshold " + value);
        if (result.ok) {
          applyHostState(value);
          if (mode === "custom") {
            const numeric = Number(String(value).replace(/k$/i, ""));
            setCustom(String(numeric));
            storeCustom(numeric);
          }
          setStatus(T("saved") + "：" + formatThreshold(value));
        } else {
          setStatus(T("failed") + "：" + result.text);
        }
        setBusy(false);
      }, [applyHostState, run, T]);

      const applyCustom = React.useCallback(async () => {
        const numeric = Number(custom.trim());
        if (!isValidCustom(numeric)) {
          setStatus(T("failed") + "：" + T("range"));
          return;
        }
        setCustom(String(numeric));
        await setThreshold(String(numeric) + "k", "custom");
      }, [custom, setThreshold, T]);

      const normalized = current.trim().toLowerCase();
      const label = formatThreshold(current);
      const currentText = label.length > 0 ? label : T("loading");

      const optionStyle = (active) => ({
        height: "27px",
        padding: "0 10px",
        borderRadius: "7px",
        border: active ? "1px solid var(--dsw-alias-brand-primary, #4d6bfe)" : "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))",
        background: active ? "var(--dsw-alias-brand-primary, #4d6bfe)" : "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))",
        color: active ? "var(--dsw-alias-label-primary-inverted, #ffffff)" : "var(--dsw-alias-label-primary, #e8eaed)",
        fontSize: "12px",
        lineHeight: "25px",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        whiteSpace: "nowrap",
      });

      const menu = open && menuPos !== null
        ? h("div", {
            ref: menuRef,
            role: "dialog",
            "aria-label": T("title"),
            style: {
              position: "fixed",
              left: menuPos.left + "px",
              ...(menuPos.top !== null ? { top: menuPos.top + "px" } : {}),
              ...(menuPos.bottom !== null ? { bottom: menuPos.bottom + "px" } : {}),
              zIndex: 10000,
              width: "272px",
              boxSizing: "border-box",
              padding: "11px",
              borderRadius: "10px",
              border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))",
              background: "var(--dsw-alias-bg-layer-1, #202124)",
              boxShadow: "0 12px 32px rgba(0,0,0,.35)",
              color: "var(--dsw-alias-label-primary, #e8eaed)",
              fontSize: "12px",
            },
          }, [
            h("div", { key: "title", style: { fontWeight: 600, marginBottom: "3px" } }, T("title")),
            h("div", { key: "current", style: { color: "var(--dsw-alias-label-secondary, #9aa0a6)", marginBottom: "1px" } }, T("current") + "：" + currentText),
            h("div", { key: "hint", style: { color: "var(--dsw-alias-label-secondary, #9aa0a6)", marginBottom: "8px" } }, T("hint")),
            h("div", { key: "presets", style: { display: "flex", flexWrap: "wrap", gap: "6px" } }, PRESETS.map((preset) => h("button", {
              key: preset.value,
              type: "button",
              disabled: busy,
              "aria-pressed": activeMode === preset.value,
              onClick: () => { void setThreshold(preset.value, preset.value); },
              style: optionStyle(activeMode === preset.value),
            }, T(preset.labelKey)))),
            h("div", { key: "custom", style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "9px" } }, [
              h("span", { key: "label", style: { color: "var(--dsw-alias-label-secondary, #9aa0a6)", whiteSpace: "nowrap" } }, T("custom")),
              h("input", {
                key: "input",
                type: "number",
                min: CUSTOM_MIN_EXCLUSIVE + 1,
                max: CUSTOM_MAX_EXCLUSIVE - 1,
                step: 1,
                value: custom,
                placeholder: T("placeholder"),
                "aria-label": T("custom"),
                onChange: (event) => setCustom(event.target.value),
                onKeyDown: (event) => { if (event.key === "Enter") void applyCustom(); },
                style: {
                  flex: "1 1 auto",
                  minWidth: 0,
                  height: "27px",
                  padding: "0 7px",
                  borderRadius: "7px",
                  border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))",
                  background: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))",
                  color: "inherit",
                  fontSize: "12px",
                  boxSizing: "border-box",
                },
              }),
              h("span", { key: "unit", style: { color: "var(--dsw-alias-label-secondary, #9aa0a6)" } }, T("unit")),
              h("button", {
                key: "apply",
                type: "button",
                disabled: busy,
                "aria-pressed": activeMode === "custom",
                onClick: () => { void applyCustom(); },
                style: optionStyle(activeMode === "custom"),
              }, T("apply")),
            ]),
            h("div", { key: "status", style: { marginTop: "7px", minHeight: "16px", color: "var(--dsw-alias-label-secondary, #9aa0a6)", lineHeight: "16px" } }, status.length > 0 ? status : T("range")),
          ])
        : null;
      const portalMenu = menu === null || ReactDOM === null || typeof ReactDOM.createPortal !== "function"
        ? menu
        : ReactDOM.createPortal(menu, document.body, "compaction-fidelity-threshold-menu");

      return h("div", { ref: rootRef, style: { display: "inline-flex", position: "relative", flexShrink: 0 } }, [
        h("button", {
          key: "trigger",
          type: "button",
          title: T("title"),
          "aria-expanded": open,
          "aria-label": T("title") + ": " + currentText,
          onClick: () => {
            setStatus("");
            setOpen((value) => !value);
          },
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            height: "27px",
            padding: "0 9px",
            borderRadius: "7px",
            border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))",
            background: open ? "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.08))" : "transparent",
            color: "var(--dsw-alias-label-secondary, #9aa0a6)",
            fontSize: "12px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          },
        }, [
          h("span", { key: "short" }, T("short")),
          h("span", { key: "value", style: { color: "var(--dsw-alias-label-primary, #e8eaed)", fontWeight: 600 } }, currentText),
          h("span", { key: "chevron", style: { opacity: 0.7 } }, "▾"),
        ]),
        portalMenu,
      ]);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-compaction-fidelity: locale");
      ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
        name: "conversation.input.right",
        id: "compaction-fidelity-threshold",
        order: 100,
        locale: NS,
        inject: (sessionId) => ({
          execute: async (command) => {
            const T = translator({ t: undefined });
            if (!sessionId) return { ok: false, text: T("noSession") };
            try {
              const result = await ctx.remote.commands.execute(sessionId, command, []);
              if (!result || result.ok !== true) return { ok: false, text: result?.error?.message ?? T("failed") };
              if (result.value === undefined || result.value === null) return { ok: false, text: T("unknown") };
              const commandResult = result.value.result ?? result.value;
              const kind = commandResult?.kind;
              const text = typeof commandResult?.text === "string" ? commandResult.text : "";
              if (kind === "error") return { ok: false, text: text || T("failed") };
              return { ok: true, text };
            } catch (error) {
              return { ok: false, text: error instanceof Error ? error.message : String(error) };
            }
          },
        }),
      }, CompactionFidelityThresholdControl)), "dsh-compaction-fidelity: composer compaction-line control");
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = ["slots", "locale", "remote", "remote.commands"];
    return module.exports;
  },
});




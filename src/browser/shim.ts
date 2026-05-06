import {
  mapBrowserPathToInitialRoute,
  mapMemoryPathToBrowserPath,
} from "./routes";
import {
  handleLocalFilePickerMessage,
  isLocalFilePickerMessage,
} from "./files";
import {
  installWorkspaceRootDialog,
  openSelectWorkspaceRootDialog,
  type WorkspaceDirectoryEntries,
} from "./workspace-root-dialog";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    };

const RECONNECT_DELAY_MS = 1_000;
const SETTINGS_SIDEBAR_STYLE_ID = "codex-web-settings-sidebar-style";
const SETTINGS_SIDEBAR_TOGGLE_ID = "codex-web-settings-sidebar-toggle";

type MemoryNavigationChange = {
  action: "POP" | "PUSH" | "REPLACE";
  delta: number;
  location: {
    hash: string;
    key: string;
    pathname: string;
    search: string;
    state: unknown;
  };
};

type ElectronShimState = {
  initialRoute?: string;
  initialSidebarState?: boolean;
  closeSidebar?: () => void;
  onMemoryNavigationChanged?: (navigation: MemoryNavigationChange) => void;
};

declare global {
  interface Window {
    __ELECTRON_SHIM__?: ElectronShimState;
  }
}

declare const __CODEX_APP_VERSION__: string;

let requestCounter = 0;
let socket: WebSocket | null = null;
let reconnectTimeoutId: number | null = null;
const outboundQueue: RendererToMainMessage[] = [];
const pendingInvokes = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: unknown) => void;
  }
>();
const pendingDirectoryEntries = new Map<
  string,
  {
    reject: (reason?: unknown) => void;
    resolve: (value: WorkspaceDirectoryEntries) => void;
  }
>();
const rendererListeners = new Map<string, Set<IpcListener>>();

function unimplemented(method: string): never {
  debugger;
  throw new Error(`[electron-stub] ${method} is not implemented`);
}

export function emitRendererEvent(channel: string, args: unknown[]): void {
  const listeners = rendererListeners.get(channel);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const event = { sender: null };
  for (const listener of listeners) {
    listener(event, ...args);
  }
}

function handleIncomingMessage(message: MainToRendererMessage): void {
  if (message.type === "ipc-main-event") {
    emitRendererEvent(message.channel, message.args);
    return;
  }

  if (message.type === "ipc-renderer-invoke-result") {
    const pending = pendingInvokes.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingInvokes.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
    return;
  }

  if (message.type === "workspace-directory-entries-result") {
    const pending = pendingDirectoryEntries.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingDirectoryEntries.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(new Error(message.errorMessage));
  }
}

function flushOutboundQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const message of outboundQueue.splice(0)) {
    socket.send(JSON.stringify(message));
  }
}

function scheduleReconnect(): void {
  if (reconnectTimeoutId !== null) {
    return;
  }
  reconnectTimeoutId = window.setTimeout(() => {
    reconnectTimeoutId = null;
    ensureSocket();
  }, RECONNECT_DELAY_MS);
}

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/__backend/ipc`,
  );
  socket.addEventListener("open", () => {
    flushOutboundQueue();
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as MainToRendererMessage;
      handleIncomingMessage(message);
    } catch (error) {
      console.error(
        "[electron-stub] failed to parse IPC bridge message",
        error,
      );
    }
  });
  socket.addEventListener("close", () => {
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    scheduleReconnect();
  });
}

function enqueueMessage(message: RendererToMainMessage): void {
  outboundQueue.push(message);
  ensureSocket();
  flushOutboundQueue();
}

function nextRequestId(): string {
  requestCounter += 1;
  return `ipc_bridge_${requestCounter}`;
}

function invokeMain(channel: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingInvokes.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "ipc-renderer-invoke",
      requestId,
      channel,
      args,
    });
  });
}

function addIpcListener(channel: string, listener: IpcListener): void {
  const listeners = rendererListeners.get(channel) ?? new Set<IpcListener>();
  listeners.add(listener);
  rendererListeners.set(channel, listeners);
}

function shouldCloseSidebarForMemoryPath(path: string): boolean {
  return (
    path === "/" ||
    path.startsWith("/local/") ||
    path === "/settings" ||
    path.startsWith("/settings/") ||
    path === "/skills" ||
    path === "/automations"
  );
}

function isSettingsPath(path: string): boolean {
  return path === "/settings" || path.startsWith("/settings/");
}

function isMainSurfaceEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (target.matches("#root > div > div > main") ||
          target.classList.contains("main-surface")),
    );
}

function isInteractiveEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (target) => {
        if (
          !(target instanceof HTMLElement) ||
          target === document.body ||
          target === document.documentElement
        ) {
          return false;
        }

        return target.matches(
          [
            "a[href]",
            "button",
            "input",
            "select",
            "textarea",
            "[contenteditable='true']",
            "[role='button']",
            "[role='checkbox']",
            "[role='link']",
            "[role='menuitem']",
            "[role='option']",
            "[role='radio']",
            "[role='switch']",
          ].join(","),
        );
      },
    );
}

function ensureSettingsSidebarControls(): void {
  if (!document.getElementById(SETTINGS_SIDEBAR_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = SETTINGS_SIDEBAR_STYLE_ID;
    style.textContent = `
@media (max-width: 768px) {
  body[data-codex-settings-page="true"] .window-fx-sidebar-surface.w-token-sidebar {
    background: var(--color-token-sidebar-surface-primary, var(--color-token-bg-primary, #fff)) !important;
    position: fixed !important;
    inset: 0 auto 0 0 !important;
    z-index: 50 !important;
    overflow-y: auto !important;
    max-width: min(84vw, 340px) !important;
    box-shadow: 0 0 0 1px var(--color-token-border, rgba(0, 0, 0, 0.08)), 18px 0 48px rgba(0, 0, 0, 0.12) !important;
    transition: transform 160ms ease !important;
  }

  body[data-codex-settings-page="true"][data-codex-settings-sidebar-collapsed="true"] .window-fx-sidebar-surface.w-token-sidebar {
    transform: translateX(-100%) !important;
    pointer-events: none !important;
  }

  #${SETTINGS_SIDEBAR_TOGGLE_ID} {
    align-items: center;
    background: var(--color-token-bg-primary, #fff);
    border: 1px solid var(--color-token-border, rgba(0, 0, 0, 0.12));
    border-radius: 10px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.10);
    color: var(--color-token-text-primary, #111);
    cursor: pointer;
    display: none;
    height: 36px;
    justify-content: center;
    left: max(12px, env(safe-area-inset-left));
    position: fixed;
    top: max(12px, env(safe-area-inset-top));
    width: 36px;
    z-index: 60;
  }

  body[data-codex-settings-page="true"][data-codex-settings-sidebar-collapsed="true"] #${SETTINGS_SIDEBAR_TOGGLE_ID} {
    display: flex;
  }
}
`;
    document.head.append(style);
  }

  if (!document.getElementById(SETTINGS_SIDEBAR_TOGGLE_ID)) {
    const button = document.createElement("button");
    button.id = SETTINGS_SIDEBAR_TOGGLE_ID;
    button.type = "button";
    button.title = "Show settings navigation";
    button.setAttribute("aria-label", "Show settings navigation");
    button.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 5.75h12M4 10h12M4 14.25h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    button.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      document.body.dataset.codexSettingsSidebarCollapsed = "false";
    });
    document.body.append(button);
  }
}

function updateSettingsSidebarState(path: string): void {
  const isSettingsPage = isSettingsPath(path);
  document.body.dataset.codexSettingsPage = String(isSettingsPage);
  if (!isSettingsPage) {
    delete document.body.dataset.codexSettingsSidebarCollapsed;
    return;
  }

  ensureSettingsSidebarControls();
  if (mobileMediaQuery.matches) {
    document.body.dataset.codexSettingsSidebarCollapsed = "false";
    return;
  }
  delete document.body.dataset.codexSettingsSidebarCollapsed;
}

function collapseSettingsSidebar(): void {
  if (document.body.dataset.codexSettingsPage !== "true") {
    return;
  }
  document.body.dataset.codexSettingsSidebarCollapsed = "true";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnhandledAddWorkspaceRootOptionMessage(value: unknown): value is {
  root?: unknown;
  type: "electron-add-new-workspace-root-option";
} {
  return (
    isRecord(value) &&
    value.type === "electron-add-new-workspace-root-option" &&
    typeof value.root !== "string"
  );
}

function requestWorkspaceDirectoryEntries(
  directoryPath: string | null,
): Promise<WorkspaceDirectoryEntries> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    pendingDirectoryEntries.set(requestId, { resolve, reject });
    enqueueMessage({
      type: "workspace-directory-entries-request",
      requestId,
      directoryPath,
      directoriesOnly: true,
    });
  });
}

const themeMediaQuery = matchMedia("(prefers-color-scheme: dark)");
const mobileMediaQuery = matchMedia("(max-width: 768px)");
const initialSidebarState = !mobileMediaQuery.matches;
const electronShim = (window.__ELECTRON_SHIM__ ??= {});

const initialRoute = mapBrowserPathToInitialRoute(
  window.location.pathname,
  window.location.search,
);
electronShim.initialRoute = initialRoute.memoryPath;

if (initialRoute.browserPath) {
  window.history.pushState(undefined, "", initialRoute.browserPath);
}

electronShim.initialSidebarState = initialSidebarState;
updateSettingsSidebarState(initialRoute.memoryPath);
mobileMediaQuery.addEventListener("change", () => {
  updateSettingsSidebarState(electronShim.initialRoute ?? "/");
});
document.addEventListener(
  "pointerdown",
  (event) => {
    if (
      mobileMediaQuery.matches &&
      isMainSurfaceEvent(event) &&
      !isInteractiveEvent(event)
    ) {
      if (document.body.dataset.codexSettingsPage === "true") {
        collapseSettingsSidebar();
        return;
      }
      electronShim.closeSidebar?.();
    }
  },
  { capture: true },
);
electronShim.onMemoryNavigationChanged = (navigation) => {
  const path = navigation.location.pathname;
  electronShim.initialRoute = path;
  updateSettingsSidebarState(path);
  if (
    navigation.action !== "POP" &&
    mobileMediaQuery.matches &&
    shouldCloseSidebarForMemoryPath(path)
  ) {
    electronShim.closeSidebar?.();
  }

  const browserPath = mapMemoryPathToBrowserPath(path);
  if (browserPath == null) {
    return;
  }

  if (browserPath.titleChange) {
    document.title = browserPath.titleChange;
  }

  if (window.location.pathname === browserPath.path) {
    window.history.replaceState(undefined, "", browserPath.path);
    return;
  }

  window.history.pushState(undefined, "", browserPath.path);
};

const buildFlavor: "prod" | "dev" | "agent" | string = "prod";

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === "codex_desktop:message-from-view" && args.length === 1) {
      if (isLocalFilePickerMessage(args[0])) {
        return handleLocalFilePickerMessage(args[0]);
      }

      if (isUnhandledAddWorkspaceRootOptionMessage(args[0])) {
        return openSelectWorkspaceRootDialog({
          listDirectory: requestWorkspaceDirectoryEntries,
        }).then((root) => {
          if (!root) {
            return undefined;
          }

          return invokeMain(channel, [{ ...args[0], root }]);
        });
      }
    }

    return invokeMain(channel, args);
  },
  on(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  once(channel: string, listener: IpcListener): unknown {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    addIpcListener(channel, wrapped);
    return this;
  },
  addListener(channel: string, listener: IpcListener): unknown {
    addIpcListener(channel, listener);
    return this;
  },
  removeListener(channel: string, listener: IpcListener): unknown {
    rendererListeners.get(channel)?.delete(listener);
    return this;
  },
  off(channel: string, listener: IpcListener): unknown {
    return this.removeListener(channel, listener);
  },
  send(channel: string, ...args: unknown[]): void {
    enqueueMessage({
      type: "ipc-renderer-send",
      channel,
      args,
    });
  },
  sendSync(channel: string, ..._args: unknown[]): unknown {
    if (channel === "codex_desktop:get-sentry-init-options") {
      return {
        codexAppSessionId: "42626fde-7064-471f-b44d-b1a7ad849c7f",
        buildFlavor,
        buildNumber: null,
        appVersion: __CODEX_APP_VERSION__,
        enabled: false,
      };
    }

    if (channel === "codex_desktop:get-build-flavor") {
      return buildFlavor;
    }

    if (channel === "codex_desktop:get-shared-object-snapshot") {
      return {
        host_config: {
          id: "local",
          display_name: "Local",
          kind: "local",
        },
        remote_connections: [],
        remote_control_connections: [],
        remote_control_connections_state: {
          available: false,
          authRequired: false,
        },
        pending_worktrees: [],
        statsig_default_enable_features: {
          enable_request_compression: true,
          collaboration_modes: true,
          personality: true,
          request_rule: true,
          fast_mode: true,
          image_generation: true,
          image_detail_original: true,
          workspace_dependencies: true,
          guardian_approval: true,
          apps: true,
          plugins: true,
          tool_search: true,
          tool_suggest: false,
          tool_call_mcp_elicitation: true,
          memories: false,
          realtime_conversation: false,
        },
      };
    }

    if (channel === "codex_desktop:get-system-theme-variant") {
      return themeMediaQuery.matches ? "dark" : "light";
    }

    return unimplemented("ipcRenderer.sendSync");
  },
};

ensureSocket();

export const contextBridge = {
  exposeInMainWorld(_key: string, _api: unknown): void {
    Reflect.set(window, _key, _api);
  },
};

export const webUtils = {
  getPathForFile(_file: File): string | null {
    return unimplemented("webUtils.getPathForFile");
  },
};

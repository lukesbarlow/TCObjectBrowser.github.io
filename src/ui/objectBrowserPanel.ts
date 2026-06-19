import { getWorkspaceApi } from "../api/connect";
import { ObjectBrowserService } from "../services/objectBrowserService";
import {
  colorToCss,
  labelFromKey,
  shortLabelFromKey,
} from "../utils/objectMetadata";
import {
  BrowserState,
  DEFAULT_BROWSER_STATE,
  NAME_KEY,
  PropertyKeyInfo,
  TreeNode,
} from "../types";
import { computeVirtualWindow, ROW_HEIGHT } from "./virtualTable";

interface FlatRow {
  node: TreeNode;
}

export class ObjectBrowserPanel {
  private state: BrowserState = { ...DEFAULT_BROWSER_STATE };
  private readonly service = new ObjectBrowserService();

  private readonly expandedIds = new Set<string>();
  private readonly selectedObjectKeys = new Set<string>();
  private readonly nodeById = new Map<string, TreeNode>();
  private visibleRows: FlatRow[] = [];
  private renderToken = 0;
  private lastHeaderKey = "";
  private filterDebounceId = 0;
  private columnsSearch = "";

  private readonly statusEl = requiredElement<HTMLElement>("status");
  private readonly tableWrapEl = requiredElement<HTMLElement>("table-wrap");
  private readonly headerRowEl = requiredElement<HTMLTableRowElement>("header-row");
  private readonly rowsEl = requiredElement<HTMLTableSectionElement>("object-rows");
  private readonly showFilterEl = requiredElement<HTMLSelectElement>("show-filter");
  private readonly groupByInputEl = requiredElement<HTMLInputElement>("group-by-input");
  private readonly groupByListEl = requiredElement<HTMLUListElement>("group-by-list");
  private readonly filterInputEl = requiredElement<HTMLInputElement>("filter-input");
  private readonly clearFilterEl = requiredElement<HTMLButtonElement>("clear-filter");
  private readonly columnsButtonEl = requiredElement<HTMLButtonElement>("columns-button");
  private readonly columnsPopoverEl = requiredElement<HTMLDivElement>("columns-popover");
  private readonly colorizeButtonEl = requiredElement<HTMLButtonElement>("colorize-groups");
  private readonly resetColorsButtonEl = requiredElement<HTMLButtonElement>("reset-colors");

  constructor() {
    this.bindControls();
    void this.initialize();
  }

  private bindControls(): void {
    this.showFilterEl.addEventListener("change", () => {
      this.state.showFilter = this.showFilterEl.value as BrowserState["showFilter"];
      void this.render();
    });

    this.filterInputEl.addEventListener("input", () => {
      this.state.filter = this.filterInputEl.value;
      this.clearFilterEl.hidden = this.state.filter.length === 0;
      window.clearTimeout(this.filterDebounceId);
      this.filterDebounceId = window.setTimeout(() => {
        void this.render();
      }, 200);
    });

    this.filterInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        window.clearTimeout(this.filterDebounceId);
        void this.render();
      }
    });

    this.clearFilterEl.addEventListener("click", () => {
      window.clearTimeout(this.filterDebounceId);
      this.filterInputEl.value = "";
      this.state.filter = "";
      this.clearFilterEl.hidden = true;
      void this.render();
    });

    this.colorizeButtonEl.addEventListener("click", () => {
      void this.colorizeGroups();
    });

    this.resetColorsButtonEl.addEventListener("click", () => {
      void this.resetColors();
    });

    this.bindGroupByCombobox();
    this.bindColumnsPicker();
    this.bindTableDelegation();

    this.tableWrapEl.addEventListener("scroll", () => {
      this.renderVirtualWindow();
      this.applySelectionHighlight();
    });

    window.addEventListener("tc-workspace-event", (event) => {
      const detail = (event as CustomEvent<{ event: string; data: unknown }>).detail;
      this.handleWorkspaceEvent(detail.event, detail.data);
    });
  }

  private bindTableDelegation(): void {
    this.rowsEl.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      const expandButton = target.closest<HTMLElement>("[data-action='expand']");
      if (expandButton) {
        event.stopPropagation();
        void this.toggleExpand(expandButton.dataset.nodeId ?? "");
        return;
      }

      const visibilityButton = target.closest<HTMLElement>("[data-action='visibility']");
      if (visibilityButton) {
        event.stopPropagation();
        const node = this.nodeById.get(visibilityButton.dataset.nodeId ?? "");
        if (node) {
          void this.toggleVisibility(node, !node.visible);
        }
        return;
      }

      const colorButton = target.closest<HTMLElement>("[data-action='color']");
      if (colorButton) {
        event.stopPropagation();
        const node = this.nodeById.get(colorButton.dataset.nodeId ?? "");
        if (!node) {
          return;
        }

        if (event.shiftKey) {
          void this.resetNodeColor(node);
          return;
        }

        const input = colorButton.querySelector<HTMLInputElement>("input[type='color']");
        input?.click();
        return;
      }

      const row = target.closest<HTMLElement>("tr.tree-row");
      if (row?.dataset.nodeId) {
        const node = this.nodeById.get(row.dataset.nodeId);
        if (node) {
          void this.service.selectObjects(node.objects);
        }
      }
    });

    this.rowsEl.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "color") {
        return;
      }

      const node = this.nodeById.get(target.dataset.nodeId ?? "");
      if (node) {
        void this.applyNodeColor(node, target.value);
      }
    });
  }

  private bindGroupByCombobox(): void {
    this.groupByInputEl.addEventListener("focus", () => {
      this.groupByInputEl.select();
      this.renderGroupByList("");
    });

    this.groupByInputEl.addEventListener("input", () => {
      this.state.groupBySearch = this.groupByInputEl.value;
      this.renderGroupByList(this.groupByInputEl.value);
    });

    document.addEventListener("click", (event) => {
      if (
        !this.groupByListEl.contains(event.target as Node) &&
        event.target !== this.groupByInputEl
      ) {
        this.groupByListEl.hidden = true;
      }

      if (
        !this.columnsPopoverEl.contains(event.target as Node) &&
        event.target !== this.columnsButtonEl
      ) {
        this.columnsPopoverEl.hidden = true;
      }
    });
  }

  private bindColumnsPicker(): void {
    this.columnsButtonEl.addEventListener("click", () => {
      this.columnsPopoverEl.hidden = !this.columnsPopoverEl.hidden;
      if (!this.columnsPopoverEl.hidden) {
        this.columnsSearch = "";
        this.renderColumnsPopover();
      }
    });
  }

  private async initialize(): Promise<void> {
    this.setStatus("Connecting to Trimble Connect…");

    try {
      await this.reload();
    } catch (error) {
      this.setStatus(formatError(error), true);
      this.renderMessage(
        "Unable to connect to Trimble Connect. Open this extension inside the 3D viewer.",
      );
    }
  }

  private async reload(): Promise<void> {
    this.setStatus("Loading objects…");
    const count = await this.service.refresh();
    this.ensureValidGroupBy();
    this.syncGroupByInput();

    if (this.service.isAssemblySelection()) {
      this.setStatus("Building assembly index…");
      await this.service.ensureAssemblyIndex();
    }

    await this.render();
    this.setStatus(this.buildStatus(count));
  }

  private handleWorkspaceEvent(eventName: string, data: unknown): void {
    if (
      eventName === "viewer.onModelStateChanged" ||
      eventName === "viewer.onModelReset"
    ) {
      void this.reload();
      return;
    }

    if (eventName === "viewer.onSettingsChanged") {
      void this.handleSettingsChanged();
      return;
    }

    if (eventName === "viewer.onSelectionChanged") {
      void this.handleSelectionChanged(data);
    }
  }

  private async handleSettingsChanged(): Promise<void> {
    try {
      const api = await getWorkspaceApi();
      const settings = await api.viewer.getSettings();
      await this.service.setAssemblySelection(Boolean(settings?.assemblySelection));

      if (this.service.isAssemblySelection()) {
        this.setStatus("Building assembly index…");
        await this.service.ensureAssemblyIndex();
      }

      this.setStatus(this.buildStatus(this.lastCount));
      await this.render();
    } catch {
      // ignore transient settings read failures
    }
  }

  private async handleSelectionChanged(data: unknown): Promise<void> {
    const token = ++this.renderToken;
    this.selectedObjectKeys.clear();
    const selection = extractSelection(data);
    let firstObjectKey: string | null = null;

    for (const model of selection) {
      for (const id of model.objectRuntimeIds ?? []) {
        const key = `${model.modelId}:${id}`;
        this.selectedObjectKeys.add(key);
        if (!firstObjectKey) {
          firstObjectKey = key;
        }

        const path = this.service.findObjectPath(model.modelId, id, this.state);
        if (path) {
          this.expandedIds.add(path.groupId);
          if (path.assemblyId) {
            this.expandedIds.add(path.assemblyId);
          }
        }
      }
    }

    if (selection.length > 0 && this.service.isAssemblySelection()) {
      this.setStatus("Syncing selection…");
      await this.service.ensureAssemblyIndex();
    }

    if (token !== this.renderToken) {
      return;
    }

    await this.render();

    if (firstObjectKey) {
      for (const row of this.rowsEl.querySelectorAll<HTMLElement>("tr[data-object-key]")) {
        if (row.dataset.objectKey === firstObjectKey) {
          row.scrollIntoView({ block: "nearest" });
          break;
        }
      }
    }

    this.setStatus(this.buildStatus(this.lastCount));
  }

  private lastCount = 0;

  private buildStatus(count: number): string {
    this.lastCount = count;
    const mode = this.service.isAssemblySelection()
      ? "assembly selection"
      : "object selection";
    return `${count.toLocaleString()} objects · ${mode}`;
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    this.renderHeaderIfNeeded();

    if (this.service.isLoading()) {
      this.visibleRows = [];
      this.nodeById.clear();
      this.replaceRows(this.messageRow("Loading objects…"));
      return;
    }

    const groups = this.service.buildTopLevelGroups(this.state);
    if (groups.length === 0) {
      this.visibleRows = [];
      this.nodeById.clear();
      this.replaceRows(this.messageRow("No objects match the current filters."));
      return;
    }

    const rows = await this.buildVisibleRows(groups, token);
    if (token !== this.renderToken) {
      return;
    }

    this.visibleRows = rows;
    this.renderVirtualWindow();
    this.applySelectionHighlight();
  }

  private async buildVisibleRows(groups: TreeNode[], token: number): Promise<FlatRow[]> {
    const rows: FlatRow[] = [];
    this.nodeById.clear();

    const walk = async (node: TreeNode): Promise<boolean> => {
      if (token !== this.renderToken) {
        return false;
      }

      rows.push({ node });
      this.nodeById.set(node.id, node);

      if (!this.expandedIds.has(node.id)) {
        return true;
      }

      await this.service.loadChildren(node, this.state);
      if (token !== this.renderToken) {
        return false;
      }

      for (const child of node.children) {
        const continueWalk = await walk(child);
        if (!continueWalk) {
          return false;
        }
      }

      return true;
    };

    for (const group of groups) {
      const continueWalk = await walk(group);
      if (!continueWalk) {
        return [];
      }
    }

    return rows;
  }

  private renderVirtualWindow(): void {
    const scrollTop = this.tableWrapEl.scrollTop;
    const viewportHeight = this.tableWrapEl.clientHeight || 400;
    const window = computeVirtualWindow(
      scrollTop,
      viewportHeight,
      this.visibleRows.length,
      ROW_HEIGHT,
    );

    const fragment = document.createDocumentFragment();

    if (window.topSpacer > 0) {
      fragment.append(this.spacerRow(window.topSpacer));
    }

    for (let index = window.startIndex; index < window.endIndex; index += 1) {
      const row = this.visibleRows[index];
      if (row) {
        fragment.append(this.createRow(row.node));
      }
    }

    if (window.bottomSpacer > 0) {
      fragment.append(this.spacerRow(window.bottomSpacer));
    }

    this.rowsEl.replaceChildren(fragment);
  }

  private spacerRow(height: number): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.className = "virtual-spacer";
    const cell = document.createElement("td");
    cell.colSpan = this.state.columns.length + 2;
    cell.style.height = `${height}px`;
    cell.style.padding = "0";
    cell.style.border = "none";
    row.append(cell);
    return row;
  }

  private renderHeaderIfNeeded(): void {
    const key = `${this.state.columns.join("\u0000")}|${this.state.sortField}|${this.state.sortDirection}`;
    if (key === this.lastHeaderKey) {
      return;
    }

    this.lastHeaderKey = key;
    this.renderHeader();
  }

  private renderHeader(): void {
    this.headerRowEl.replaceChildren();

    const controls = document.createElement("th");
    controls.className = "col-controls";
    this.headerRowEl.append(controls);

    this.headerRowEl.append(this.createHeaderCell("Object name", NAME_KEY, "col-name"));

    for (const key of this.state.columns) {
      this.headerRowEl.append(
        this.createHeaderCell(shortLabelFromKey(key), key, "col-data"),
      );
    }
  }

  private createHeaderCell(
    label: string,
    sortKey: string,
    className: string,
  ): HTMLTableCellElement {
    const cell = document.createElement("th");
    cell.className = `${className} sortable`;
    cell.title = labelFromKey(sortKey);

    const text = document.createElement("span");
    text.textContent = label;
    cell.append(text);

    const indicator = document.createElement("span");
    indicator.className = "sort-indicator";
    if (this.state.sortField === sortKey) {
      indicator.textContent = this.state.sortDirection === "asc" ? " ↑" : " ↓";
    }
    cell.append(indicator);

    cell.addEventListener("click", () => {
      if (this.state.sortField === sortKey) {
        this.state.sortDirection = this.state.sortDirection === "asc" ? "desc" : "asc";
      } else {
        this.state.sortField = sortKey;
        this.state.sortDirection = "asc";
      }
      this.lastHeaderKey = "";
      void this.render();
    });

    return cell;
  }

  private createRow(node: TreeNode): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.className = `tree-row ${node.kind}-row`;
    row.dataset.nodeId = node.id;
    row.style.height = `${ROW_HEIGHT}px`;

    if (node.kind === "object" && node.object) {
      row.dataset.objectKey = `${node.object.modelId}:${node.object.id}`;
    }

    const controls = document.createElement("td");
    controls.className = "col-controls";
    controls.style.paddingLeft = `${10 + node.level * 16}px`;

    if (node.kind === "object") {
      controls.append(this.createSpacer());
    } else {
      controls.append(this.createExpandButton(node));
    }

    controls.append(
      this.createVisibilityButton(node),
      this.createColorSwatch(node),
    );
    row.append(controls);

    const nameCell = document.createElement("td");
    nameCell.className = "col-name";
    nameCell.textContent =
      node.kind === "object" ? node.label : `${node.label} (${node.count.toLocaleString()})`;
    row.append(nameCell);

    for (const key of this.state.columns) {
      const cell = document.createElement("td");
      cell.className = "col-data";
      cell.textContent = this.columnValue(node, key);
      row.append(cell);
    }

    return row;
  }

  private columnValue(node: TreeNode, key: string): string {
    if (node.kind === "object" && node.object) {
      return node.object.values.get(key) ?? "-";
    }

    let shared: string | undefined;
    for (const object of node.objects) {
      const value = object.values.get(key) ?? "-";
      if (shared === undefined) {
        shared = value;
      } else if (shared !== value) {
        return "";
      }
    }

    return shared ?? "";
  }

  private createExpandButton(node: TreeNode): HTMLButtonElement {
    const expanded = this.expandedIds.has(node.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button expand-button";
    button.dataset.action = "expand";
    button.dataset.nodeId = node.id;
    button.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
    button.textContent = expanded ? "▾" : "▸";
    return button;
  }

  private async toggleExpand(nodeId: string): Promise<void> {
    if (this.expandedIds.has(nodeId)) {
      this.expandedIds.delete(nodeId);
    } else {
      this.expandedIds.add(nodeId);
    }
    await this.render();
  }

  private createSpacer(): HTMLSpanElement {
    const spacer = document.createElement("span");
    spacer.className = "expand-spacer";
    return spacer;
  }

  private createVisibilityButton(node: TreeNode): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icon-button visibility-button ${node.visible ? "is-visible" : "is-hidden"}`;
    button.dataset.action = "visibility";
    button.dataset.nodeId = node.id;
    button.setAttribute("aria-label", node.visible ? "Hide" : "Show");
    button.textContent = node.visible ? "👁" : "🚫";
    return button;
  }

  private createColorSwatch(node: TreeNode): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-swatch-button";
    button.dataset.action = "color";
    button.dataset.nodeId = node.id;
    button.setAttribute("aria-label", "Pick color, Shift+click to reset");

    const swatch = document.createElement("span");
    swatch.className = "color-swatch";
    const cssColor = colorToCss(node.color);
    if (cssColor) {
      swatch.style.backgroundColor = cssColor;
    } else {
      swatch.classList.add("is-mixed");
    }

    const input = document.createElement("input");
    input.type = "color";
    input.className = "color-swatch-input";
    input.value = cssColor ?? "#808080";
    input.dataset.nodeId = node.id;

    button.append(swatch, input);
    return button;
  }

  private async toggleVisibility(node: TreeNode, visible: boolean): Promise<void> {
    node.visible = visible;
    await this.service.toggleVisibility(node.objects, visible);
    await this.render();
  }

  private async applyNodeColor(node: TreeNode, color: string): Promise<void> {
    await this.service.setObjectColor(node.objects, color);
    node.color = color;
    await this.render();
  }

  private async resetNodeColor(node: TreeNode): Promise<void> {
    await this.service.resetObjectColor(node.objects);
    node.color = undefined;
    await this.render();
  }

  private async colorizeGroups(): Promise<void> {
    this.setStatus("Applying group colors…");
    await this.service.colorizeGroups(this.state);
    this.state.colorized = true;
    await this.render();
    this.setStatus(this.buildStatus(this.lastCount));
  }

  private async resetColors(): Promise<void> {
    this.setStatus("Resetting colors…");
    await this.service.resetColors();
    this.state.colorized = false;
    await this.render();
    this.setStatus(this.buildStatus(this.lastCount));
  }

  private renderGroupByList(query: string): void {
    const normalized = query.trim().toLowerCase();
    const catalog = this.service.getCatalog();
    const matches = catalog.filter((info) => {
      if (!normalized) {
        return true;
      }
      return (
        info.label.toLowerCase().includes(normalized) ||
        info.group.toLowerCase().includes(normalized)
      );
    });

    this.groupByListEl.replaceChildren();

    if (matches.length === 0) {
      const empty = document.createElement("li");
      empty.className = "combobox-empty";
      empty.textContent = "No matching properties";
      this.groupByListEl.append(empty);
    } else {
      for (const info of matches.slice(0, 200)) {
        this.groupByListEl.append(this.createGroupByOption(info));
      }
    }

    this.groupByListEl.hidden = false;
  }

  private createGroupByOption(info: PropertyKeyInfo): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "combobox-option";
    if (info.key === this.state.groupBy) {
      item.classList.add("is-selected");
    }

    const label = document.createElement("span");
    label.className = "combobox-option-label";
    label.textContent = info.label;
    item.append(label);

    if (!info.builtin) {
      const group = document.createElement("span");
      group.className = "combobox-option-group";
      group.textContent = info.group;
      item.append(group);
    }

    item.addEventListener("click", () => {
      this.state.groupBy = info.key;
      this.state.groupBySearch = "";
      this.expandedIds.clear();
      this.syncGroupByInput();
      this.groupByListEl.hidden = true;
      void this.render();
    });

    return item;
  }

  private renderColumnsPopover(): void {
    this.columnsPopoverEl.replaceChildren();

    const title = document.createElement("div");
    title.className = "popover-title";
    title.textContent = "Columns";
    this.columnsPopoverEl.append(title);

    const search = document.createElement("input");
    search.type = "text";
    search.className = "popover-search";
    search.placeholder = "Type to search columns…";
    search.value = this.columnsSearch;
    search.addEventListener("input", () => {
      this.columnsSearch = search.value;
      this.renderColumnsList();
    });
    this.columnsPopoverEl.append(search);

    const list = document.createElement("div");
    list.className = "popover-list";
    list.id = "columns-popover-list";
    this.columnsPopoverEl.append(list);

    this.renderColumnsList();
    search.focus();
  }

  private renderColumnsList(): void {
    const list = this.columnsPopoverEl.querySelector("#columns-popover-list");
    if (!list) {
      return;
    }

    list.replaceChildren();
    const normalized = this.columnsSearch.trim().toLowerCase();
    const catalog = this.service.getCatalog().filter((info) => info.key !== NAME_KEY);
    const matches = catalog.filter((info) => {
      if (!normalized) {
        return true;
      }
      return (
        info.label.toLowerCase().includes(normalized) ||
        info.group.toLowerCase().includes(normalized)
      );
    });

    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "combobox-empty";
      empty.textContent = "No matching columns";
      list.append(empty);
      return;
    }

    for (const info of matches.slice(0, 200)) {
      const row = document.createElement("label");
      row.className = "popover-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.state.columns.includes(info.key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (!this.state.columns.includes(info.key)) {
            this.state.columns.push(info.key);
          }
        } else {
          this.state.columns = this.state.columns.filter((key) => key !== info.key);
        }

        if (
          !this.state.columns.includes(this.state.sortField) &&
          this.state.sortField !== NAME_KEY
        ) {
          this.state.sortField = NAME_KEY;
        }

        this.lastHeaderKey = "";
        void this.render();
      });

      const text = document.createElement("span");
      text.textContent = info.builtin ? info.label : `${info.group} › ${info.label}`;

      row.append(checkbox, text);
      list.append(row);
    }
  }

  private ensureValidGroupBy(): void {
    const catalog = this.service.getCatalog();
    if (!catalog.some((info) => info.key === this.state.groupBy)) {
      this.state.groupBy = catalog[0]?.key ?? NAME_KEY;
    }

    this.state.columns = this.state.columns.filter(
      (key) => key === NAME_KEY || catalog.some((info) => info.key === key),
    );

    if (this.state.columns.length === 0) {
      const fallback = catalog.find((info) => info.key !== NAME_KEY);
      if (fallback) {
        this.state.columns = [fallback.key];
      }
    }
  }

  private syncGroupByInput(): void {
    this.groupByInputEl.value = shortLabelFromKey(this.state.groupBy);
  }

  private applySelectionHighlight(): void {
    for (const row of this.rowsEl.querySelectorAll<HTMLElement>("tr[data-object-key]")) {
      const key = row.dataset.objectKey ?? "";
      row.classList.toggle("is-selected", this.selectedObjectKeys.has(key));
    }
  }

  private replaceRows(row: HTMLTableRowElement): void {
    this.rowsEl.replaceChildren(row);
  }

  private messageRow(message: string): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.className = "placeholder-row";
    const cell = document.createElement("td");
    cell.colSpan = this.state.columns.length + 2;
    cell.textContent = message;
    row.append(cell);
    return row;
  }

  private renderMessage(message: string): void {
    this.replaceRows(this.messageRow(message));
  }

  private setStatus(message: string, isError = false): void {
    this.statusEl.textContent = message;
    this.statusEl.classList.toggle("is-error", isError);
  }
}

interface SelectionModel {
  modelId: string;
  objectRuntimeIds?: number[];
}

function extractSelection(data: unknown): SelectionModel[] {
  if (Array.isArray(data)) {
    return data as SelectionModel[];
  }

  if (data && typeof data === "object" && "data" in data) {
    const inner = (data as { data: unknown }).data;
    if (Array.isArray(inner)) {
      return inner as SelectionModel[];
    }
  }

  return [];
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }

  return element as T;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error";
}

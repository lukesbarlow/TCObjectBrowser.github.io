import type {
  HierarchyType,
  ModelObjects,
  ObjectProperties,
} from "trimble-connect-workspace-api";
import { getWorkspaceApi } from "../api/connect";
import { runWithConcurrency } from "../utils/concurrency";
import {
  BUILTIN_KEY_INFOS,
  buildSearchText,
  collectKeyInfos,
  extractValues,
  getObjectClass,
  getObjectName,
  getObjectType,
} from "../utils/objectMetadata";
import {
  BrowserState,
  FlatObject,
  GROUP_COLORS,
  PropertyKeyInfo,
  TreeNode,
} from "../types";

const PROPERTY_BATCH_SIZE = 250;
const PROPERTY_BATCH_CONCURRENCY = 5;
const ASSEMBLY_CHILDREN_CONCURRENCY = 8;
/**
 * `HierarchyType.ElementAssembly`. The enum is type-only in the workspace API
 * package (no runtime export), so the numeric value is used directly.
 */
const ELEMENT_ASSEMBLY = 4 as HierarchyType;

interface AssemblyInfo {
  modelId: string;
  assemblyId: number;
  name: string;
  objects: FlatObject[];
}

export interface ObjectPath {
  groupId: string;
  assemblyId?: string;
  objectNodeId: string;
}

export class ObjectBrowserService {
  private flatObjects: FlatObject[] = [];
  private catalog: PropertyKeyInfo[] = [];
  private groupColors = new Map<string, string>();
  private hiddenObjectIds = new Set<string>();
  private readonly objectByKey = new Map<string, FlatObject>();
  private readonly objectToAssembly = new Map<string, number>();
  /** Cache of assembly groupings per model, keyed by modelId. */
  private assemblyCache = new Map<string, Map<number, AssemblyInfo> | null>();
  private assemblySelection = false;
  private loading = false;
  private assemblyIndexPromise: Promise<void> | null = null;
  private groupCache: { key: string; nodes: TreeNode[] } | null = null;
  private readonly childrenCache = new Map<string, TreeNode[]>();

  isLoading(): boolean {
    return this.loading;
  }

  isAssemblySelection(): boolean {
    return this.assemblySelection;
  }

  isBuildingAssemblyIndex(): boolean {
    return this.assemblyIndexPromise !== null;
  }

  getCatalog(): PropertyKeyInfo[] {
    return this.catalog;
  }

  async refresh(): Promise<number> {
    this.loading = true;

    try {
      const api = await getWorkspaceApi();
      this.assemblySelection = await this.readAssemblySelection();
      this.invalidateCaches();

      const modelObjects = await api.viewer.getObjects();
      const hiddenObjectsPromise = api.viewer.getObjects(undefined, { visible: false });

      const flatByModel = await Promise.all(
        modelObjects.map((model) => this.buildFlatObjectsForModel(model)),
      );
      this.flatObjects = flatByModel.flat();
      this.rebuildObjectByKey();

      await this.applyHiddenObjects(await hiddenObjectsPromise);
      this.rebuildCatalog();

      if (this.assemblySelection) {
        void this.ensureAssemblyIndex();
      }

      return this.flatObjects.length;
    } finally {
      this.loading = false;
    }
  }

  async setAssemblySelection(value: boolean): Promise<void> {
    if (this.assemblySelection === value) {
      return;
    }

    this.assemblySelection = value;
    this.invalidateAssemblyCaches();

    if (value) {
      void this.ensureAssemblyIndex();
    }
  }

  /** Builds the top-level group nodes (children are loaded lazily). */
  buildTopLevelGroups(state: BrowserState): TreeNode[] {
    const cacheKey = groupCacheKey(state);
    if (this.groupCache?.key === cacheKey) {
      return this.groupCache.nodes;
    }

    const filtered = this.flatObjects.filter((object) =>
      matchesFilters(object, state),
    );

    const grouped = new Map<string, FlatObject[]>();
    for (const object of filtered) {
      const value = object.values.get(state.groupBy)?.trim() || "-";
      const bucket = grouped.get(value);
      if (bucket) {
        bucket.push(object);
      } else {
        grouped.set(value, [object]);
      }
    }

    const nodes: TreeNode[] = [...grouped.entries()].map(([value, objects]) => {
      const sorted = sortObjects(objects, state);
      const id = `g:${state.groupBy}:${value}`;
      return {
        kind: "group" as const,
        id,
        label: value,
        count: sorted.length,
        level: 0,
        objects: sorted,
        children: [],
        childrenLoaded: false,
        color: uniformColor(sorted) ?? this.groupColors.get(id),
        visible: sorted.some((object) => object.visible),
      };
    });

    const sortedNodes = nodes.sort((left, right) =>
      compareStrings(left.label, right.label, state.sortDirection),
    );
    this.groupCache = { key: cacheKey, nodes: sortedNodes };
    return sortedNodes;
  }

  /** Loads the children of a group or assembly node on demand. */
  async loadChildren(node: TreeNode, state: BrowserState): Promise<void> {
    const childrenKey = childrenCacheKey(node.id, state);
    const cached = this.childrenCache.get(childrenKey);
    if (cached) {
      node.children = cached;
      node.childrenLoaded = true;
      return;
    }

    if (node.childrenLoaded) {
      return;
    }

    if (node.kind === "assembly") {
      node.children = this.buildObjectLeaves(node, node.objects, state);
      node.childrenLoaded = true;
      this.childrenCache.set(childrenKey, node.children);
      return;
    }

    if (node.kind === "group" && this.assemblySelection) {
      await this.ensureAssemblyIndex();
      node.children = this.buildAssemblyChildren(node, state);
      node.childrenLoaded = true;
      this.childrenCache.set(childrenKey, node.children);
      return;
    }

    node.children = this.buildObjectLeaves(node, node.objects, state);
    node.childrenLoaded = true;
    this.childrenCache.set(childrenKey, node.children);
  }

  async ensureAssemblyIndex(): Promise<void> {
    if (!this.assemblySelection) {
      return;
    }

    if (this.assemblyIndexPromise) {
      await this.assemblyIndexPromise;
      return;
    }

    const modelIds = [...new Set(this.flatObjects.map((object) => object.modelId))];
    const pending = runWithConcurrency(modelIds, 4, async (modelId) => {
      await this.getAssemblies(modelId);
    });

    this.assemblyIndexPromise = pending;
    try {
      await pending;
    } finally {
      this.assemblyIndexPromise = null;
    }
  }

  findObjectPath(
    modelId: string,
    objectId: number,
    state: BrowserState,
  ): ObjectPath | null {
    const object = this.objectByKey.get(objectKey(modelId, objectId));
    if (!object) {
      return null;
    }

    const groupValue = object.values.get(state.groupBy)?.trim() || "-";
    const groupId = `g:${state.groupBy}:${groupValue}`;

    if (this.assemblySelection) {
      const assemblyId = this.objectToAssembly.get(objectKey(modelId, objectId));
      if (assemblyId !== undefined) {
        const assemblyNodeId = `${groupId}|a:${modelId}:${assemblyId}`;
        return {
          groupId,
          assemblyId: assemblyNodeId,
          objectNodeId: `${assemblyNodeId}|o:${modelId}:${objectId}`,
        };
      }
    }

    return {
      groupId,
      objectNodeId: `${groupId}|o:${modelId}:${objectId}`,
    };
  }

  async selectObjects(objects: FlatObject[]): Promise<void> {
    const api = await getWorkspaceApi();
    await api.viewer.setSelection({ modelObjectIds: groupByModel(objects) }, "set");
  }

  async toggleVisibility(objects: FlatObject[], visible: boolean): Promise<void> {
    const api = await getWorkspaceApi();
    await api.viewer.setObjectState(
      { modelObjectIds: groupByModel(objects) },
      { visible },
    );

    for (const object of objects) {
      object.visible = visible;
      this.setHiddenState(object, !visible);
    }
  }

  async setObjectColor(objects: FlatObject[], color: string): Promise<void> {
    const api = await getWorkspaceApi();
    const hex = normalizeHex(color);
    await api.viewer.setObjectState(
      { modelObjectIds: groupByModel(objects) },
      { color: hex },
    );

    for (const object of objects) {
      object.color = hex;
    }
  }

  async resetObjectColor(objects: FlatObject[]): Promise<void> {
    const api = await getWorkspaceApi();
    await api.viewer.setObjectState(
      { modelObjectIds: groupByModel(objects) },
      { color: "reset" },
    );

    for (const object of objects) {
      object.color = undefined;
    }
  }

  async colorizeGroups(state: BrowserState): Promise<void> {
    const api = await getWorkspaceApi();
    const groups = this.buildTopLevelGroups(state);

    groups.forEach((group, index) => {
      const color = GROUP_COLORS[index % GROUP_COLORS.length];
      this.groupColors.set(group.id, color);
      group.color = color;
      for (const object of group.objects) {
        object.color = color;
      }
    });

    await Promise.all(
      groups.map((group) =>
        api.viewer.setObjectState(
          { modelObjectIds: groupByModel(group.objects) },
          { color: this.groupColors.get(group.id) },
        ),
      ),
    );
  }

  async resetColors(): Promise<void> {
    const api = await getWorkspaceApi();
    this.groupColors.clear();
    await api.viewer.setObjectState(undefined, { color: "reset" });

    for (const object of this.flatObjects) {
      object.color = undefined;
    }
  }

  private invalidateCaches(): void {
    this.groupCache = null;
    this.childrenCache.clear();
    this.invalidateAssemblyCaches();
  }

  private invalidateAssemblyCaches(): void {
    this.assemblyCache.clear();
    this.objectToAssembly.clear();
    this.assemblyIndexPromise = null;
    this.childrenCache.clear();
    this.groupCache = null;
  }

  private rebuildObjectByKey(): void {
    this.objectByKey.clear();
    for (const object of this.flatObjects) {
      this.objectByKey.set(objectKey(object.modelId, object.id), object);
    }
  }

  private async readAssemblySelection(): Promise<boolean> {
    try {
      const api = await getWorkspaceApi();
      const settings = await api.viewer.getSettings();
      return Boolean(settings?.assemblySelection);
    } catch {
      return false;
    }
  }

  private buildAssemblyChildren(
    groupNode: TreeNode,
    state: BrowserState,
  ): TreeNode[] {
    const byModel = new Map<string, FlatObject[]>();
    for (const object of groupNode.objects) {
      const bucket = byModel.get(object.modelId);
      if (bucket) {
        bucket.push(object);
      } else {
        byModel.set(object.modelId, [object]);
      }
    }

    const assemblyNodes: TreeNode[] = [];
    const looseObjects: FlatObject[] = [];

    for (const [modelId, objects] of byModel) {
      const assemblies = this.assemblyCache.get(modelId);
      if (!assemblies) {
        looseObjects.push(...objects);
        continue;
      }

      const objectsById = new Map(objects.map((object) => [object.id, object]));
      const assigned = new Set<number>();
      const grouped = new Map<number, FlatObject[]>();

      for (const object of objects) {
        const assembly = this.getAssemblyInfo(modelId, object.id);
        if (assembly) {
          assigned.add(object.id);
          const bucket = grouped.get(assembly.assemblyId);
          if (bucket) {
            bucket.push(object);
          } else {
            grouped.set(assembly.assemblyId, [object]);
          }
        }
      }

      for (const [assemblyId, members] of grouped) {
        const assembly = assemblies.get(assemblyId);
        const sorted = sortObjects(members, state);
        const id = `${groupNode.id}|a:${modelId}:${assemblyId}`;
        assemblyNodes.push({
          kind: "assembly",
          id,
          label: assembly?.name || `Assembly ${assemblyId}`,
          count: sorted.length,
          level: 1,
          objects: sorted,
          children: [],
          childrenLoaded: false,
          color: uniformColor(sorted),
          visible: sorted.some((object) => object.visible),
        });
      }

      for (const object of objects) {
        if (!assigned.has(object.id)) {
          looseObjects.push(objectsById.get(object.id) ?? object);
        }
      }
    }

    assemblyNodes.sort((left, right) =>
      compareStrings(left.label, right.label, state.sortDirection),
    );

    if (looseObjects.length > 0) {
      assemblyNodes.push(
        ...this.buildObjectLeaves(groupNode, sortObjects(looseObjects, state), state),
      );
    }

    return assemblyNodes;
  }

  /**
   * Returns the assembly map for a model, building it lazily. Each object id is
   * resolved to its containing assembly via the element-assembly hierarchy.
   */
  private async getAssemblies(
    modelId: string,
  ): Promise<Map<number, AssemblyInfo> | null> {
    if (this.assemblyCache.has(modelId)) {
      return this.assemblyCache.get(modelId) ?? null;
    }

    try {
      const api = await getWorkspaceApi();
      const objects = this.flatObjects.filter((object) => object.modelId === modelId);
      const objectIds = objects.map((object) => object.id);
      const objectsById = new Map(objects.map((object) => [object.id, object]));

      const parents = await api.viewer.getHierarchyParents(
        modelId,
        objectIds,
        ELEMENT_ASSEMBLY,
        false,
      );

      const uniqueAssemblies = new Map<number, string>();
      for (const parent of parents) {
        if (!uniqueAssemblies.has(parent.id)) {
          uniqueAssemblies.set(parent.id, parent.name);
        }
      }

      if (uniqueAssemblies.size === 0) {
        this.assemblyCache.set(modelId, null);
        return null;
      }

      const assemblies = new Map<number, AssemblyInfo>();
      const assemblyEntries = [...uniqueAssemblies.entries()];

      await runWithConcurrency(
        assemblyEntries,
        ASSEMBLY_CHILDREN_CONCURRENCY,
        async ([assemblyId, name]) => {
          const children = await api.viewer.getHierarchyChildren(
            modelId,
            [assemblyId],
            ELEMENT_ASSEMBLY,
            true,
          );

          const members: FlatObject[] = [];
          for (const child of children) {
            const object = objectsById.get(child.id);
            if (object) {
              members.push(object);
              this.objectToAssembly.set(objectKey(modelId, child.id), assemblyId);
            }
          }

          assemblies.set(assemblyId, { modelId, assemblyId, name, objects: members });
        },
      );

      this.assemblyCache.set(modelId, assemblies);
      return assemblies;
    } catch {
      this.assemblyCache.set(modelId, null);
      return null;
    }
  }

  private getAssemblyInfo(
    modelId: string,
    objectId: number,
  ): AssemblyInfo | undefined {
    const assemblyId = this.objectToAssembly.get(objectKey(modelId, objectId));
    if (assemblyId === undefined) {
      return undefined;
    }

    return this.assemblyCache.get(modelId)?.get(assemblyId);
  }

  private buildObjectLeaves(
    parent: TreeNode,
    objects: FlatObject[],
    state: BrowserState,
  ): TreeNode[] {
    const level = parent.level + 1;
    return sortObjects(objects, state).map((object) => ({
      kind: "object" as const,
      id: `${parent.id}|o:${object.modelId}:${object.id}`,
      label: object.name,
      count: 1,
      level,
      objects: [object],
      object,
      children: [],
      childrenLoaded: true,
      color: object.color,
      visible: object.visible,
    }));
  }

  private async buildFlatObjectsForModel(model: ModelObjects): Promise<FlatObject[]> {
    const runtimeIds = model.objects.map((object) => object.id);
    const propertiesById = await this.loadProperties(model.modelId, runtimeIds);

    return model.objects.map((object) => {
      const properties = propertiesById.get(object.id) ?? object;
      return this.toFlatObject(model.modelId, properties);
    });
  }

  private async loadProperties(
    modelId: string,
    runtimeIds: number[],
  ): Promise<Map<number, ObjectProperties>> {
    const api = await getWorkspaceApi();
    const map = new Map<number, ObjectProperties>();
    const batches: number[][] = [];

    for (let index = 0; index < runtimeIds.length; index += PROPERTY_BATCH_SIZE) {
      batches.push(runtimeIds.slice(index, index + PROPERTY_BATCH_SIZE));
    }

    await runWithConcurrency(batches, PROPERTY_BATCH_CONCURRENCY, async (batch) => {
      const properties = await api.viewer.getObjectProperties(modelId, batch);
      for (const property of properties) {
        map.set(property.id, property);
      }
    });

    return map;
  }

  private async applyHiddenObjects(hiddenObjects: ModelObjects[]): Promise<void> {
    this.hiddenObjectIds.clear();

    for (const model of hiddenObjects) {
      for (const object of model.objects) {
        this.hiddenObjectIds.add(objectKey(model.modelId, object.id));
      }
    }

    for (const object of this.flatObjects) {
      object.visible = !this.hiddenObjectIds.has(objectKey(object.modelId, object.id));
    }
  }

  private toFlatObject(modelId: string, object: ObjectProperties): FlatObject {
    const values = extractValues(object);
    return {
      modelId,
      id: object.id,
      name: getObjectName(object),
      className: getObjectClass(object),
      objectType: getObjectType(object),
      values,
      searchText: buildSearchText(object, values),
      color: object.color,
      visible: !this.hiddenObjectIds.has(objectKey(modelId, object.id)),
    };
  }

  private rebuildCatalog(): void {
    const byKey = new Map<string, PropertyKeyInfo>();

    for (const object of this.flatObjects) {
      for (const info of collectKeyInfos(object.values)) {
        if (!byKey.has(info.key)) {
          byKey.set(info.key, info);
        }
      }
    }

    const propertyInfos = [...byKey.values()].sort((left, right) => {
      const groupResult = left.group.localeCompare(right.group, undefined, {
        sensitivity: "base",
      });
      if (groupResult !== 0) {
        return groupResult;
      }
      return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
    });

    this.catalog = [...BUILTIN_KEY_INFOS, ...propertyInfos];
  }

  private setHiddenState(object: FlatObject, hidden: boolean): void {
    const key = objectKey(object.modelId, object.id);
    if (hidden) {
      this.hiddenObjectIds.add(key);
    } else {
      this.hiddenObjectIds.delete(key);
    }
  }
}

function groupByModel(objects: FlatObject[]) {
  const byModel = new Map<string, number[]>();

  for (const object of objects) {
    const ids = byModel.get(object.modelId);
    if (ids) {
      ids.push(object.id);
    } else {
      byModel.set(object.modelId, [object.id]);
    }
  }

  return [...byModel.entries()].map(([modelId, objectRuntimeIds]) => ({
    modelId,
    objectRuntimeIds,
  }));
}

function matchesFilters(object: FlatObject, state: BrowserState): boolean {
  if (state.showFilter === "visible" && !object.visible) {
    return false;
  }

  if (state.showFilter === "hidden" && object.visible) {
    return false;
  }

  const normalizedFilter = state.filter.trim().toLowerCase();
  if (normalizedFilter && !object.searchText.includes(normalizedFilter)) {
    return false;
  }

  return true;
}

function sortObjects(objects: FlatObject[], state: BrowserState): FlatObject[] {
  return [...objects].sort((left, right) => {
    const leftValue = sortValue(left, state.sortField);
    const rightValue = sortValue(right, state.sortField);
    return compareStrings(leftValue, rightValue, state.sortDirection);
  });
}

function sortValue(object: FlatObject, sortField: string): string {
  return object.values.get(sortField) ?? "";
}

function compareStrings(left: string, right: string, direction: "asc" | "desc"): number {
  const result = left.localeCompare(right, undefined, {
    sensitivity: "base",
    numeric: true,
  });
  return direction === "asc" ? result : -result;
}

function objectKey(modelId: string, objectId: number): string {
  return `${modelId}:${objectId}`;
}

function groupCacheKey(state: BrowserState): string {
  return `${state.groupBy}|${state.showFilter}|${state.filter}|${state.sortField}|${state.sortDirection}`;
}

function childrenCacheKey(nodeId: string, state: BrowserState): string {
  return `${nodeId}|${groupCacheKey(state)}`;
}

function uniformColor(objects: FlatObject[]): string | undefined {
  if (objects.length === 0) {
    return undefined;
  }

  const first = objects[0]?.color;
  if (!first) {
    return undefined;
  }

  return objects.every((object) => object.color === first) ? first : undefined;
}

function normalizeHex(color: string): string {
  return color.startsWith("#") ? color.slice(1) : color;
}

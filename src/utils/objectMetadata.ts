import type { ObjectProperties, PropertySet } from "trimble-connect-workspace-api";
import {
  CLASS_KEY,
  KEY_SEPARATOR,
  NAME_KEY,
  PropertyKeyInfo,
  TYPE_KEY,
} from "../types";

const NAME_CANDIDATES = ["name", "objectname", "tag", "mark", "label"];

export function getObjectName(object: ObjectProperties): string {
  const productName = object.product?.name?.trim();
  if (productName) {
    return productName;
  }

  const propertyName = findPropertyValue(object.properties, NAME_CANDIDATES);
  if (propertyName) {
    return propertyName;
  }

  if (object.class?.trim()) {
    return object.class.trim();
  }

  return `Object ${object.id}`;
}

export function getObjectClass(object: ObjectProperties): string {
  return object.class?.trim() || "-";
}

export function getObjectType(object: ObjectProperties): string {
  return object.product?.objectType?.trim() || object.class?.trim() || "-";
}

/**
 * Flattens every IFC property of an object into a `key -> value` map, including
 * the built-in name/class/type pseudo-columns. Keys for property-set values are
 * encoded as `"<PropertySet>\u0000<Property>"`.
 */
export function extractValues(object: ObjectProperties): Map<string, string> {
  const values = new Map<string, string>();

  values.set(NAME_KEY, getObjectName(object));
  values.set(CLASS_KEY, getObjectClass(object));
  values.set(TYPE_KEY, getObjectType(object));

  for (const set of object.properties ?? []) {
    const setName = set.name?.trim() || "General";
    for (const property of set.properties ?? []) {
      const value = stringifyPropertyValue(property.value);
      if (!value) {
        continue;
      }

      const key = `${setName}${KEY_SEPARATOR}${property.name}`;
      if (!values.has(key)) {
        values.set(key, value);
      }
    }
  }

  return values;
}

/** Builds a lowercase haystack of every property name and value for filtering. */
export function buildSearchText(
  object: ObjectProperties,
  values: Map<string, string>,
): string {
  const parts: string[] = [];

  for (const [key, value] of values) {
    parts.push(value);
    if (!key.startsWith("__")) {
      parts.push(labelFromKey(key));
    }
  }

  const product = object.product;
  if (product?.description) {
    parts.push(product.description);
  }
  if (product?.objectType) {
    parts.push(product.objectType);
  }

  return parts.join(" ").toLowerCase();
}

/** Returns descriptors for every property key present on the given object. */
export function collectKeyInfos(values: Map<string, string>): PropertyKeyInfo[] {
  const infos: PropertyKeyInfo[] = [];

  for (const key of values.keys()) {
    if (key === NAME_KEY || key === CLASS_KEY || key === TYPE_KEY) {
      continue;
    }

    const [group, label] = splitKey(key);
    infos.push({ key, label, group, builtin: false });
  }

  return infos;
}

export const BUILTIN_KEY_INFOS: PropertyKeyInfo[] = [
  { key: NAME_KEY, label: "Object name", group: "General", builtin: true },
  { key: CLASS_KEY, label: "Object class", group: "General", builtin: true },
  { key: TYPE_KEY, label: "Object type", group: "General", builtin: true },
];

export function labelFromKey(key: string): string {
  if (key === NAME_KEY) return "Object name";
  if (key === CLASS_KEY) return "Object class";
  if (key === TYPE_KEY) return "Object type";

  const [group, label] = splitKey(key);
  return group === "General" ? label : `${group} › ${label}`;
}

export function shortLabelFromKey(key: string): string {
  if (key === NAME_KEY) return "Object name";
  if (key === CLASS_KEY) return "Object class";
  if (key === TYPE_KEY) return "Object type";

  return splitKey(key)[1];
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(KEY_SEPARATOR);
  if (index === -1) {
    return ["General", key];
  }

  return [key.slice(0, index), key.slice(index + KEY_SEPARATOR.length)];
}

function findPropertyValue(
  propertySets: PropertySet[] | undefined,
  candidates: string[],
): string | undefined {
  if (!propertySets?.length) {
    return undefined;
  }

  const normalizedCandidates = new Set(candidates.map(normalizeKey));

  for (const set of propertySets) {
    for (const property of set.properties ?? []) {
      const propertyName = normalizeKey(property.name);
      const shortName = normalizeKey(property.name.split(".").pop() ?? property.name);

      if (
        normalizedCandidates.has(propertyName) ||
        normalizedCandidates.has(shortName)
      ) {
        const value = stringifyPropertyValue(property.value);
        if (value) {
          return value;
        }
      }
    }
  }

  return undefined;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function stringifyPropertyValue(value: string | number | boolean | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

export function colorToCss(color?: string): string | undefined {
  if (!color) {
    return undefined;
  }

  if (color.startsWith("#")) {
    return color;
  }

  if (/^[0-9a-f]{6}$/i.test(color)) {
    return `#${color}`;
  }

  return color;
}

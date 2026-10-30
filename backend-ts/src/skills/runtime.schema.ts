import { arrayValue, cleanString, stringList } from "../util/values.ts";
import { SkillRuntimeError } from "./runtime.model.ts";
import type { JsonObject } from "./runtime.model.ts";
import { isRecord, recordValue } from "./runtime.values.ts";

export const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$id", "$schema", "additionalProperties", "allOf", "anyOf", "const", "default", "description", "enum",
  "examples", "items", "maxItems", "maxLength", "maximum", "minItems", "minLength", "minimum", "oneOf",
  "pattern", "properties", "required", "title", "type"
]);

export function validateSchema(schema: JsonObject | undefined, value: unknown, direction: "input" | "output"): void {
  if (!schema) throw new SkillRuntimeError(`${direction}_schema_missing`, `skill ${direction} schema is missing`);
  const errors = jsonSchemaErrors(schema, value).slice(0, 6);
  if (errors.length === 0) return;
  throw new SkillRuntimeError(
    `${direction}_schema_invalid`,
    `skill ${direction} failed schema validation: ${errors.join("; ")}`
  );
}

export function jsonSchemaErrors(schema: JsonObject | boolean, value: unknown, path = "$", depth = 0): string[] {
  if (depth > 32) return [`${path}: schema nesting exceeds 32 levels`];
  if (schema === true) return [];
  if (schema === false) return [`${path}: value is not allowed`];
  const errors = schemaShapeErrors(schema, path);
  if (errors.length > 0) return errors;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    errors.push(`${path}: must match enum`);
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) errors.push(`${path}: must match const`);
  const types = Array.isArray(schema.type) ? stringList(schema.type) : [cleanString(schema.type)].filter(Boolean);
  if (types.length > 0 && !types.some((type) => jsonTypeMatches(type, value))) {
    errors.push(`${path}: must be ${types.join(" or ")}`);
    return errors;
  }
  if (typeof value === "string") validateStringSchema(schema, value, path, errors);
  if (typeof value === "number") validateNumberSchema(schema, value, path, errors);
  if (Array.isArray(value)) validateArraySchema(schema, value, path, depth, errors);
  if (isRecord(value)) validateObjectSchema(schema, value, path, depth, errors);
  validateComposedSchema(schema, value, path, depth, errors);
  return errors;
}

export function validateStringSchema(schema: JsonObject, value: string, path: string, errors: string[]): void {
  if (Number.isSafeInteger(schema.minLength) && value.length < Number(schema.minLength)) {
    errors.push(`${path}: length must be at least ${schema.minLength}`);
  }
  if (Number.isSafeInteger(schema.maxLength) && value.length > Number(schema.maxLength)) {
    errors.push(`${path}: length must be at most ${schema.maxLength}`);
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: must match pattern`);
    } catch {
      errors.push(`${path}: schema pattern is invalid`);
    }
  }
}

export function validateNumberSchema(schema: JsonObject, value: number, path: string, errors: string[]): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
}

export function validateArraySchema(
  schema: JsonObject,
  value: unknown[],
  path: string,
  depth: number,
  errors: string[]
): void {
  if (Number.isSafeInteger(schema.minItems) && value.length < Number(schema.minItems)) {
    errors.push(`${path}: must contain at least ${schema.minItems} items`);
  }
  if (Number.isSafeInteger(schema.maxItems) && value.length > Number(schema.maxItems)) {
    errors.push(`${path}: must contain at most ${schema.maxItems} items`);
  }
  if (schema.items === undefined) return;
  if (!isRecord(schema.items) && typeof schema.items !== "boolean") {
    errors.push(`${path}: schema items must be an object or boolean`);
    return;
  }
  value.forEach((item, index) => errors.push(...jsonSchemaErrors(schema.items as JsonObject | boolean, item, `${path}[${index}]`, depth + 1)));
}

export function validateObjectSchema(
  schema: JsonObject,
  value: JsonObject,
  path: string,
  depth: number,
  errors: string[]
): void {
  const required = stringList(schema.required);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key}: is required`);
  }
  const properties = recordValue(schema.properties);
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (!isRecord(child) && typeof child !== "boolean") {
      errors.push(`${path}.${key}: property schema must be an object or boolean`);
      continue;
    }
    errors.push(...jsonSchemaErrors(child as JsonObject | boolean, value[key], `${path}.${key}`, depth + 1));
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${path}.${key}: additional property is not allowed`);
    }
  } else if (isRecord(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...jsonSchemaErrors(schema.additionalProperties, value[key], `${path}.${key}`, depth + 1));
      }
    }
  }
}

export function validateComposedSchema(
  schema: JsonObject,
  value: unknown,
  path: string,
  depth: number,
  errors: string[]
): void {
  for (const [keyword, mode] of [["allOf", "all"], ["anyOf", "any"], ["oneOf", "one"]] as const) {
    const branches = arrayValue(schema[keyword]).filter((item) => isRecord(item) || typeof item === "boolean") as Array<JsonObject | boolean>;
    if (branches.length === 0) continue;
    const results = branches.map((branch) => jsonSchemaErrors(branch, value, path, depth + 1));
    if (mode === "all") results.forEach((result) => errors.push(...result));
    if (mode === "any" && results.every((result) => result.length > 0)) errors.push(`${path}: must match at least one ${keyword} branch`);
    if (mode === "one" && results.filter((result) => result.length === 0).length !== 1) errors.push(`${path}: must match exactly one oneOf branch`);
  }
}

export function jsonTypeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

export function schemaShapeErrors(schema: JsonObject, path: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) errors.push(`${path}: unsupported schema keyword ${key}`);
  }
  if (schema.type !== undefined && typeof schema.type !== "string" && !Array.isArray(schema.type)) {
    errors.push(`${path}: schema type must be a string or string array`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) errors.push(`${path}: schema enum must be an array`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
    errors.push(`${path}: schema required must be a string array`);
  }
  if (schema.properties !== undefined && !isRecord(schema.properties)) errors.push(`${path}: schema properties must be an object`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" && !isRecord(schema.additionalProperties)) {
    errors.push(`${path}: schema additionalProperties must be an object or boolean`);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (schema[keyword] !== undefined && !Array.isArray(schema[keyword])) errors.push(`${path}: schema ${keyword} must be an array`);
  }
  return errors;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}
